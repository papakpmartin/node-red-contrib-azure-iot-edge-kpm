'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-iot-package-'));

try {
    const packResult = JSON.parse(childProcess.execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
        { cwd: root, encoding: 'utf8' }
    ));
    const files = new Set(packResult[0].files.map((file) => file.path));
    const required = [
        'LICENSE.md',
        'README.md',
        'azure-iot-edge-device-client.html',
        'azure-iot-edge-device-client.js',
        'azure-iot-edge-module-client.html',
        'azure-iot-edge-module-client.js',
        'examples/example.json',
        'package.json'
    ];

    for (const file of required) {
        assert.ok(files.has(file), `${file} is missing from the npm package`);
    }
    assert.ok(!files.has('azure-iot-edge-config.js'), 'obsolete config runtime was packaged');
    assert.ok(!Array.from(files).some((file) => file.startsWith('test/')), 'test files were packaged');
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
