module.exports = function(RED) {
    'use strict';

    const Protocol = require('azure-iot-device-mqtt').Mqtt;
    const ModuleClient = require('azure-iot-device').ModuleClient;

    function AzureIoTConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.client = null;

        node.connect = async function() {
            if (!node.client) {
                try {
                    node.client = await ModuleClient.fromEnvironment(Protocol);
                    await node.client.open();
                    node.log('Module Client connected');
                } catch (err) {
                    node.error('Error connecting Module Client: ' + err);
                    node.client = null;
                }
            }
            return node.client;
        };

        node.on('close', async function(done) {
            if (node.client) {
                await node.client.close();
                node.client = null;
            }
            done();
        });
    }

    RED.nodes.registerType('azure-iot-edge-config', AzureIoTConfigNode, {
        credentials: {
            connectionString: { type: 'text' }
        }
    });
};