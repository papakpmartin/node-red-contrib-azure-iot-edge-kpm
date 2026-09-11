'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const helper = require('node-red-node-test-helper');
const azure = require('azure-iot-device');
const moduleNodes = require('../azure-iot-edge-module-client');

helper.init(require.resolve('node-red'));

class FakeTwin extends EventEmitter {
    constructor() {
        super();
        this.reported = [];
        this.properties = {
            desired: { existing: true },
            reported: {
                update: (patch, done) => {
                    this.reported.push(patch);
                    setImmediate(() => done());
                }
            }
        };
    }
}

class FakeModuleClient extends EventEmitter {
    constructor() {
        super();
        this.closed = false;
        this.methods = new Map();
        this.sent = [];
        this.twin = new FakeTwin();
        this.closeError = null;
    }

    open(done) {
        setImmediate(() => done());
    }

    close(done) {
        if (this.closeError) {
            setImmediate(() => done(this.closeError));
        } else {
            this.closed = true;
            setImmediate(() => done());
        }
    }

    getTwin(done) {
        setImmediate(() => done(null, this.twin));
    }

    sendOutputEvent(output, message, done) {
        this.sent.push({ output, message });
        setImmediate(() => done());
    }

    onMethod(name, handler) {
        if (this.methods.has(name)) {
            throw new Error('duplicate method');
        }
        this.methods.set(name, handler);
    }
}

function waitFor(predicate, message, timeout = 2000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        function poll() {
            if (predicate()) {
                resolve();
            } else if (Date.now() - started >= timeout) {
                reject(new Error(message));
            } else {
                setTimeout(poll, 5);
            }
        }
        poll();
    });
}

test('module nodes preserve released types and route messages through one config owner', async (t) => {
    const originalFromEnvironment = azure.ModuleClient.fromEnvironment;
    const originalConnectionString = process.env.EdgeHubConnectionString;
    process.env.EdgeHubConnectionString = 'HostName=test;DeviceId=device;ModuleId=module;SharedAccessKey=test';
    const client = new FakeModuleClient();
    azure.ModuleClient.fromEnvironment = async () => client;

    await new Promise((resolve, reject) => helper.startServer((error) => error ? reject(error) : resolve()));
    t.after(async () => {
        await helper.unload();
        await new Promise((resolve) => helper.stopServer(resolve));
        azure.ModuleClient.fromEnvironment = originalFromEnvironment;
        if (originalConnectionString === undefined) {
            delete process.env.EdgeHubConnectionString;
        } else {
            process.env.EdgeHubConnectionString = originalConnectionString;
        }
    });

    const flow = [
        { id: 'client', type: 'moduleclient' },
        { id: 'input', type: 'moduleinput', client: 'client', input: 'input1', wires: [['input-helper']] },
        { id: 'input-helper', type: 'helper' },
        { id: 'output', type: 'moduleoutput', client: 'client', output: 'output1', wires: [] },
        { id: 'twin', type: 'moduletwin', client: 'client', wires: [['twin-helper']] },
        { id: 'twin-helper', type: 'helper' },
        { id: 'method', type: 'modulemethod', client: 'client', method: 'setValue', wires: [['method-helper']] },
        { id: 'method-helper', type: 'helper' }
    ];

    await helper.load(moduleNodes, flow);
    await waitFor(() => client.listenerCount('inputMessage') === 1, 'module input dispatcher was not registered');
    await waitFor(() => client.methods.has('setValue'), 'module method was not registered');

    const inputMessage = new Promise((resolve) => helper.getNode('input-helper').once('input', resolve));
    client.emit('inputMessage', 'input1', { getBytes: () => Buffer.from('false') });
    const receivedInput = await inputMessage;
    assert.equal(receivedInput.payload, false);
    assert.equal(receivedInput.topic, 'input');
    assert.equal(receivedInput.input, 'input1');

    helper.getNode('output').receive({ payload: { value: 42 } });
    await waitFor(() => client.sent.length === 1, 'module output was not sent');
    assert.equal(client.sent[0].output, 'output1');
    assert.equal(client.sent[0].message.getData().toString(), '{"value":42}');
    assert.equal(client.sent[0].message.contentType, 'application/json');

    const twinNode = helper.getNode('twin');
    twinNode.receive({ payload: '{"reported":true}' });
    await waitFor(() => client.twin.reported.length === 1, 'reported properties were not updated');
    assert.deepEqual(client.twin.reported[0], { reported: true });

    const desiredMessage = new Promise((resolve) => helper.getNode('twin-helper').once('input', resolve));
    client.twin.emit('properties.desired', { changed: true });
    const desired = await desiredMessage;
    assert.equal(desired.topic, 'desired');
    assert.deepEqual(desired.payload, { changed: true });

    const methodMessage = new Promise((resolve) => helper.getNode('method-helper').once('input', resolve));
    let methodResponse;
    client.methods.get('setValue')(
        { methodName: 'setValue', payload: { requested: true } },
        { send: (status, payload, done) => { methodResponse = { status, payload }; setImmediate(() => done()); } }
    );
    const request = await methodMessage;
    assert.equal(request.method, 'setValue');
    assert.equal(typeof request.requestId, 'string');
    helper.getNode('method').receive({ requestId: request.requestId, status: 200, payload: { accepted: true } });
    await waitFor(() => Boolean(methodResponse), 'module method response was not sent');
    assert.deepEqual(methodResponse, { status: 200, payload: { accepted: true } });
});

