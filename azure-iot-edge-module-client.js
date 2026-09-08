module.exports = function (RED) {
    'use strict';

    const { randomUUID } = require('node:crypto');
    const {
        IotEdgeAuthenticationProvider,
        Message,
        ModuleClient
    } = require('azure-iot-device');
    const { Mqtt } = require('azure-iot-device-mqtt');

    const METHOD_TIMEOUT_MS = 25000;
    const MAX_PENDING_METHODS = 100;
    const MAX_RETAINED_METHODS = 100;
    const MAX_READY_WAITERS = 100;
    const MAX_PENDING_OPERATIONS = 100;
    const READY_WAIT_TIMEOUT_MS = 60000;
    const RETRY_MIN_MS = 1000;
    const RETRY_MAX_MS = 30000;
    const SDK_CLOSE_TIMEOUT_MS = 10000;
    const NODE_CLOSE_TIMEOUT_MS = 12000;
    let activeOwner = null;

    const statusEnum = {
        disconnected: { color: 'red', text: 'Disconnected' },
        connected: { color: 'green', text: 'Connected' },
        sent: { color: 'blue', text: 'Sending message' },
        received: { color: 'yellow', text: 'Receiving message' },
        reported: { color: 'blue', text: 'Sending reported properties' },
        desired: { color: 'yellow', text: 'Receiving desired properties' },
        method: { color: 'yellow', text: 'Receiving direct method' },
        response: { color: 'blue', text: 'Sending method response' },
        error: { color: 'grey', text: 'Error' }
    };

    function setStatus(node, status) {
        node.status({ fill: status.color, shape: 'dot', text: status.text });
    }

    function redact(value) {
        return String(value || 'Unknown error')
            .replace(/(SharedAccessKey|SharedAccessSignature|Password|sig|skn|se)=([^;&\s]+)/gi, '$1=[redacted]')
            .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]');
    }

    function operationError(prefix, error) {
        const detail = error && error.message ? error.message : error;
        return new Error(prefix + ': ' + redact(detail));
    }

    function callbackOperation(invoke) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const callback = (error, result) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };

            try {
                const result = invoke(callback);
                if (result && typeof result.then === 'function') {
                    result.then(
                        (value) => callback(null, value),
                        (error) => callback(error)
                    );
                }
            } catch (error) {
                callback(error);
            }
        });
    }

    function withTimeout(promise, timeout, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeout);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    function finishInput(node, msg, done, error) {
        if (typeof done === 'function') {
            done(error);
        } else if (error) {
            node.error(error, msg);
        }
    }

    function registerClose(node, cleanup) {
        let closePromise;
        node.on('close', function (removed, done) {
            if (typeof removed === 'function') {
                done = removed;
            }
            const finish = typeof done === 'function' ? done : function () {};
            if (!closePromise) {
                closePromise = Promise.resolve().then(cleanup);
            }
            closePromise.then(finish, (error) => {
                node.error(operationError('Close failed', error));
                finish();
            });
        });
    }

    function parseJsonPayload(payload) {
        return typeof payload === 'string' ? JSON.parse(payload) : payload;
    }

    function serializeJsonPayload(payload) {
        const value = parseJsonPayload(payload);
        const json = JSON.stringify(value);
        if (json === undefined) {
            throw new TypeError('Payload is not a JSON value');
        }
        return json;
    }

    function validateMethodPayload(payload) {
        if (payload === undefined || JSON.stringify(payload) === undefined) {
            throw new TypeError('msg.payload must be a JSON value');
        }
    }

    function ModuleClientOwner(node) {
        this.node = node;
        this.state = 'idle';
        this.client = null;
        this.connectingClient = null;
        this.connectPromise = null;
        this.retryTimer = null;
        this.retryAttempt = 0;
        this.generation = 0;
        this.activeGeneration = 0;
        this.readyWaiters = new Set();
        this.inputConsumers = new Set();
        this.twinConsumers = new Set();
        this.methodEntries = new Map();
        this.pendingMethods = new Map();
        this.pendingOperations = new Set();
        this.twin = null;
        this.twinPromise = null;
        this.twinRetryTimer = null;
        this.twinRetryAttempt = 0;
        this.twinListeners = null;
        this.retainedTwinErrors = [];
        this.clientListeners = new WeakMap();
        this.authenticationProviders = new WeakMap();
        this.closingClients = new WeakMap();
        this.closedClients = new WeakSet();
        this.closePromise = null;
        this.lastErrorText = '';
        this.lastErrorTime = 0;
    }

    ModuleClientOwner.prototype.start = function () {
        if (this.state === 'closing' || this.state === 'closed' || this.client || this.connectPromise || this.retryTimer) {
            return;
        }

        const generation = ++this.generation;
        this.state = this.retryAttempt === 0 ? 'connecting' : 'recovering';
        this._setConsumerStatus(statusEnum.disconnected);

        const attempt = this._connect(generation);
        this.connectPromise = attempt;
        attempt.catch((error) => {
            if (this.state !== 'closing' && this.state !== 'closed' && generation === this.generation) {
                this._reportError('Module client connection failed', error);
                this._scheduleRetry();
            }
        }).finally(() => {
            if (this.connectPromise === attempt) {
                this.connectPromise = null;
            }
        });
    };

    ModuleClientOwner.prototype._connect = async function (generation) {
        let client;
        try {
            client = await this._createClient(generation);
            if (!client || typeof client.open !== 'function') {
                throw new TypeError('ModuleClient.fromEnvironment did not return a client');
            }
            if (!this._isCurrentAttempt(generation)) {
                await this._closeSdkClient(client);
                return;
            }

            this.connectingClient = client;
            this._attachClientListeners(client, generation);
            await callbackOperation((done) => client.open(done));

            if (!this._isCurrentAttempt(generation)) {
                await this._closeSdkClient(client);
                this._detachClientListeners(client);
                return;
            }

            this.connectingClient = null;
            this.client = client;
            this.activeGeneration = generation;
            this.retryAttempt = 0;
            this.state = 'ready';
            this._attachInputDispatcher(client, generation);
            this._activateMethodDispatchers(client, generation);
            this._resolveReadyWaiters(client);
            this._setConsumerStatus(statusEnum.connected);
            if (this.twinConsumers.size > 0) {
                this._ensureTwin().catch((error) => this._reportError('Module twin initialization failed', error));
            }
        } catch (error) {
            this.connectingClient = null;
            if (client) {
                await this._closeSdkClient(client).catch(() => {});
                this._detachClientListeners(client);
            }
            throw error;
        }
    };

    ModuleClientOwner.prototype._createClient = async function (generation) {
        if (process.env.EdgeHubConnectionString || process.env.IotHubConnectionString) {
            return ModuleClient.fromEnvironment(Mqtt);
        }

        const environmentError = ModuleClient.validateEnvironment();
        if (environmentError) {
            throw environmentError;
        }
        const provider = new IotEdgeAuthenticationProvider({
            workloadUri: process.env.IOTEDGE_WORKLOADURI,
            deviceId: process.env.IOTEDGE_DEVICEID,
            moduleId: process.env.IOTEDGE_MODULEID,
            iothubHostName: process.env.IOTEDGE_IOTHUBHOSTNAME,
            authScheme: process.env.IOTEDGE_AUTHSCHEME,
            gatewayHostName: process.env.IOTEDGE_GATEWAYHOSTNAME,
            generationId: process.env.IOTEDGE_MODULEGENERATIONID
        });
        const providerError = (error) => {
            this._reportError('Module authentication renewal failed', error);
            const currentClient = this.client;
            if (currentClient && this.activeGeneration === generation) {
                this._recoverClient(currentClient, generation, error);
            }
        };
        provider.on('error', providerError);

        try {
            const ca = await callbackOperation((done) => provider.getTrustBundle(done));
            const client = ModuleClient.fromAuthenticationProvider(provider, Mqtt);
            this.authenticationProviders.set(client, { provider, providerError });
            await callbackOperation((done) => client.setOptions({ ca }, done));
            return client;
        } catch (error) {
            provider.removeListener('error', providerError);
            provider.stop();
            throw error;
        }
    };

    ModuleClientOwner.prototype._isCurrentAttempt = function (generation) {
        return this.state !== 'closing' && this.state !== 'closed' && generation === this.generation;
    };

    ModuleClientOwner.prototype._scheduleRetry = function () {
        if (this.state === 'closing' || this.state === 'closed' || this.retryTimer) {
            return;
        }
        this.state = 'recovering';
        const exponent = Math.min(this.retryAttempt++, 10);
        const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * (2 ** exponent));
        const delay = Math.floor(ceiling * (0.5 + (Math.random() * 0.5)));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.start();
        }, delay);
    };

    ModuleClientOwner.prototype._attachClientListeners = function (client, generation) {
        const listeners = {
            error: (error) => {
                this._reportError('Module client error', error);
                if (this.client === client && this.activeGeneration === generation) {
                    this._recoverClient(client, generation, error);
                }
            },
            connect: () => {
                if (this.client === client && this.activeGeneration === generation && this.state !== 'closing' && this.state !== 'closed') {
                    this.state = 'ready';
                    this._setConsumerStatus(statusEnum.connected);
                }
            },
            disconnect: (result) => this._recoverClient(client, generation, result),
            input: null
        };
        client.on('error', listeners.error);
        client.on('connect', listeners.connect);
        client.on('disconnect', listeners.disconnect);
        this.clientListeners.set(client, listeners);
    };

    ModuleClientOwner.prototype._attachInputDispatcher = function (client, generation) {
        const listeners = this.clientListeners.get(client);
        if (!listeners || listeners.input) {
            return;
        }
        listeners.input = (inputName, message) => {
            if (this.client === client && this.activeGeneration === generation && this.state === 'ready') {
                this._dispatchInput(inputName, message);
            }
        };
        client.on('inputMessage', listeners.input);
    };

    ModuleClientOwner.prototype._detachClientListeners = function (client, keepErrorListener) {
        const listeners = this.clientListeners.get(client);
        if (!listeners) {
            return;
        }
        if (!keepErrorListener) {
            client.removeListener('error', listeners.error);
        }
        client.removeListener('connect', listeners.connect);
        client.removeListener('disconnect', listeners.disconnect);
        if (listeners.input) {
            client.removeListener('inputMessage', listeners.input);
        }
        if (!keepErrorListener) {
            this.clientListeners.delete(client);
        } else {
        }
    };

    ModuleClientOwner.prototype._recoverClient = function (client, generation, result) {
        if (this.client !== client || this.activeGeneration !== generation || this.state === 'closing' || this.state === 'closed') {
            return;
        }

        this.client = null;
        this.activeGeneration = 0;
        this.state = 'recovering';
        this._detachTwin(true);
        this._setConsumerStatus(statusEnum.disconnected);
        const pendingResponses = this._terminatePending(null, 503, { error: 'Module client unavailable' });

        Promise.allSettled(pendingResponses.concat(this._closeSdkClient(client)))
            .finally(() => {
                if (this.state !== 'closing' && this.state !== 'closed') {
                    if (result) {
                        this._reportError('Module client disconnected', result);
                    }
                    this._scheduleRetry();
                }
            });
    };

    ModuleClientOwner.prototype._reportError = function (prefix, error) {
        const safe = operationError(prefix, error);
        const now = Date.now();
        if (safe.message !== this.lastErrorText || now - this.lastErrorTime >= RETRY_MAX_MS) {
            this.lastErrorText = safe.message;
            this.lastErrorTime = now;
            this.node.error(safe);
        }
        setStatus(this.node, statusEnum.error);
    };

    ModuleClientOwner.prototype._setConsumerStatus = function (status) {
        setStatus(this.node, status);
        for (const consumer of this.inputConsumers) {
            if (!consumer.closed) {
                setStatus(consumer.node, status);
            }
        }
        for (const consumer of this.twinConsumers) {
            if (!consumer.closed) {
                setStatus(consumer.node, status);
            }
        }
        for (const entry of this.methodEntries.values()) {
            if (entry.child && !entry.child.closed) {
                setStatus(entry.child.node, status);
            }
        }
    };

    ModuleClientOwner.prototype.waitForClient = function () {
        if (this.client && this.state === 'ready') {
            return Promise.resolve(this.client);
        }
        if (this.state === 'closing' || this.state === 'closed') {
            return Promise.reject(new Error('Module client is closed'));
        }
        if (this.readyWaiters.size >= MAX_READY_WAITERS) {
            return Promise.reject(new Error('Module client pending operation limit reached'));
        }

        const promise = new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                if (this.readyWaiters.delete(waiter)) {
                    reject(new Error('Module client did not become ready within 60 seconds'));
                }
            }, READY_WAIT_TIMEOUT_MS);
            this.readyWaiters.add(waiter);
        });
        this.start();
        return promise;
    };

    ModuleClientOwner.prototype._resolveReadyWaiters = function (client) {
        const waiters = Array.from(this.readyWaiters);
        this.readyWaiters.clear();
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(client);
        }
    };

    ModuleClientOwner.prototype._rejectReadyWaiters = function (error) {
        const waiters = Array.from(this.readyWaiters);
        this.readyWaiters.clear();
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    };

    ModuleClientOwner.prototype.registerInput = function (consumer) {
        this.inputConsumers.add(consumer);
        if (this.state === 'ready') {
            setStatus(consumer.node, statusEnum.connected);
        }
        this.start();
    };

    ModuleClientOwner.prototype.unregisterInput = function (consumer) {
        consumer.closed = true;
        this.inputConsumers.delete(consumer);
    };

    ModuleClientOwner.prototype._dispatchInput = function (inputName, message) {
        const consumers = Array.from(this.inputConsumers).filter((consumer) => !consumer.closed && consumer.input === inputName);
        if (consumers.length === 0) {
            return;
        }

        let payload;
        try {
            payload = JSON.parse(message.getBytes().toString('utf8'));
        } catch (error) {
            const safe = operationError('Invalid JSON on module input ' + inputName, error);
            for (const consumer of consumers) {
                setStatus(consumer.node, statusEnum.error);
                consumer.node.error(safe);
            }
            return;
        }

        for (const consumer of consumers) {
            setStatus(consumer.node, statusEnum.received);
            try {
                consumer.node.send({ payload, topic: 'input', input: inputName });
            } catch (error) {
                setStatus(consumer.node, statusEnum.error);
                consumer.node.error(operationError('Could not emit module input message', error));
                continue;
            }
            if (!consumer.closed) {
                setStatus(consumer.node, statusEnum.connected);
            }
        }
    };

    ModuleClientOwner.prototype.registerTwin = function (consumer) {
        this.twinConsumers.add(consumer);
        this.start();
        if (this.state === 'ready') {
            this._ensureTwin().then((twin) => {
                setImmediate(() => this._sendInitialDesired(consumer, twin));
            }).catch((error) => this._reportError('Module twin initialization failed', error));
        }
    };

    ModuleClientOwner.prototype.unregisterTwin = function (consumer) {
        consumer.closed = true;
        this.twinConsumers.delete(consumer);
    };

    ModuleClientOwner.prototype.getTwin = async function () {
        await this.waitForClient();
        return this._ensureTwin();
    };

    ModuleClientOwner.prototype._ensureTwin = function () {
        if (this.twin) {
            return Promise.resolve(this.twin);
        }
        if (this.twinPromise) {
            return this.twinPromise;
        }
        if (!this.client || this.state !== 'ready') {
            return this.waitForClient().then(() => this._ensureTwin());
        }

        const client = this.client;
        const generation = this.activeGeneration;
        const promise = callbackOperation((done) => client.getTwin(done)).then((twin) => {
            if (!twin || this.client !== client || this.activeGeneration !== generation || this.state !== 'ready') {
                throw new Error('Module twin became stale during initialization');
            }
            this.twin = twin;
            this.twinRetryAttempt = 0;
            this._attachTwinListeners(twin, generation);
            for (const consumer of this.twinConsumers) {
                if (!consumer.closed) {
                    setStatus(consumer.node, statusEnum.connected);
                }
            }
            return twin;
        }).catch((error) => {
            if (this.state !== 'closing' && this.state !== 'closed' && this.client === client) {
                this._scheduleTwinRetry();
            }
            throw error;
        }).finally(() => {
            if (this.twinPromise === promise) {
                this.twinPromise = null;
            }
        });
        this.twinPromise = promise;
        return promise;
    };

    ModuleClientOwner.prototype._attachTwinListeners = function (twin, generation) {
        const desired = (delta) => {
            if (this.twin !== twin || this.activeGeneration !== generation || this.state !== 'ready') {
                return;
            }
            for (const consumer of this.twinConsumers) {
                if (consumer.closed) {
                    continue;
                }
                const payload = consumer.initialized ? delta : twin.properties.desired;
                consumer.initialized = true;
                setStatus(consumer.node, statusEnum.desired);
                try {
                    consumer.node.send({ payload, topic: 'desired' });
                } catch (error) {
                    setStatus(consumer.node, statusEnum.error);
                    consumer.node.error(operationError('Could not emit desired properties', error));
                    continue;
                }
                if (!consumer.closed) {
                    setStatus(consumer.node, statusEnum.connected);
                }
            }
        };
        const error = (twinError) => {
            this._reportError('Module twin error', twinError);
            if (this.client && this.activeGeneration === generation) {
                this._recoverClient(this.client, generation, twinError);
            }
        };
        this.twinListeners = { twin, desired, error };
        twin.on('error', error);
        twin.on('properties.desired', desired);

        setImmediate(() => {
            if (this.twin !== twin || this.activeGeneration !== generation || this.state !== 'ready') {
                return;
            }
            for (const consumer of this.twinConsumers) {
                this._sendInitialDesired(consumer, twin);
            }
        });
    };

    ModuleClientOwner.prototype._sendInitialDesired = function (consumer, twin) {
        if (consumer.closed || consumer.initialized || this.twin !== twin || this.state !== 'ready') {
            return;
        }
        consumer.initialized = true;
        setStatus(consumer.node, statusEnum.desired);
        try {
            consumer.node.send({ payload: twin.properties.desired, topic: 'desired' });
            if (!consumer.closed) {
                setStatus(consumer.node, statusEnum.connected);
            }
        } catch (error) {
            setStatus(consumer.node, statusEnum.error);
            consumer.node.error(operationError('Could not emit desired properties', error));
        }
    };

    ModuleClientOwner.prototype._scheduleTwinRetry = function () {
        if (this.twinRetryTimer || this.state === 'closing' || this.state === 'closed' || this.twinConsumers.size === 0) {
            return;
        }
        const exponent = Math.min(this.twinRetryAttempt++, 10);
        const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * (2 ** exponent));
        const delay = Math.floor(ceiling * (0.5 + (Math.random() * 0.5)));
        this.twinRetryTimer = setTimeout(() => {
            this.twinRetryTimer = null;
            this._ensureTwin().catch((error) => this._reportError('Module twin initialization failed', error));
        }, delay);
    };

    ModuleClientOwner.prototype._detachTwin = function (keepErrorListener) {
        if (this.twinRetryTimer) {
            clearTimeout(this.twinRetryTimer);
            this.twinRetryTimer = null;
        }
        if (this.twinListeners) {
            this.twinListeners.twin.removeListener('properties.desired', this.twinListeners.desired);
            if (!keepErrorListener) {
                this.twinListeners.twin.removeListener('error', this.twinListeners.error);
            } else {
                this.retainedTwinErrors.push(this.twinListeners);
            }
            this.twinListeners = null;
        }
        this.twin = null;
        this.twinPromise = null;
        for (const consumer of this.twinConsumers) {
            consumer.initialized = false;
        }
    };

    ModuleClientOwner.prototype._clearRetainedTwinErrors = function () {
        for (const listeners of this.retainedTwinErrors) {
            listeners.twin.removeListener('error', listeners.error);
        }
        this.retainedTwinErrors = [];
    };

    ModuleClientOwner.prototype.updateReported = async function (payload) {
        const patch = parseJsonPayload(payload);
        return this._trackOperation(async () => {
            const twin = await this.getTwin();
            await callbackOperation((done) => twin.properties.reported.update(patch, done));
        });
    };

    ModuleClientOwner.prototype.sendOutput = async function (output, payload) {
        const json = serializeJsonPayload(payload);
        const message = new Message(json);
        message.contentEncoding = 'utf-8';
        message.contentType = 'application/json';
        return this._trackOperation(async () => {
            const client = await this.waitForClient();
            await callbackOperation((done) => client.sendOutputEvent(output || 'output', message, done));
        });
    };

    ModuleClientOwner.prototype._trackOperation = function (operation) {
        if (this.pendingOperations.size >= MAX_PENDING_OPERATIONS) {
            return Promise.reject(new Error('Module client pending operation limit reached'));
        }
        if (this.state === 'closing' || this.state === 'closed') {
            return Promise.reject(new Error('Module client is closed'));
        }
        const pending = Promise.resolve().then(operation);
        this.pendingOperations.add(pending);
        pending.finally(() => this.pendingOperations.delete(pending)).catch(() => {});
        return pending;
    };

    ModuleClientOwner.prototype.registerMethod = function (consumer) {
        const method = consumer.method;
        if (typeof method !== 'string' || method.length === 0) {
            setStatus(consumer.node, statusEnum.error);
            consumer.node.error(new Error('Module method name is required'));
            return false;
        }

        let entry = this.methodEntries.get(method);
        if (entry && entry.child && !entry.child.closed) {
            setStatus(consumer.node, statusEnum.error);
            consumer.node.error(new Error('Only one active Module Method node is allowed for method ' + method));
            return false;
        }
        if (!entry && this.methodEntries.size >= MAX_RETAINED_METHODS) {
            setStatus(consumer.node, statusEnum.error);
            const error = new Error('Module method registration limit reached; redeploy the Module Client configuration to clear retained names');
            consumer.node.error(error);
            this.node.warn(error.message);
            return false;
        }

        if (!entry) {
            entry = { method, child: null, registeredGeneration: 0 };
            this.methodEntries.set(method, entry);
        }
        entry.child = consumer;
        consumer.registered = true;
        if (this.client && this.state === 'ready') {
            this._activateMethodDispatcher(entry, this.client, this.activeGeneration);
            setStatus(consumer.node, statusEnum.connected);
        }
        this.start();
        return true;
    };

    ModuleClientOwner.prototype.unregisterMethod = function (consumer) {
        consumer.closed = true;
        const entry = this.methodEntries.get(consumer.method);
        if (entry && entry.child === consumer) {
            entry.child = null;
        }
        return Promise.allSettled(this._terminatePending(consumer, 503, { error: 'Method handler unavailable' }));
    };

    ModuleClientOwner.prototype._activateMethodDispatchers = function (client, generation) {
        for (const entry of this.methodEntries.values()) {
            this._activateMethodDispatcher(entry, client, generation);
        }
    };

    ModuleClientOwner.prototype._activateMethodDispatcher = function (entry, client, generation) {
        if (entry.registeredGeneration === generation) {
            return;
        }
        try {
            const dispatcher = (request, response) => this._dispatchMethod(entry.method, client, generation, request, response);
            client.onMethod(entry.method, dispatcher);
            entry.registeredGeneration = generation;
        } catch (error) {
            entry.registeredGeneration = 0;
            const child = entry.child;
            if (child && !child.closed) {
                setStatus(child.node, statusEnum.error);
                child.node.error(operationError('Could not register module method ' + entry.method, error));
            } else {
                this._reportError('Could not register module method ' + entry.method, error);
            }
        }
    };

    ModuleClientOwner.prototype._dispatchMethod = function (method, client, generation, request, response) {
        const entry = this.methodEntries.get(method);
        const child = entry && entry.child;
        if (this.client !== client || this.activeGeneration !== generation || this.state !== 'ready' || !child || child.closed) {
            this._sendMethodResponse(response, 503, { error: 'Method handler unavailable' })
                .catch((error) => this.node.error(operationError('Could not send module method response', error)));
            return;
        }
        if (this.pendingMethods.size >= MAX_PENDING_METHODS) {
            child.node.warn('Module method pending request limit reached');
            this._sendMethodResponse(response, 503, { error: 'Method handler unavailable' })
                .catch((error) => child.node.error(operationError('Could not send module method response', error)));
            return;
        }

        const requestId = generation + ':' + randomUUID();
        const pending = {
            requestId,
            method,
            child,
            response,
            timer: null
        };
        pending.timer = setTimeout(() => {
            if (this.pendingMethods.get(requestId) !== pending) {
                return;
            }
            this.pendingMethods.delete(requestId);
            this._sendMethodResponse(response, 504, { error: 'Method response timed out' })
                .catch((error) => child.node.error(operationError('Could not send module method response', error)));
        }, METHOD_TIMEOUT_MS);
        this.pendingMethods.set(requestId, pending);

        setStatus(child.node, statusEnum.method);
        try {
            child.node.send({
                payload: request.payload,
                topic: 'method',
                method: request.methodName || method,
                requestId
            });
        } catch (error) {
            this.pendingMethods.delete(requestId);
            clearTimeout(pending.timer);
            child.node.error(operationError('Could not emit module method request', error));
            this._sendMethodResponse(response, 503, { error: 'Method handler unavailable' })
                .catch((sendError) => child.node.error(operationError('Could not send module method response', sendError)));
        }
    };

    ModuleClientOwner.prototype.respondToMethod = async function (consumer, msg) {
        if (!Object.prototype.hasOwnProperty.call(msg, 'requestId') || typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
            throw new TypeError('msg.requestId is required');
        }
        if (!Object.prototype.hasOwnProperty.call(msg, 'status') || !Number.isInteger(msg.status) || msg.status < 100 || msg.status > 599) {
            throw new TypeError('msg.status must be an integer from 100 through 599');
        }
        if (!Object.prototype.hasOwnProperty.call(msg, 'payload')) {
            throw new TypeError('msg.payload is required');
        }
        validateMethodPayload(msg.payload);

        const pending = this.pendingMethods.get(msg.requestId);
        if (!pending) {
            throw new Error('Unknown, expired, or already completed module method requestId');
        }
        if (pending.child !== consumer || consumer.closed) {
            throw new Error('Module method requestId belongs to a different node instance');
        }

        this.pendingMethods.delete(msg.requestId);
        clearTimeout(pending.timer);
        setStatus(consumer.node, statusEnum.response);
        await this._sendMethodResponse(pending.response, msg.status, msg.payload);
        if (!consumer.closed && this.state === 'ready') {
            setStatus(consumer.node, statusEnum.connected);
        }
    };

    ModuleClientOwner.prototype._sendMethodResponse = function (response, status, payload) {
        return callbackOperation((done) => response.send(status, payload, done));
    };

    ModuleClientOwner.prototype._terminatePending = function (consumer, status, payload) {
        const responses = [];
        for (const [requestId, pending] of this.pendingMethods) {
            if (consumer && pending.child !== consumer) {
                continue;
            }
            this.pendingMethods.delete(requestId);
            clearTimeout(pending.timer);
            responses.push(this._sendMethodResponse(pending.response, status, payload).catch((error) => {
                pending.child.node.error(operationError('Could not send module method response', error));
            }));
        }
        return responses;
    };

    ModuleClientOwner.prototype._closeSdkClient = function (client) {
        if (!client || this.closedClients.has(client)) {
            return Promise.resolve();
        }
        const existing = this.closingClients.get(client);
        if (existing) {
            return existing;
        }

        const closing = withTimeout(
            callbackOperation((done) => client.close(done)),
            SDK_CLOSE_TIMEOUT_MS,
            'Azure Module Client close timed out'
        ).finally(() => {
            const authentication = this.authenticationProviders.get(client);
            if (authentication) {
                authentication.provider.removeListener('error', authentication.providerError);
                authentication.provider.stop();
                this.authenticationProviders.delete(client);
            }
            this._detachClientListeners(client);
            this._clearRetainedTwinErrors();
            this.closingClients.delete(client);
        });
        closing.then(() => this.closedClients.add(client), () => {});
        this.closingClients.set(client, closing);
        return closing;
    };

    ModuleClientOwner.prototype.close = function () {
        if (this.closePromise) {
            return this.closePromise;
        }

        this.state = 'closing';
        ++this.generation;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.twinRetryTimer) {
            clearTimeout(this.twinRetryTimer);
            this.twinRetryTimer = null;
        }
        this._rejectReadyWaiters(new Error('Module client is closing'));
        this._setConsumerStatus(statusEnum.disconnected);
        this._detachTwin(true);

        const clients = new Set([this.client, this.connectingClient].filter(Boolean));
        this.client = null;
        this.connectingClient = null;
        this.activeGeneration = 0;
        const work = this._terminatePending(null, 503, { error: 'Module client unavailable' });
        work.push(...this.pendingOperations);
        if (this.connectPromise) {
            work.push(this.connectPromise);
        }
        for (const client of clients) {
            work.push(this._closeSdkClient(client).finally(() => this._detachClientListeners(client)));
        }

        this.closePromise = withTimeout(
            Promise.allSettled(work),
            NODE_CLOSE_TIMEOUT_MS,
            'Module client shutdown timed out'
        ).then((results) => {
            const failure = results.find((result) => result.status === 'rejected');
            if (failure) {
                throw failure.reason;
            }
        }).finally(() => {
            for (const client of clients) {
                this._detachClientListeners(client);
            }
            this.state = 'closed';
            if (activeOwner === this) {
                activeOwner = null;
            }
        });
        return this.closePromise;
    };

    function resolveOwner(node, config) {
        const configNode = RED.nodes.getNode(config.client);
        if (!configNode || !configNode._moduleClientOwner) {
            const error = new Error('A valid moduleclient configuration is required');
            setStatus(node, statusEnum.error);
            node.error(error);
            return null;
        }
        return configNode._moduleClientOwner;
    }

    function createModuleClient(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);
        const owner = new ModuleClientOwner(node);
        node._moduleClientOwner = owner;
        registerClose(node, () => owner.close());
        if (activeOwner) {
            owner.state = 'closed';
            node.error(new Error('Only one moduleclient configuration can be active in an IoT Edge module'));
            setStatus(node, statusEnum.error);
        } else {
            activeOwner = owner;
            owner.start();
        }
    }

    function createModuleTwin(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);

        const owner = resolveOwner(node, config);
        const consumer = { node, closed: false, initialized: false };
        registerClose(node, () => {
            setStatus(node, statusEnum.disconnected);
            if (owner) {
                owner.unregisterTwin(consumer);
            }
        });

        node.on('input', function (msg, send, done) {
            if (!owner || consumer.closed) {
                finishInput(node, msg, done, new Error('Module client is unavailable'));
                return;
            }
            setStatus(node, statusEnum.reported);
            owner.updateReported(msg.payload).then(() => {
                if (!consumer.closed) {
                    setStatus(node, statusEnum.connected);
                }
                finishInput(node, msg, done);
            }, (error) => {
                setStatus(node, statusEnum.error);
                finishInput(node, msg, done, operationError('Could not update module reported properties', error));
            });
        });

        if (owner) {
            owner.registerTwin(consumer);
        }
    }

    function createModuleInput(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);

        const owner = resolveOwner(node, config);
        const consumer = { node, input: config.input, closed: false };
        registerClose(node, () => {
            setStatus(node, statusEnum.disconnected);
            if (owner) {
                owner.unregisterInput(consumer);
            }
        });
        if (owner) {
            owner.registerInput(consumer);
        }
    }

    function createModuleOutput(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);

        const owner = resolveOwner(node, config);
        const consumer = { node, closed: false };
        registerClose(node, () => {
            consumer.closed = true;
            setStatus(node, statusEnum.disconnected);
        });

        node.on('input', function (msg, send, done) {
            if (!owner || consumer.closed) {
                finishInput(node, msg, done, new Error('Module client is unavailable'));
                return;
            }
            setStatus(node, statusEnum.sent);
            owner.sendOutput(config.output, msg.payload).then(() => {
                if (!consumer.closed) {
                    setStatus(node, statusEnum.connected);
                }
                finishInput(node, msg, done);
            }, (error) => {
                setStatus(node, statusEnum.error);
                finishInput(node, msg, done, operationError('Could not send module output', error));
            });
        });
    }

    function createModuleMethod(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);

        const owner = resolveOwner(node, config);
        const consumer = { node, method: config.method, closed: false, registered: false };
        registerClose(node, () => {
            setStatus(node, statusEnum.disconnected);
            if (owner && consumer.registered) {
                return withTimeout(
                    owner.unregisterMethod(consumer),
                    3000,
                    'Module method cleanup timed out'
                );
            }
            consumer.closed = true;
        });

        node.on('input', function (msg, send, done) {
            if (!owner || !consumer.registered || consumer.closed) {
                finishInput(node, msg, done, new Error('Module method handler is unavailable'));
                return;
            }
            owner.respondToMethod(consumer, msg).then(
                () => finishInput(node, msg, done),
                (error) => {
                    setStatus(node, statusEnum.error);
                    finishInput(node, msg, done, operationError('Could not process module method response', error));
                }
            );
        });

        if (owner) {
            owner.registerMethod(consumer);
        }
    }

    RED.nodes.registerType('moduleclient', createModuleClient);
    RED.nodes.registerType('moduletwin', createModuleTwin);
    RED.nodes.registerType('moduleinput', createModuleInput);
    RED.nodes.registerType('moduleoutput', createModuleOutput);
    RED.nodes.registerType('modulemethod', createModuleMethod);
};
