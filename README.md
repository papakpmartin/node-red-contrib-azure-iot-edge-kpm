# Azure IoT Edge nodes for Node-RED

![Node.js Package](https://github.com/kpm-at-hfi/node-red-contrib-azure-iot-edge-kpm/actions/workflows/npmpublish.yml/badge.svg)

This Azure IoT Edge Node-Red Module is essentially a fork of a module that used to exist on npm, but disappeared around February 17, 2020. I pulled this from the Docker image that I'd built before the module disappeared. The only place that I see the original content still kind of alive is in a Docker image at [gbbiotwesouth/noderededgemodule](https://hub.docker.com/r/gbbiotwesouth/noderededgemodule/), a project that appears to still be active [GitHub](https://github.com/iotblackbelt/noderededgemodule). I only need the Node-RED module, not the Docker image, so I am publishing this. The original MIT license applies and is included.

This package uses the active Azure IoT Node.js device SDK and preserves the node types published in version 0.6.1.

## Requirements

- Node.js 22.x
- Node-RED 4.x
- Linux containers for Azure IoT Edge module operation
- MQTT transport

Node.js 24 and Node-RED 5 are not qualified by this release. Azure IoT Edge 1.6 LTS is recommended. Use the newest supported patch release for the runtime and operating system that your deployment has qualified.

## Installation

Install this package in the Node-RED user directory or include it in the immutable application/container build. Back up flows, credentials, settings, certificate references, and the prior image digest before upgrading.

![screenshot](/images/screenshot.PNG)

## Module nodes
The Node-Red module contains a number of custom nodes placed in the group "Azure IoT Edge". These nodes are "Module Twin", "Module Input", "Module Output", and "Module Method". These nodes represent the interaction that can be done with an Azure IoT Edge Module:

### Module Client
The Module Client is a configuration node that needs to be created to make the connection between the IoT Edge and the Node-Red Azure IoT Edge nodes. If you use one of the examples a Module Client will be created automatically.

**NOTE: _Only one Module Client node should be used when using the Node-Red module._**

### Module Twin

The Module Twin enables you to interact with the module twin on IoT Hub. The node output will provide the twin desired property changes and the node input will enable you to send reported properties back to the IoT Hub. The message coming from the node output will have the property "topic: desired" added to it for selection and identification purposes.

The Module Twin only needs a connection to a Module Client:

![edit-module-twin](/images/edit-module-twin.PNG)

### Module Input

The Module Input enables you to receive input from other modules on your IoT Edge device. To receive input, you have to setup the route to point at the input you specified when you created the node. The node output will provide you with the incoming telemetry message. The message coming from the node output will have the properties "topic: input" and "input: &#x3C;input name&#x3E;" added to it for selection and identification purposes.

The Module Input needs a connection to a Module Client and the name of the "input"::

![edit-module-twin](/images/edit-module-input.PNG)

### Module Output

The Module Output enables you to send output to the edgeHub module. To send output to another module or to the IoT Hub you have to setup the route to use the output when you created the node. The node input will enable you to send a message. <br/>
The Module Output needs a connection to a Module Client and the name of the "output": 

![edit-module-output](/images/edit-module-output.PNG)

### Module Method

The Module Method enables you receive module direct methods. The setup of each module defines which method the node is responding to and what the response is for the method call. The message coming from the node output will look like:

```jsonc
{
    "topic": "method",
    "method": "<the name of the method that was called>",
    "payload": "<the payload that was sent when the method was called>"
}
````

The input of the node is used to send a response for the method call. So this should be used by taking the message from the output, passing it to any needed logic/work, and then building a response that will go back into this node.

The request message includes a unique `msg.requestId`. Preserve it through the flow and return it with the response:

```jsonc
{
    "requestId": "<value from the request message>",
    "status": 200,
    "payload": "<any JSON-compatible value>"
}
```

`msg.requestId`, `msg.status`, and `msg.payload` are required. The status must be an integer from 100 through 599. The request expires after 25 seconds. Preserve the original message where practical so the request ID is not lost. Responses use their native JSON type; objects are no longer double encoded as JSON strings.

The Module Method needs a connection to a Module Client and the name of the "method": 

![edit-module-method](/images/edit-module-method.PNG)



## Device twin with X.509

The Device Client connects directly to IoT Hub as the configured device identity. It does not use the Edge module workload identity. The device identity must already be configured in IoT Hub for the supplied thumbprint or CA-signed certificate.

The module reads the certificate only when a Device Client configuration is used. A module-only flow does not require access to the device private key.

### Container create options

#### Container Create Options:

```jsonc
{
  "HostConfig": {
    "Binds": [
      "/path/to/your/iotedge/certs/directory/on/host:/data/certs:ro"
    ]
  }
}
```

### Environment variables

Add these in your azure deployment manifest.

```
PATH_TO_CERTIFICATE_FILE: /data/certs/iot-edge-device-identity-full-chain.cert.pem
PATH_TO_KEY_FILE: /data/certs/iot-edge-device-identity.key.pem
IOTEDGE_IOTHUBHOSTNAME: example.azure-devices.net
IOTEDGE_DEVICEID: device-01
```

The certificate and private key must be PEM encoded, valid, and match. The process must have read access to the files. Keep private keys out of flows, logs, images, and source control. The module warns when the certificate expires within 30 days.

To rotate the certificate, install a matching certificate/key pair atomically, ensure IoT Hub trusts the replacement, and restart or fully redeploy the Device Client configuration. Environment-variable changes require restarting the Node-RED process or container.

The container trust store must trust the current Azure IoT Hub server roots. Do not disable TLS verification or pin Azure leaf/intermediate certificates.

## Module authentication

The Module Client normally uses the IoT Edge workload environment and runtime-managed SAS tokens. Required variables include `IOTEDGE_WORKLOADURI`, `IOTEDGE_DEVICEID`, `IOTEDGE_MODULEID`, `IOTEDGE_MODULEGENERATIONID`, `IOTEDGE_IOTHUBHOSTNAME`, and `IOTEDGE_AUTHSCHEME=sasToken`.

Client creation delegates to Azure's official `ModuleClient.fromEnvironment` factory so workload signing, gateway selection, and trust-bundle configuration follow the SDK implementation.

For compatibility, the Azure SDK's `EdgeHubConnectionString` and `IotHubConnectionString` environment overrides are retained when present. Do not set them accidentally: they take precedence over workload authentication. Only one Module Client configuration may be active in a Node-RED process.

An IoT Edge host provisioned with X.509 still normally gives modules a workload-managed SAS identity. Do not mount the host's private identity key into Node-RED merely to create a Module Client.

## Reliability behavior

- Each configuration node owns its client and twin; child nodes do not share process-global state.
- Failed startup and disconnects retry with bounded exponential backoff. Azure SDK operation retries remain enabled.
- At most 100 pending operations and 100 pending method requests are retained per client. Additional work fails through Node-RED's message completion/error path rather than growing memory without bound.
- Closing or redeploying nodes removes only listeners owned by those nodes. Pending direct methods receive an unavailable response where possible.
- MQTT input settlement is automatic. A successful Module Output callback means Edge Hub accepted the send; it does not guarantee downstream processing or exactly-once delivery.
- JSON parse, serialization, configuration, and SDK failures are reported to Node-RED Catch nodes where an originating input message exists.

## Upgrade notes from 0.6.1

- Existing serialized node types and `client` references remain unchanged.
- Module method response flows must preserve the new `msg.requestId`.
- Native JSON method response values are sent without the prior double encoding.
- Valid falsy JSON module-input values such as `false`, `0`, `""`, and `null` are now delivered.
- The unused AMQP dependency was removed; MQTT remains the supported transport.
- Node.js 22 and Node-RED 4 are now required.

Test the prerelease package and rollback procedure on representative devices before fleet rollout. Do not run old and new clients concurrently under the same IoT identity for comparison.
