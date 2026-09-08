'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const helper = require('node-red-node-test-helper');
const azure = require('azure-iot-device');
const deviceNodes = require('../azure-iot-edge-device-client');

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

class FakeDeviceClient extends EventEmitter {
    constructor() {
        super();
        this.twin = new FakeTwin();
        this.options = null;
        this.openedAfterOptions = false;
    }

    setOptions(options, done) {
        this.options = options;
        setImmediate(() => done());
    }

    open(done) {
        this.openedAfterOptions = Boolean(this.options);
        setImmediate(() => done());
    }

    close(done) {
        setImmediate(() => done());
    }

    getTwin(done) {
        setImmediate(() => done(null, this.twin));
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

test('device twin uses its selected X.509 config owner', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-iot-node-test-'));
    const certificatePath = path.join(directory, 'device.cert.pem');
    const keyPath = path.join(directory, 'device.key.pem');
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certificatePath,
        '-subj', '/CN=device-1', '-days', '2'
    ], { stdio: 'ignore' });

    const environment = {
        IOTEDGE_IOTHUBHOSTNAME: process.env.IOTEDGE_IOTHUBHOSTNAME,
        IOTEDGE_DEVICEID: process.env.IOTEDGE_DEVICEID,
        PATH_TO_CERTIFICATE_FILE: process.env.PATH_TO_CERTIFICATE_FILE,
        PATH_TO_KEY_FILE: process.env.PATH_TO_KEY_FILE
    };
    process.env.IOTEDGE_IOTHUBHOSTNAME = 'test.azure-devices.net';
    process.env.IOTEDGE_DEVICEID = 'device-1';
    process.env.PATH_TO_CERTIFICATE_FILE = certificatePath;
    process.env.PATH_TO_KEY_FILE = keyPath;

    const originalFromConnectionString = azure.Client.fromConnectionString;
    const client = new FakeDeviceClient();
    let connectionString;
    azure.Client.fromConnectionString = (value) => {
        connectionString = value;
        return client;
    };

    await new Promise((resolve, reject) => helper.startServer((error) => error ? reject(error) : resolve()));
    t.after(async () => {
        await helper.unload();
        await new Promise((resolve) => helper.stopServer(resolve));
        azure.Client.fromConnectionString = originalFromConnectionString;
        for (const [name, value] of Object.entries(environment)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const flow = [
        { id: 'client', type: 'device-client' },
        { id: 'twin', type: 'device-twin', client: 'client', wires: [['sink']] },
        { id: 'sink', type: 'helper' }
    ];
    await helper.load(deviceNodes, flow);
    await waitFor(() => client.openedAfterOptions, 'device client did not open after X.509 options');

    assert.equal(connectionString, 'HostName=test.azure-devices.net;DeviceId=device-1;x509=true');
    assert.match(client.options.cert, /BEGIN CERTIFICATE/);
    assert.match(client.options.key, /BEGIN PRIVATE KEY/);

    helper.getNode('twin').receive({ payload: '{"reported":true}' });
    await waitFor(() => client.twin.reported.length === 1, 'device reported properties were not updated');
    assert.deepEqual(client.twin.reported[0], { reported: true });

    const message = new Promise((resolve) => helper.getNode('sink').once('input', resolve));
    client.twin.emit('properties.desired', { changed: true });
    const desired = await message;
    assert.equal(desired.topic, 'desired');
    assert.deepEqual(desired.payload, { changed: true });
});
