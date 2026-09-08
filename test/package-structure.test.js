'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

test('declares the initial runtime support scope', () => {
    assert.equal(manifest.engines.node, '>=22 <23');
    assert.equal(manifest['node-red'].version, '>=4 <5');
    assert.equal(manifest.devDependencies['node-red'], '4.1.14');
});

test('ships a matching editor file for every runtime entry', () => {
    for (const relativeRuntimePath of Object.values(manifest['node-red'].nodes)) {
        const runtimePath = path.join(root, relativeRuntimePath);
        const editorPath = runtimePath.replace(/\.js$/, '.html');

        assert.ok(fs.existsSync(runtimePath), `${relativeRuntimePath} is missing`);
        assert.ok(
            fs.existsSync(editorPath),
            `${path.relative(root, editorPath)} is missing`
        );
    }
});

test('keeps the released package identity during modernization', () => {
    assert.equal(manifest.name, 'node-red-contrib-azure-iot-edge-kpm');
    assert.equal(manifest.license, 'MIT');
});
