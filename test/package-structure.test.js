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

test('runtime, editor, and example use the released node types', () => {
    const runtimeTypes = new Set();
    const editorTypes = new Set();
    for (const relativeRuntimePath of Object.values(manifest['node-red'].nodes)) {
        const runtimePath = path.join(root, relativeRuntimePath);
        const editorPath = runtimePath.replace(/\.js$/, '.html');
        const runtime = fs.readFileSync(runtimePath, 'utf8');
        const editor = fs.readFileSync(editorPath, 'utf8');

        for (const match of runtime.matchAll(/RED\.nodes\.registerType\(['"]([^'"]+)/g)) {
            runtimeTypes.add(match[1]);
        }
        for (const match of editor.matchAll(/RED\.nodes\.registerType\(['"]([^'"]+)/g)) {
            editorTypes.add(match[1]);
        }
    }

    const expected = [
        'device-client',
        'device-twin',
        'moduleclient',
        'moduleinput',
        'modulemethod',
        'moduleoutput',
        'moduletwin'
    ];
    assert.deepEqual(Array.from(runtimeTypes).sort(), expected);
    assert.deepEqual(Array.from(editorTypes).sort(), expected);

    const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/example.json'), 'utf8'));
    const customTypes = new Set(expected);
    for (const node of example) {
        if (customTypes.has(node.type) && node.type !== 'moduleclient') {
            assert.equal(typeof node.client, 'string');
            assert.notEqual(node.client, '');
        }
    }
});

test('keeps the released package identity during modernization', () => {
    assert.equal(manifest.name, 'node-red-contrib-azure-iot-edge-kpm');
    assert.equal(manifest.version, '1.0.0-beta.1');
    assert.equal(manifest.license, 'MIT');
});

test('the example preserves correlated method responses', () => {
    const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/example.json'), 'utf8'));
    const method = example.find((node) => node.type === 'modulemethod');
    const response = example.find((node) => node.type === 'function' && node.name === 'response msg');

    assert.ok(method, 'module method example is missing');
    assert.ok(response, 'module method response function is missing');
    assert.match(response.func, /msg\.status\s*=\s*200/);
    assert.doesNotMatch(response.func, /return\s+response/);
});
