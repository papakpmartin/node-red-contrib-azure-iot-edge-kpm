'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-iot-package-'));

function readTarEntry(archivePath, entryPath) {
    const archive = zlib.gunzipSync(fs.readFileSync(archivePath));

    for (let offset = 0; offset + 512 <= archive.length;) {
        const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
        if (!name) {
            break;
        }

        const sizeText = archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim();
        const size = Number.parseInt(sizeText || '0', 8);
        const contentOffset = offset + 512;
        if (name === entryPath) {
            return archive.subarray(contentOffset, contentOffset + size).toString('utf8');
        }
        offset = contentOffset + Math.ceil(size / 512) * 512;
    }

    throw new Error(`${entryPath} is missing from ${path.basename(archivePath)}`);
}

try {
    const packResult = JSON.parse(childProcess.execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
        { cwd: root, encoding: 'utf8' }
    ));
    const files = new Set(packResult[0].files.map((file) => file.path));
    const archivePath = path.join(temporaryDirectory, packResult[0].filename);
    const packedManifest = JSON.parse(readTarEntry(archivePath, 'package/package.json'));
    const required = [
        'LICENSE.md',
        'CHANGELOG.md',
        'README.md',
        'azure-iot-edge-device-client.html',
        'azure-iot-edge-device-client.js',
        'azure-iot-edge-module-client.html',
        'azure-iot-edge-module-client.js',
        'docs/dependency-risk.md',
        'docs/modernization-plan.md',
        'examples/example.json',
        'package.json'
    ];

    for (const file of required) {
        assert.ok(files.has(file), `${file} is missing from the npm package`);
    }
    assert.ok(!files.has('azure-iot-edge-config.js'), 'obsolete config runtime was packaged');
    assert.ok(!Array.from(files).some((file) => file.startsWith('test/')), 'test files were packaged');
    assert.ok(!Array.from(files).some((file) => file.startsWith('todo/')), 'internal todo files were packaged');
    assert.ok(!Array.from(files).some((file) => file.endsWith('.tgz')), 'nested npm tarball was packaged');

    const nodeEntries = packedManifest['node-red'].nodes;
    const runtimePaths = Object.values(nodeEntries);
    assert.deepEqual(nodeEntries, {
        'Azure IoT Edge Module Client': 'azure-iot-edge-module-client.js',
        'Azure IoT Edge Device Client': 'azure-iot-edge-device-client.js'
    });
    assert.equal(
        new Set(runtimePaths).size,
        runtimePaths.length,
        'the packed manifest declares a Node-RED entry point more than once'
    );
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