test('module client delegates environment and workload authentication to the Azure factory', async (t) => {
    const originalFromEnvironment = azure.ModuleClient.fromEnvironment;
    const originalEdgeConnectionString = process.env.EdgeHubConnectionString;
    const originalIotHubConnectionString = process.env.IotHubConnectionString;
    delete process.env.EdgeHubConnectionString;
    delete process.env.IotHubConnectionString;

    const client = new FakeModuleClient();
    let factoryCalls = 0;
    azure.ModuleClient.fromEnvironment = (protocol, done) => {
        factoryCalls += 1;
        setImmediate(() => done(null, client));
    };
    delete require.cache[require.resolve('../azure-iot-edge-module-client')];
    const workloadNodes = require('../azure-iot-edge-module-client');

    await new Promise((resolve, reject) => helper.startServer((error) => error ? reject(error) : resolve()));
    t.after(async () => {
        await helper.unload();
        await new Promise((resolve) => helper.stopServer(resolve));
        azure.ModuleClient.fromEnvironment = originalFromEnvironment;
        if (originalEdgeConnectionString === undefined) {
            delete process.env.EdgeHubConnectionString;
        } else {
            process.env.EdgeHubConnectionString = originalEdgeConnectionString;
        }
        if (originalIotHubConnectionString === undefined) {
            delete process.env.IotHubConnectionString;
        } else {
            process.env.IotHubConnectionString = originalIotHubConnectionString;
        }
    });

    await helper.load(workloadNodes, [{ id: 'client', type: 'moduleclient' }]);
    await waitFor(() => factoryCalls === 1 && client.listenerCount('error') === 1, 'Azure environment factory was not used');
});

test('module recovery does not overlap a client whose close failed', async (t) => {
    const originalFromEnvironment = azure.ModuleClient.fromEnvironment;
    const originalConnectionString = process.env.EdgeHubConnectionString;
    process.env.EdgeHubConnectionString = 'HostName=test;DeviceId=device;ModuleId=module;SharedAccessKey=test';
    const clients = [];
    azure.ModuleClient.fromEnvironment = async () => {
        const client = new FakeModuleClient();
        client.closeError = new Error('close failed');
        clients.push(client);
        return client;
    };
    delete require.cache[require.resolve('../azure-iot-edge-module-client')];
    const isolatedModuleNodes = require('../azure-iot-edge-module-client');

    await new Promise((resolve, reject) => helper.startServer((error) => error ? reject(error) : resolve()));
    t.after(async () => {
        await helper.unload();
        await new Promise((resolve) => helper.stopServer(resolve));
        azure.ModuleClient.fromEnvironment = originalFromEnvironment;
        if (originalConnectionString === undefined) {
            delete process.env.EdgeHubConnectionString;
        } else {
            process.env.EdgeHubConnectionString = originalConnectionString;
        }
    });

    await helper.load(isolatedModuleNodes, [{ id: 'client', type: 'moduleclient' }]);
    await waitFor(() => clients.length === 1, 'module client was not created');
    clients[0].emit('disconnect', new Error('connection lost'));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(clients.length, 1, 'a replacement client overlapped the unresolved client');
    assert.ok(clients[0].listenerCount('error') > 0, 'unresolved client lost its error listener');
});
