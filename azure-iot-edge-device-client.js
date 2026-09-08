'use strict';

module.exports = function(RED) {
    const { Client } = require('azure-iot-device');
    const { Mqtt } = require('azure-iot-device-mqtt');
    const {
        X509Certificate,
        createPrivateKey,
        createPublicKey
    } = require('node:crypto');
    const fs = require('node:fs/promises');

    const RETRY_BASE_MS = 1000;
    const RETRY_MAX_MS = 30000;
    const CLOSE_TIMEOUT_MS = 10000;
    const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_PENDING_OPERATIONS = 100;

    const statuses = {
        connecting: { fill: 'yellow', shape: 'ring', text: 'Connecting' },
        connected: { fill: 'green', shape: 'dot', text: 'Connected' },
        recovering: { fill: 'yellow', shape: 'ring', text: 'Recovering' },
        reported: { fill: 'blue', shape: 'dot', text: 'Sending reported properties' },
        desired: { fill: 'yellow', shape: 'dot', text: 'Receiving desired properties' },
        disconnected: { fill: 'red', shape: 'ring', text: 'Disconnected' },
        closing: { fill: 'grey', shape: 'ring', text: 'Closing' },
        error: { fill: 'red', shape: 'ring', text: 'Error' }
    };

    function setStatus(node, status) {
        node.status(status);
    }

    function asError(error, message) {
        if (error instanceof Error) {
            return error;
        }
        return new Error(message || String(error));
    }

    function configurationError(message, cause) {
        const error = new Error(message, cause ? { cause } : undefined);
        error.code = 'DEVICE_CONFIGURATION_ERROR';
        return error;
    }

    function closedError() {
        const error = new Error('Device client is closed');
        error.code = 'DEVICE_CLIENT_CLOSED';
        return error;
    }

    function callbackOperation(invoke) {
        return new Promise((resolve, reject) => {
            let completed = false;

            function callback(error, result) {
                if (completed) {
                    return;
                }
                completed = true;
                if (error) {
                    reject(asError(error, 'Azure IoT operation failed'));
                } else {
                    resolve(result);
                }
            }

            try {
                invoke(callback);
            } catch (error) {
                callback(error);
            }
        });
    }

    function CreateDeviceClient(config) {
        const node = this;
        RED.nodes.createNode(node, config);

        let state = 'idle';
        let generation = 0;
        let activeGeneration = 0;
        let client = null;
        let pendingClient = null;
        let twin = null;
        let twinListeners = null;
        const retainedTwinErrors = [];
        let twinGeneration = 0;
        let startPromise = null;
        let twinPromise = null;
        let retryTimer = null;
        let retryWake = null;
        let closePromise = null;
        let closing = false;
        let expiryWarningIssued = false;
        let initialDesiredSeen = false;
        const twinChildren = new Set();
        const clientListeners = new WeakMap();
        const closingClients = new WeakMap();
        const activeClientCloses = new Set();
        const pendingOperations = new Set();
        let rejectShutdown;
        const shutdownPromise = new Promise((resolve, reject) => {
            rejectShutdown = reject;
        });

        // A handler is attached up front so closing an otherwise idle owner cannot
        // create an unhandled rejection before an operation races this promise.
        shutdownPromise.catch(() => {});

        node.connected = false;
        setStatus(node, statuses.connecting);

        function setOwnerState(nextState, status) {
            if (closing && nextState !== 'closing' && nextState !== 'closed') {
                return;
            }
            state = nextState;
            node.connected = nextState === 'ready';
            setStatus(node, status);
        }

        function setChildrenStatus(status) {
            for (const child of twinChildren) {
                if (child.active) {
                    setStatus(child.node, status);
                }
            }
        }

        function raceShutdown(operation) {
            return Promise.race([operation, shutdownPromise]);
        }

        async function loadX509Options() {
            const hostname = process.env.IOTEDGE_IOTHUBHOSTNAME;
            const deviceId = process.env.IOTEDGE_DEVICEID;
            const certificatePath = process.env.PATH_TO_CERTIFICATE_FILE;
            const keyPath = process.env.PATH_TO_KEY_FILE;

            if (typeof hostname !== 'string' || hostname.trim() === '') {
                throw configurationError('IOTEDGE_IOTHUBHOSTNAME is required');
            }
            if (typeof deviceId !== 'string' || deviceId.trim() === '') {
                throw configurationError('IOTEDGE_DEVICEID is required');
            }
            if (typeof certificatePath !== 'string' || certificatePath.trim() === '') {
                throw configurationError('PATH_TO_CERTIFICATE_FILE is required');
            }
            if (typeof keyPath !== 'string' || keyPath.trim() === '') {
                throw configurationError('PATH_TO_KEY_FILE is required');
            }

            let certificatePem;
            let keyPem;
            try {
                [certificatePem, keyPem] = await Promise.all([
                    fs.readFile(certificatePath, 'utf8'),
                    fs.readFile(keyPath, 'utf8')
                ]);
            } catch (error) {
                throw configurationError('Unable to read the X.509 certificate or private key file', error);
            }

            if (certificatePem.trim() === '') {
                throw configurationError('The X.509 certificate file is empty');
            }
            if (keyPem.trim() === '') {
                throw configurationError('The X.509 private key file is empty');
            }

            let certificate;
            let privateKey;
            try {
                certificate = new X509Certificate(certificatePem);
            } catch (error) {
                throw configurationError('The X.509 certificate is invalid', error);
            }
            try {
                privateKey = createPrivateKey(keyPem);
            } catch (error) {
                throw configurationError('The X.509 private key is invalid or unsupported', error);
            }

            let certificatePublicKey;
            let privatePublicKey;
            try {
                certificatePublicKey = certificate.publicKey.export({
                    type: 'spki',
                    format: 'der'
                });
                privatePublicKey = createPublicKey(privateKey).export({
                    type: 'spki',
                    format: 'der'
                });
            } catch (error) {
                throw configurationError('Unable to compare the X.509 certificate and private key', error);
            }
            if (!certificatePublicKey.equals(privatePublicKey)) {
                throw configurationError('The X.509 certificate and private key do not match');
            }

            const validFrom = Date.parse(certificate.validFrom);
            const validTo = Date.parse(certificate.validTo);
            const now = Date.now();
            if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
                throw configurationError('The X.509 certificate validity dates are invalid');
            }
            if (now < validFrom) {
                throw configurationError('The X.509 certificate is not yet valid');
            }
            if (now >= validTo) {
                throw configurationError('The X.509 certificate has expired');
            }
            if (!expiryWarningIssued && validTo - now <= EXPIRY_WARNING_MS) {
                expiryWarningIssued = true;
                node.warn(`The X.509 certificate expires within 30 days (${new Date(validTo).toISOString()})`);
            }

            return {
                connectionString: `HostName=${hostname};DeviceId=${deviceId};x509=true`,
                options: {
                    cert: certificatePem,
                    key: keyPem
                }
            };
        }

        function attachClientListeners(candidate, candidateGeneration) {
            const onError = (error) => {
                if (closing || candidateGeneration !== activeGeneration) {
                    return;
                }
                setStatus(node, statuses.error);
                setChildrenStatus(statuses.error);
                node.error(asError(error, 'Device client error'));
            };
            const onConnect = () => {
                if (closing || candidateGeneration !== activeGeneration || client !== candidate) {
                    return;
                }
                setOwnerState('ready', statuses.connected);
                setChildrenStatus(statuses.connected);
            };
            const onDisconnect = (result) => {
                if (closing || candidateGeneration !== activeGeneration || client !== candidate) {
                    return;
                }
                recover(candidate, candidateGeneration, result);
            };

            candidate.on('error', onError);
            candidate.on('connect', onConnect);
            candidate.on('disconnect', onDisconnect);
            clientListeners.set(candidate, { onError, onConnect, onDisconnect });
        }

        function detachTwin(keepErrorListener) {
            if (twin && twinListeners) {
                twin.removeListener('error', twinListeners.onError);
                twin.removeListener('properties.desired', twinListeners.onDesired);
                if (keepErrorListener) {
                    twin.on('error', twinListeners.onError);
                    retainedTwinErrors.push({ twin, onError: twinListeners.onError });
                }
            }
            twin = null;
            twinListeners = null;
            twinGeneration = 0;
            initialDesiredSeen = false;
        }

        function closeClient(candidate) {
            if (!candidate) {
                return Promise.resolve();
            }
            const existing = closingClients.get(candidate);
            if (existing) {
                return existing.bounded;
            }

            const listeners = clientListeners.get(candidate);
            if (listeners) {
                candidate.removeListener('connect', listeners.onConnect);
                candidate.removeListener('disconnect', listeners.onDisconnect);
            }

            const actual = callbackOperation((done) => candidate.close(done));
            actual.then(
                () => {
                    if (listeners) {
                        candidate.removeListener('error', listeners.onError);
                        clientListeners.delete(candidate);
                    }
                },
                () => {
                    if (listeners) {
                        candidate.removeListener('error', listeners.onError);
                        clientListeners.delete(candidate);
                    }
                }
            );

            let timeout;
            const bounded = Promise.race([
                actual,
                new Promise((resolve, reject) => {
                    timeout = setTimeout(() => reject(new Error('Timed out closing the device client')), CLOSE_TIMEOUT_MS);
                    if (typeof timeout.unref === 'function') {
                        timeout.unref();
                    }
                })
            ]).finally(() => clearTimeout(timeout));

            bounded.finally(() => {
                while (retainedTwinErrors.length > 0) {
                    const retained = retainedTwinErrors.pop();
                    retained.twin.removeListener('error', retained.onError);
                }
            }).catch(() => {});

            closingClients.set(candidate, { actual, bounded });
            activeClientCloses.add(bounded);
            bounded.then(
                () => activeClientCloses.delete(bounded),
                () => activeClientCloses.delete(bounded)
            );
            return bounded;
        }

        function waitForRetry(attempt) {
            const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(attempt, 10)));
            const delay = Math.floor((ceiling / 2) + (Math.random() * ceiling / 2));

            return raceShutdown(new Promise((resolve) => {
                retryWake = resolve;
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    retryWake = null;
                    resolve();
                }, delay);
                if (typeof retryTimer.unref === 'function') {
                    retryTimer.unref();
                }
            }));
        }

        async function connectLoop(initialAttempt = 0) {
            let attempt = initialAttempt;

            while (!closing) {
                const candidateGeneration = ++generation;
                activeGeneration = candidateGeneration;
                setOwnerState(attempt === 0 ? 'connecting' : 'recovering',
                    attempt === 0 ? statuses.connecting : statuses.recovering);
                setChildrenStatus(attempt === 0 ? statuses.connecting : statuses.recovering);

                let candidate;
                try {
                    const x509 = await raceShutdown(loadX509Options());
                    if (closing || candidateGeneration !== activeGeneration) {
                        throw closedError();
                    }

                    try {
                        candidate = Client.fromConnectionString(x509.connectionString, Mqtt);
                    } catch (error) {
                        throw configurationError('Unable to create the X.509 device client', error);
                    }
                    pendingClient = candidate;
                    attachClientListeners(candidate, candidateGeneration);

                    await raceShutdown(callbackOperation((done) => candidate.setOptions(x509.options, done)));
                    await raceShutdown(callbackOperation((done) => candidate.open(done)));

                    if (closing || candidateGeneration !== activeGeneration) {
                        throw closedError();
                    }
                    pendingClient = null;
                    client = candidate;
                    setOwnerState('ready', statuses.connected);
                    setChildrenStatus(statuses.connected);
                    return candidate;
                } catch (error) {
                    if (pendingClient === candidate) {
                        pendingClient = null;
                    }
                    if (candidate) {
                        try {
                            await closeClient(candidate);
                        } catch (closeError) {
                            if (!closing) {
                                node.warn(asError(closeError).message);
                            }
                        }
                    }
                    if (closing || error.code === 'DEVICE_CLIENT_CLOSED') {
                        throw closedError();
                    }

                    setOwnerState('error', statuses.error);
                    setChildrenStatus(statuses.error);
                    node.error(asError(error, 'Unable to start the device client'));
                    if (error.code === 'DEVICE_CONFIGURATION_ERROR') {
                        throw error;
                    }

                    attempt += 1;
                    setOwnerState('recovering', statuses.recovering);
                    setChildrenStatus(statuses.recovering);
                    await waitForRetry(attempt);
                }
            }

            throw closedError();
        }

        function ensureConnected() {
            if (closing) {
                return Promise.reject(closedError());
            }
            if (state === 'ready' && client) {
                return Promise.resolve(client);
            }
            if (startPromise) {
                return startPromise;
            }

            const currentStart = connectLoop();
            startPromise = currentStart;
            currentStart.then(
                () => {
                    if (startPromise === currentStart) {
                        startPromise = null;
                    }
                },
                () => {
                    if (startPromise === currentStart) {
                        startPromise = null;
                    }
                }
            );
            return currentStart;
        }

        function attachTwin(candidateTwin, candidateGeneration) {
            const onError = (error) => {
                if (closing || twin !== candidateTwin || twinGeneration !== candidateGeneration) {
                    return;
                }
                setChildrenStatus(statuses.error);
                node.error(asError(error, 'Device twin error'));
            };
            const onDesired = (delta) => {
                if (closing || twin !== candidateTwin || twinGeneration !== candidateGeneration) {
                    return;
                }
                initialDesiredSeen = true;
                for (const child of twinChildren) {
                    if (!child.active) {
                        continue;
                    }
                    setStatus(child.node, statuses.desired);
                    child.node.send({ payload: delta, topic: 'desired' });
                    setStatus(child.node, statuses.connected);
                }
            };

            candidateTwin.on('error', onError);
            candidateTwin.on('properties.desired', onDesired);
            twinListeners = { onError, onDesired };
        }

        async function loadTwin() {
            const readyClient = await ensureConnected();
            const candidateGeneration = activeGeneration;
            const candidateTwin = await raceShutdown(callbackOperation((done) => readyClient.getTwin(done)));

            if (closing || readyClient !== client || candidateGeneration !== activeGeneration) {
                const error = new Error('Device twin startup was superseded');
                error.code = 'DEVICE_TWIN_STALE';
                throw error;
            }

            twin = candidateTwin;
            twinGeneration = candidateGeneration;
            attachTwin(candidateTwin, candidateGeneration);
            setChildrenStatus(statuses.connected);
            return candidateTwin;
        }

        function ensureTwin() {
            if (closing) {
                return Promise.reject(closedError());
            }
            if (twin && twinGeneration === activeGeneration) {
                return Promise.resolve(twin);
            }
            if (twinPromise) {
                return twinPromise;
            }

            const currentTwin = loadTwin();
            twinPromise = currentTwin;
            currentTwin.then(
                () => {
                    if (twinPromise === currentTwin) {
                        twinPromise = null;
                    }
                },
                () => {
                    if (twinPromise === currentTwin) {
                        twinPromise = null;
                    }
                }
            );
            return currentTwin;
        }

        function startTwinForChildren() {
            if (closing || twinChildren.size === 0) {
                return;
            }
            ensureTwin().catch((error) => {
                if (closing) {
                    return;
                }
                if (error.code === 'DEVICE_TWIN_STALE') {
                    startTwinForChildren();
                    return;
                }
                setChildrenStatus(statuses.error);
                for (const child of twinChildren) {
                    if (child.active) {
                        child.node.error(asError(error, 'Unable to load the device twin'));
                    }
                }
            });
        }

        function recover(disconnectedClient, disconnectedGeneration, result) {
            if (closing || disconnectedClient !== client || disconnectedGeneration !== activeGeneration) {
                return;
            }

            generation += 1;
            activeGeneration = generation;
            client = null;
            twinPromise = null;
            detachTwin(true);
            setOwnerState('recovering', statuses.recovering);
            setChildrenStatus(statuses.recovering);

            const reason = result && result.transportObj instanceof Error
                ? `: ${result.transportObj.message}`
                : '';
            node.warn(`Device client disconnected${reason}`);

            const recovery = closeClient(disconnectedClient)
                .catch((error) => node.warn(asError(error).message))
                .then(() => connectLoop(1));
            startPromise = recovery;
            recovery.then(
                () => {
                    if (startPromise === recovery) {
                        startPromise = null;
                    }
                    startTwinForChildren();
                },
                (error) => {
                    if (startPromise === recovery) {
                        startPromise = null;
                    }
                    if (!closing && error.code !== 'DEVICE_CONFIGURATION_ERROR') {
                        node.error(asError(error, 'Unable to recover the device client'));
                    }
                }
            );
        }

        node.registerTwinChild = function(childNode) {
            if (closing) {
                throw closedError();
            }

            const child = {
                node: childNode,
                active: true
            };
            twinChildren.add(child);

            if (state === 'ready') {
                setStatus(childNode, statuses.connected);
            } else if (state === 'recovering') {
                setStatus(childNode, statuses.recovering);
            } else if (state === 'error') {
                setStatus(childNode, statuses.error);
            } else {
                setStatus(childNode, statuses.connecting);
            }

            if (twin && initialDesiredSeen) {
                setStatus(childNode, statuses.desired);
                childNode.send({ payload: twin.properties.desired, topic: 'desired' });
                setStatus(childNode, statuses.connected);
            }

            startTwinForChildren();
            return function unregisterTwinChild() {
                child.active = false;
                twinChildren.delete(child);
            };
        };

        node.updateReportedProperties = async function(patch) {
            if (pendingOperations.size >= MAX_PENDING_OPERATIONS) {
                throw new Error('Device client pending operation limit reached');
            }
            const operation = (async () => {
                const readyTwin = await ensureTwin();
                const operationGeneration = twinGeneration;
                await raceShutdown(callbackOperation((done) => readyTwin.properties.reported.update(patch, done)));
                if (closing || readyTwin !== twin || operationGeneration !== twinGeneration) {
                    throw closedError();
                }
            })();
            pendingOperations.add(operation);
            operation.finally(() => pendingOperations.delete(operation)).catch(() => {});
            return operation;
        };

        function closeOwner() {
            if (closePromise) {
                return closePromise;
            }

            closePromise = (async () => {
                closing = true;
                generation += 1;
                activeGeneration = generation;
                setOwnerState('closing', statuses.closing);
                setChildrenStatus(statuses.disconnected);
                rejectShutdown(closedError());

                if (retryTimer) {
                    clearTimeout(retryTimer);
                    retryTimer = null;
                }
                if (retryWake) {
                    const wake = retryWake;
                    retryWake = null;
                    wake();
                }

                twinPromise = null;
                detachTwin(true);
                for (const child of twinChildren) {
                    child.active = false;
                }
                twinChildren.clear();

                const clients = new Set([client, pendingClient].filter(Boolean));
                client = null;
                pendingClient = null;
                const closes = Array.from(clients, closeClient);
                closes.push(...activeClientCloses);
                closes.push(...pendingOperations);
                const results = await Promise.allSettled(closes);
                for (const result of results) {
                    if (result.status === 'rejected') {
                        node.warn(asError(result.reason).message);
                    }
                }

                state = 'closed';
                node.connected = false;
                setStatus(node, statuses.disconnected);
            })();

            return closePromise;
        }

        node.on('close', function(removed, done) {
            if (typeof removed === 'function') {
                done = removed;
            }
            closeOwner().then(
                () => done(),
                (error) => {
                    node.warn(asError(error).message);
                    done();
                }
            );
        });

        // Defer startup so all synchronously constructed children can register
        // before the first twin is obtained and emits its initial desired state.
        setImmediate(() => {
            if (closing) {
                return;
            }
            ensureConnected()
                .then(() => startTwinForChildren())
                .catch((error) => {
                    if (!closing && error.code !== 'DEVICE_CONFIGURATION_ERROR') {
                        node.error(asError(error, 'Unable to start the device client'));
                    }
                });
        });
    }

    function DeviceTwin(config) {
        const node = this;
        RED.nodes.createNode(node, config);
        const owner = RED.nodes.getNode(config.client);
        let unregister = null;
        let closed = false;

        setStatus(node, statuses.connecting);

        node.on('input', async function(msg, send, done) {
            if (!owner || typeof owner.updateReportedProperties !== 'function') {
                const error = new Error('Device client configuration is missing');
                setStatus(node, statuses.error);
                if (typeof done === 'function') {
                    done(error);
                } else {
                    node.error(error, msg);
                }
                return;
            }

            let patch;
            try {
                patch = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                if (patch === null || typeof patch !== 'object' || Buffer.isBuffer(patch)) {
                    throw new TypeError('Reported properties payload must be an object or JSON object text');
                }

                setStatus(node, statuses.reported);
                await owner.updateReportedProperties(patch);
                if (!closed) {
                    setStatus(node, statuses.connected);
                }
                if (typeof done === 'function') {
                    done();
                }
            } catch (error) {
                if (!closed) {
                    setStatus(node, statuses.error);
                }
                if (typeof done === 'function') {
                    done(asError(error));
                } else {
                    node.error(asError(error), msg);
                }
            }
        });

        node.on('close', function(removed, done) {
            if (typeof removed === 'function') {
                done = removed;
            }
            closed = true;
            if (unregister) {
                unregister();
                unregister = null;
            }
            setStatus(node, statuses.disconnected);
            done();
        });

        if (!owner || typeof owner.registerTwinChild !== 'function') {
            setStatus(node, statuses.error);
            node.error('Device client configuration is missing');
            return;
        }

        try {
            unregister = owner.registerTwinChild(node);
        } catch (error) {
            setStatus(node, statuses.error);
            node.error(asError(error));
        }
    }

    RED.nodes.registerType('device-client', CreateDeviceClient, {
        defaults: {
            module: { value: '' }
        }
    });

    RED.nodes.registerType('device-twin', DeviceTwin, {
        defaults: {
            client: { value: '', type: 'device-client', required: true },
            name: { value: 'Device Twin' }
        }
    });
};
