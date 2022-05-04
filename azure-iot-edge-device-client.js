module.exports = function(RED) {
    'use strict'

    const Protocol = require('azure-iot-device-mqtt').Mqtt;
    const DeviceClient = require('azure-iot-device').Client;
    const Message = require('azure-iot-device').Message;
    const fs = require('fs');

    const statusEnum = {
        disconnected: { color: "red", text: "Disconnected" },
        connected: { color: "green", text: "Connected" },
        sent: { color: "blue", text: "Sending message" },
        received: { color: "yellow", text: "Receiving message" },
        reported: { color: "blue", text: "Sending reported properties" },
        desired: { color: "yellow", text: "Receiving desired properties" },
        method: { color: "yellow", text: "Receiving direct method" },
        response: { color: "blue", text: "Sending method response" },
        error: { color: "grey", text: "Error" }
    };

    const IOTEDGE_IOTHUBHOSTNAME = process.env.IOTEDGE_IOTHUBHOSTNAME
    const IOTEDGE_DEVICEID = process.env.IOTEDGE_DEVICEID
    var deviceConnectionString = `HostName=${IOTEDGE_IOTHUBHOSTNAME};DeviceId=${IOTEDGE_DEVICEID};x509=true`;
    // console.log(deviceConnectionString)

    const certFile = process.env.PATH_TO_CERTIFICATE_FILE;
    const keyFile = process.env.PATH_TO_KEY_FILE;
    const cert_contents = fs.readFileSync(certFile, 'utf-8').toString()
    const key_contents = fs.readFileSync(keyFile, 'utf-8').toString()
    const options = {
        cert: cert_contents,
        key: key_contents
    };
    // console.log(options)

    let deviceClient;
    let deviceTwin;


    function CreateDeviceClient(config) {
        let node = this;
        node.connected = false;
        RED.nodes.createNode(node, config);

        node.log('Creating a Device Client from a x509 connection string')
        let client = DeviceClient.fromConnectionString(deviceConnectionString, Protocol)

        node.log('Setting client options')
        client.setOptions(options)

        node.log('Setting client options')
        client.open((err) => {
            if (err) {
                node.warn('client.open error:' + err);
                throw err;
            } else {
                // node.log('Device Client opened');

                client.getTwin((err, twin) => {
                    if (err) {
                        node.error('Could not get the device twin: ' + err);
                        throw err;
                    } else {
                        node.log('Device twin created');
                        node.log('Twin contents:');
                        node.log(twin.properties);

                        node.on('close', function() {
                            node.warn('Azure IoT Edge Device Client closed');
                            deviceClient = null;
                            deviceTwin = null;
                            twin.removeAllListeners();
                            client.removeAllListeners();
                            client.close();
                        });
                        deviceTwin = twin;
                    }
                });
                deviceClient = client;
            }
        })
    }



    // Function to create the Module Twin 
    function DeviceTwin(config) {
        var node = this;
        RED.nodes.createNode(node, config);
        setStatus(node, statusEnum.disconnected);

        getClient()
            .then(function(client) {
                node.log(client)
                setStatus(node, statusEnum.connected);

                getTwin()
                    .then(function(twin) {
                        // Register for changes
                        twin.on('properties.desired', function(delta) {
                            setStatus(node, statusEnum.desired);
                            node.log('New desired properties received:');
                            node.log(JSON.stringify(delta));
                            node.send({ payload: delta, topic: "desired" })
                            setStatus(node, statusEnum.connected);
                        });

                        node.on('input', function(msg) {
                            setStatus(node, statusEnum.reported);
                            var messageJSON = null;

                            if (typeof(msg.payload) != "string") {
                                messageJSON = msg.payload;
                            } else {
                                //Converting string to JSON Object
                                messageJSON = JSON.parse(msg.payload);
                            }

                            twin.properties.reported.update(messageJSON, function(err) {
                                if (err) throw err;
                                node.log('Twin state reported');
                                setStatus(node, statusEnum.connected);
                            });
                        });
                    })
                    .catch(function(err) {
                        node.log('Device Twin error:' + err);
                    });
            })
            .catch(function(err) {
                node.log("Device Twin can't be loaded: " + err);
            });

        node.on('close', function(done) {
            setStatus(node, statusEnum.disconnected);
            done();
        });
    }

    // Get module client using promise, and retry, and slow backoff
    function getClient() {
        var retries = 20;
        var timeOut = 1000;
        // Retrieve client using progressive promise to wait for module client to be opened
        var promise = Promise.reject();
        for (var i = 1; i <= retries; i++) {
            promise = promise
                .catch(function() {
                    if (deviceClient) {
                        return deviceClient;
                    } else {
                        throw new Error("Device Client not initiated");
                    }
                })
                .catch(function rejectDelay(reason) {
                    retries++;
                    return new Promise(function(resolve, reject) {
                        setTimeout(reject.bind(null, reason), timeOut * ((retries % 10) + 1));
                    });
                });
        }
        return promise;
    }

    // Get module twin using promise, and retry, and slow backoff
    function getTwin() {
        var retries = 10;
        var timeOut = 1000;
        // Retrieve twin using progressive promise to wait for module twin to be opened
        var promise = Promise.reject();
        for (var i = 1; i <= retries; i++) {
            promise = promise.catch(function() {
                    if (deviceTwin) {
                        return deviceTwin;
                    } else {
                        throw new Error("Device Twin not initiated");
                    }
                })
                .catch(function rejectDelay(reason) {
                    return new Promise(function(resolve, reject) {
                        setTimeout(reject.bind(null, reason), timeOut * i);
                    });
                });
        }
        return promise;
    }


    var setStatus = function(node, status) {
        node.status({ fill: status.color, shape: "dot", text: status.text });
    }

    RED.nodes.registerType("device-client", CreateDeviceClient, {
        defaults: {
            module: { value: "" }
        }
    });

    RED.nodes.registerType("device-twin", DeviceTwin, {
        defaults: {
            name: { value: "Device Twin" }
        }
    });

}