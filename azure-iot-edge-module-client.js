module.exports = function(RED) {
    'use strict'

    const Protocol = require('azure-iot-device-mqtt').Mqtt;
    // TODO: Add selector to config node to choose protocol
    // var Protocol = require('azure-iot-device-amqp').Amqp;
    // var Protocol = require('azure-iot-device-http').Http;
    // var Protocol = require('azure-iot-device-mqtt').MqttWs;
    // var Protocol = require('azure-iot-device-amqp').AmqpWs;
    const ModuleClient = require('azure-iot-device').ModuleClient;
    const Message = require('azure-iot-device').Message;

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

    let cached_module_client;
    let cached_module_twin;
    let method_responses_array = [];


    function createModuleClient(config) {
        const node = this;
        RED.nodes.createNode(node, config);

        ModuleClient.fromEnvironment(Protocol, (err, client) => {
            if (err) {
                node.log('Module Client creation error:' + err);
            } else {
                node.log('Module Client created from environment');

                // set up handlers
                client.on('error', (err) => {
                    node.log('Module Client error:' + err);
                });

                client.open((err) => {
                    if (err) {
                        node.log('Error opening Module Client:' + err);
                        throw err;
                    } else {
                        node.log('Module Client connected');
                        client.getTwin((err, twin) => {
                            if (err) {
                                node.error('Could not get the module twin: ' + err);
                                throw err;
                            } else {
                                node.log('Module twin created.');
                                node.log('Twin contents:');
                                node.log(JSON.stringify(twin.properties));

                                node.on('close', () => {
                                    node.log('Azure IoT Edge Module Client closed.');
                                    cached_module_client = null;
                                    cached_module_twin = null;
                                    twin.removeAllListeners();
                                    client.removeAllListeners();
                                    client.close();
                                });
                                cached_module_twin = twin;
                            }
                        });
                        cached_module_client = client;
                    }
                });
            }
        });
    }


    function createModuleTwin(config) {
        var node = this;
        RED.nodes.createNode(node, config);

        setStatus(node, statusEnum.disconnected);

        getCachedModuleClient()
            .then((client) => {

                getCachedModuleTwin()
                    .then(function(twin) {
                        setStatus(node, statusEnum.connected);

                        twin.on('properties.desired', (delta) => {
                            setStatus(node, statusEnum.desired);
                            node.log(`New desired properties received: ${JSON.stringify(delta)}`);
                            node.send({ payload: delta, topic: "desired" });
                            setStatus(node, statusEnum.connected);
                        });

                        node.on('input', (msg) => {
                            setStatus(node, statusEnum.reported);
                            var messageJSON = null;

                            if (typeof(msg.payload) != "string") {
                                messageJSON = msg.payload;
                            } else {
                                //Converting string to JSON Object
                                messageJSON = JSON.parse(msg.payload);
                            }

                            twin.properties.reported.update(messageJSON, function(err) {
                                if (err) {
                                    node.warn(`Error updating twin reported properties: ${err}`);
                                    throw err;
                                }
                                node.log('Twin reported properties updated');
                                setStatus(node, statusEnum.connected);
                            });
                        });
                    })
                    .catch((err) => {
                        node.log(`Module Twin error: ${err}`);
                    });
            })
            .catch(function(err) {
                node.log(`Module Twin can't be loaded: ${err}`);
            });

        node.on('close', function(done) {
            setStatus(node, statusEnum.disconnected);
            done();
        });
    }


    function createModuleInput(config) {
        var node = this;
        node.input = config.input;
        RED.nodes.createNode(node, config);

        setStatus(node, statusEnum.disconnected);

        getCachedModuleClient()
            .then((client) => {
                node.log("Module Input created: " + node.input);
                setStatus(node, statusEnum.connected);

                client.on('inputMessage', function(inputName, msg) {
                    sendMessageToNodeOutput(client, node, inputName, msg);
                });
            })
            .catch((err) => {
                node.log("Module Input can't be loaded: " + err);
            });

        node.on('close', function(done) {
            setStatus(node, statusEnum.disconnected);
            done();
        });
    }


    function createModuleOutput(config) {
        var node = this;
        node.output = config.output;
        RED.nodes.createNode(node, config);

        setStatus(node, statusEnum.disconnected);

        getCachedModuleClient()
            .then((client) => {
                setStatus(node, statusEnum.connected);
                node.log(`Module Output created: ${node.output}`);

                node.on('input', (msg) => {
                    setStatus(node, statusEnum.sent);
                    var messageJSON = null;

                    if (typeof(msg.payload) != "string") {
                        messageJSON = msg.payload;
                    } else {
                        //Converting string to JSON Object
                        messageJSON = JSON.parse(msg.payload);
                    }

                    var messageOutput = node.output;
                    sendMessageToEdgeHub(client, node, messageJSON, messageOutput);
                });
            })
            .catch((err) => {
                node.log("Module Ouput can't be loaded: " + err);
            });

        node.on('close', (done) => {
            setStatus(node, statusEnum.disconnected);
            done();
        });
    }


    function createModuleMethod(config) {
        var node = this;
        node.method = config.method;
        RED.nodes.createNode(node, config);

        setStatus(node, statusEnum.disconnected);

        getCachedModuleClient()
            .then((client) => {
                setStatus(node, statusEnum.connected);
                var mthd = node.method;
                node.log('Direct Method created: ' + mthd);
                client.onMethod(mthd, (request, response) => {
                    setStatus(node, statusEnum.method);
                    node.log('Direct Method called: ' + request.methodName);

                    if (request.payload) {
                        node.log('Method Payload:' + JSON.stringify(request.payload));
                        node.send({
                            payload: request.payload,
                            topic: "method",
                            method: request.methodName
                        });
                    } else {
                        node.send({
                            payload: null,
                            topic: "method",
                            method: request.methodName
                        });
                    }

                    getModuleMethodResponse(node)
                        .then((rspns) => {
                            var responseBody;
                            if (typeof(rspns.response) != "string") {
                                // Turn message object into string 
                                responseBody = JSON.stringify(rspns.response);
                            } else {
                                responseBody = rspns.response;
                            }
                            response.send(rspns.status, responseBody, (err) => {
                                if (err) {
                                    node.log(`Failure in response.send(): ${err}`);
                                } else {
                                    node.log('Successfully sent method response.');
                                }
                            });
                        })
                        .catch(function(err) {
                            node.log(`Failure in getResponse().then(): ${err}`);
                        });

                    node.response = null;

                    setStatus(node, statusEnum.connected);
                });

                // Set method response on input
                node.on('input', (msg) => {
                    var method = node.method;
                    method_responses_array.push({
                        method: method,
                        response: msg.payload,
                        status: msg.status
                    });
                    node.log(`Module Method response set through node input: ${JSON.stringify(method_responses_array.find((m) => m.method === method))}`);
                });
            })
            .catch((err) => {
                node.log("Module Method can't be loaded: " + err);
            });

        node.on('close', (done) => {
            setStatus(node, statusEnum.disconnected);
            done();
        });
    }


    function getCachedModuleClient() {
        const retries = 20;
        const timeOut = 1000;

        let promise = Promise.reject();
        for (let i = 1; i <= retries; i++) {
            promise = promise.catch(() => {
                    if (cached_module_client) {
                        return cached_module_client;
                    } else {
                        throw new Error("Unable to get Module Client from cache");
                    }
                })
                .catch((reason) => {
                    retries++;
                    return new Promise((resolve, reject) => {
                        setTimeout(
                            reject.bind(null, reason),
                            timeOut * ((retries % 10) + 1)
                        );
                    });
                });
        }
        return promise;
    }


    function getCachedModuleTwin() {
        const retries = 10;
        const timeOut = 1000;

        let promise = Promise.reject();
        for (let i = 1; i <= retries; i++) {
            promise = promise.catch(() => {
                    if (cached_module_twin) {
                        return cached_module_twin;
                    } else {
                        throw new Error("Unable to get Module Twin from cache");
                    }
                })
                .catch((reason) => new Promise((resolve, reject) => {
                    setTimeout(
                        reject.bind(null, reason),
                        timeOut * i
                    );
                }));
        }
        return promise;
    }


    function getModuleMethodResponse(node) {
        const retries = 20;
        const timeOut = 1000;
        node.log(`Module Method node method: ${node.method}`);
        let m = {};

        let promise = Promise.reject();
        for (let i = 1; i <= retries; i++) {
            promise = promise.catch(() => {
                    let methodResponse = method_responses_array.find((m) => m.method === node.method);
                    if (methodResponse) {
                        // get the response and clean the array
                        let response = methodResponse;
                        node.log(`Module Method response object found: ${JSON.stringify(response)}`);
                        method_responses_array.splice(method_responses_array.findIndex((m) => m.method === node.method), 1);
                        return response;
                    } else {
                        throw new Error("Module Method Response not found in responses array");
                    }
                })
                .catch((reason) => {
                    retries++;
                    return new Promise((resolve, reject) => {
                        setTimeout(
                            reject.bind(null, reason),
                            timeOut * ((retries % 10) + 1)
                        );
                    });
                });
        }
        return promise;
    }


    function sendMessageToNodeOutput(client, node, inputName, msg) {

        client.complete(msg, function (err) {
            if (err) {
                node.log('error:' + err);
                setStatus(node, statusEnum.error);
            }
        });

        if (inputName === node.input) {
            setStatus(node, statusEnum.received);
            var message = JSON.parse(msg.getBytes().toString('utf8'));
            if (message) {
                node.log('Processed input message:' + inputName);
                // send to node output
                node.send({ payload: message, topic: "input", input: inputName });
            }
            setStatus(node, statusEnum.connected);
        }
    }

    function setStatus(node, status) {
        node.status({ fill: status.color, shape: "dot", text: status.text });
    }

    function sendMessageToEdgeHub(client, node, message, output) {

        if (!output) {
            output = "output";
        }
        node.log('Sending Message to Azure IoT Edge: ' + output + '\n   Payload: ' + JSON.stringify(message));
        var msg = new Message(JSON.stringify(message));
        msg.contentEncoding = "utf-8"
        msg.contentType = "application/json"
        client.sendOutputEvent(output, msg, function(err, res) {
            if (err) {
                node.error('Error while trying to send message:' + err.toString());
                setStatus(node, statusEnum.error);
            } else {
                node.log('Message sent.');
                setStatus(node, statusEnum.connected);
            }
        });
    }



    RED.nodes.registerType("moduleclient", createModuleClient, {
        defaults: {
            module: { value: "" }
        }
    });

    RED.nodes.registerType("moduletwin", createModuleTwin, {
        defaults: {
            name: { value: "Module Twin" }
        }
    });

    RED.nodes.registerType("moduleinput", createModuleInput, {
        defaults: {
            input: { value: "input1" }
        }
    });

    RED.nodes.registerType("moduleoutput", createModuleOutput, {
        defaults: {
            output: { value: "output1" }
        }
    });

    RED.nodes.registerType("modulemethod", createModuleMethod, {
        defaults: {
            method: { value: "method1" },
            response: { value: "{}" }
        }
    });

}