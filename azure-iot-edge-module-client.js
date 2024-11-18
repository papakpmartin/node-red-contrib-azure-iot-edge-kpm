module.exports = function (RED) {
  'use strict';

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

  let cached_module_twin;
  let method_responses_array = [];

  async function createModuleClient(config) {
    const node = this;
    RED.nodes.createNode(node, config);

    const azureConfig = RED.nodes.getNode(config.azureConfig);

    try {
      const client = await azureConfig.connect();
      node.log('Module Client connected');

      client.on('error', (err) => {
        node.error('Module Client error: ' + err);
      });

      const twin = await client.getTwin();
      node.log('Module twin created.');
      node.log('Twin contents: ' + JSON.stringify(twin.properties));

      node.on('close', () => {
        node.log('Azure IoT Edge Module Client closed.');
        cached_module_twin = null;
        twin.removeAllListeners();
        client.removeAllListeners();
      });

      cached_module_twin = twin;
    } catch (err) {
      node.error('Error connecting Module Client: ' + err);
    }
  }

  async function createModuleTwin(config) {
    const node = this;
    RED.nodes.createNode(node, config);

    setStatus(node, statusEnum.disconnected);

    try {
      const client = await getCachedModuleClient();
      const twin = await getCachedModuleTwin();

      setStatus(node, statusEnum.connected);

      twin.on('properties.desired', (delta) => {
        setStatus(node, statusEnum.desired);
        node.log(`New desired properties received: ${JSON.stringify(delta)}`);
        node.send({ payload: delta, topic: "desired" });
        setStatus(node, statusEnum.connected);
      });

      node.on('input', (msg) => {
        setStatus(node, statusEnum.reported);
        let messageJSON = typeof msg.payload !== "string" ? msg.payload : JSON.parse(msg.payload);

        twin.properties.reported.update(messageJSON, (err) => {
          if (err) {
            node.warn(`Error updating twin reported properties: ${err}`);
          } else {
            node.log('Twin reported properties updated');
            setStatus(node, statusEnum.connected);
          }
        });
      });
    } catch (err) {
      node.error(`Module Twin error: ${err}`);
    }

    node.on('close', (done) => {
      setStatus(node, statusEnum.disconnected);
      done();
    });
  }

  async function createModuleInput(config) {
    const node = this;
    node.input = config.input;
    RED.nodes.createNode(node, config);

    setStatus(node, statusEnum.disconnected);

    try {
      const client = await getCachedModuleClient();
      node.log("Module Input created: " + node.input);
      setStatus(node, statusEnum.connected);

      client.on('inputMessage', (inputName, msg) => {
        sendMessageToNodeOutput(client, node, inputName, msg);
      });
    } catch (err) {
      node.error("Module Input can't be loaded: " + err);
    }

    node.on('close', (done) => {
      setStatus(node, statusEnum.disconnected);
      done();
    });
  }

  async function createModuleOutput(config) {
    const node = this;
    node.output = config.output;
    node.logMessages = config.logMessages;
    RED.nodes.createNode(node, config);

    setStatus(node, statusEnum.disconnected);

    try {
      const client = await getCachedModuleClient();
      setStatus(node, statusEnum.connected);
      node.log(`Module Output created: ${node.output}`);

      node.on('input', async (msg) => {
        setStatus(node, statusEnum.sent);
        let messageJSON = typeof msg.payload !== "string" ? msg.payload : JSON.parse(msg.payload);

        await sendMessageToEdgeHub(client, node, messageJSON, node.output);
      });
    } catch (err) {
      node.error("Module Output can't be loaded: " + err);
    }

    node.on('close', (done) => {
      setStatus(node, statusEnum.disconnected);
      done();
    });
  }

  async function createModuleMethod(config) {
    const node = this;
    node.method = config.method;
    RED.nodes.createNode(node, config);

    setStatus(node, statusEnum.disconnected);

    try {
      const client = await getCachedModuleClient();
      setStatus(node, statusEnum.connected);
      const method = node.method;
      node.log('Direct Method created: ' + method);

      client.onMethod(method, async (request, response) => {
        setStatus(node, statusEnum.method);
        node.log('Direct Method called: ' + request.methodName);

        node.send({
          payload: request.payload || null,
          topic: "method",
          method: request.methodName
        });

        try {
          const rspns = await getModuleMethodResponse(node);
          const responseBody = typeof rspns.response !== "string" ? JSON.stringify(rspns.response) : rspns.response;
          response.send(rspns.status, responseBody, (err) => {
            if (err) {
              node.error(`Failure in response.send(): ${err}`);
            } else {
              node.log('Successfully sent method response.');
            }
          });
        } catch (err) {
          node.error(`Failure in getResponse().then(): ${err}`);
        }

        node.response = null;
        setStatus(node, statusEnum.connected);
      });

      node.on('input', (msg) => {
        method_responses_array.push({
          method: method,
          response: msg.payload,
          status: msg.status
        });
        node.log(`Module Method response set through node input: ${JSON.stringify(method_responses_array.find((m) => m.method === method))}`);
      });
    } catch (err) {
      node.error("Module Method can't be loaded: " + err);
    }

    node.on('close', (done) => {
      setStatus(node, statusEnum.disconnected);
      done();
    });
  }

  async function getCachedModuleClient() {
    const azureConfig = RED.nodes.getNode(config.azureConfig);
    return await azureConfig.connect();
  }

  async function getCachedModuleTwin() {
    if (cached_module_twin) {
      return cached_module_twin;
    } else {
      throw new Error("Unable to get Module Twin from cache");
    }
  }

  async function getModuleMethodResponse(node) {
    let retries = 20;
    let timeOut = 1000;
    node.log(`Module Method node method: ${node.method}`);

    for (let i = 1; i <= retries; i++) {
      let methodResponse = method_responses_array.find((m) => m.method === node.method);
      if (methodResponse) {
        let response = methodResponse;
        node.log(`Module Method response object found: ${JSON.stringify(response)}`);
        method_responses_array.splice(method_responses_array.findIndex((m) => m.method === node.method), 1);
        return response;
      } else {
        await new Promise((resolve) => setTimeout(resolve, timeOut * ((i % 10) + 1)));
      }
    }
    throw new Error("Module Method Response not found in responses array");
  }

  function sendMessageToNodeOutput(client, node, inputName, msg) {
    client.complete(msg, (err) => {
      if (err) {
        node.error('Error completing message: ' + err);
        setStatus(node, statusEnum.error);
      }
    });

    if (inputName === node.input) {
      setStatus(node, statusEnum.received);
      let message = JSON.parse(msg.getBytes().toString('utf8'));
      if (message) {
        node.log('Processed input message: ' + inputName);
        node.send({ payload: message, topic: "input", input: inputName });
      }
      setStatus(node, statusEnum.connected);
    }
  }

  function setStatus(node, status) {
    node.status({ fill: status.color, shape: "dot", text: status.text });
  }

  async function sendMessageToEdgeHub(client, node, message, output) {
    if (!output) {
      output = "output";
    }
    if (node.logMessages) {
      node.log('Sending Message to Azure IoT Edge: ' + output + '\n   Payload: ' + JSON.stringify(message));
    }
    let msg = new Message(JSON.stringify(message));
    msg.contentEncoding = "utf-8";
    msg.contentType = "application/json";
    client.sendOutputEvent(output, msg, (err) => {
      if (err) {
        node.error('Error while trying to send message: ' + err.toString());
        setStatus(node, statusEnum.error);
      } else {
        node.log('Message sent.');
        setStatus(node, statusEnum.connected);
      }
    });
  }

  RED.nodes.registerType("iot-edge-module-client", createModuleClient, {
    defaults: {
      azureConfig: { type: 'azure-iot-edge-config', required: true }
    }
  });

  RED.nodes.registerType("iot-edge-module-twin", createModuleTwin, {
    defaults: {
      azureConfig: { type: 'azure-iot-edge-config', required: true },
      name: { value: "IoT Edge Module Twin" }
    }
  });

  RED.nodes.registerType("iot-edge-module-input", createModuleInput, {
    defaults: {
      azureConfig: { type: 'azure-iot-edge-config', required: true },
    }
  });

  RED.nodes.registerType("iot-edge-module-output", createModuleOutput, {
    defaults: {
      azureConfig: { type: 'azure-iot-edge-config', required: true },
      logMessages: { value: false }
    }
  });

  RED.nodes.registerType("iot-edge-module-method", createModuleMethod, {
    defaults: {
      azureConfig: { type: 'azure-iot-edge-config', required: true },
      method: { value: "method1" },
      response: { value: "{}" }
    }
  });
};