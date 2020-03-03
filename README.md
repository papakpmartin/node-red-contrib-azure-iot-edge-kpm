# Azure IoT Edge Node-Red Module KPM

This Azure IoT Edge Node-Red Module is essentially a fork of a module that used to exist on npm, but disappeared around February 17, 2020. I pulled this from the Docker image that I'd built before the module disappeared. The only place that I see the original content still kind of alive is in a Docker image at [gbbiotwesouth/noderededgemodule](https://hub.docker.com/r/gbbiotwesouth/noderededgemodule/), a project that appears to still be active [GitHub](https://github.com/iotblackbelt/noderededgemodule). I only need the Node-RED module, not the Docker image, so I am publishing this. The original MIT license applies and is included.

WARNING: I do not know that I'll be maintaining this going forward. I'm just doing this to address the problem that occured when the original module vanished.

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

The Module Output enables you to send output to the edgeHub. To send output to another module or to the IoT Hub you have to setup the route to use the output when you created the node. The node input will enable you to send the telemetry message. <br/>
The Module Output needs a connection to a Module Client and the name of the "output": 

![edit-module-output](/images/edit-module-output.PNG)

### Module Method

The Module Method enables you receive module direct methods. The setup of the module defines which method the node is responding to and what the response is for the method call. The message coming from the node output will have the properties "topic: method", "method: &#x3C;method name&#x3E;" and "payload: &#x3C;method payload&#x3E;" added to it for selection and identification purposes.<br/>
The input of the node will have to be used to send a response for the method call. The response (message) wil have to be connected (indirectly) to the message coming from the node output, to ensure a closed loop for the method. When sending a return for the method call on the input, the message property "status: &#x3C;your status&#x3E;" needs to be set on the message. See the function in the example for details.

The Module Method needs a connection to a Module Client and the name of the "method": 

![edit-module-method](/images/edit-module-method.PNG)

