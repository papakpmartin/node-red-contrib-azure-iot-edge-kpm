# Changelog

## 1.0.0-beta.1

- Require Node.js 22 and Node-RED 4.
- Upgrade to `azure-iot-device@1.18.4` and
  `azure-iot-device-mqtt@1.16.4`.
- Remove the unused AMQP transport.
- Preserve the node types and flow configuration references from 0.6.1.
- Give each Device Client configuration its own validated X.509 client and twin.
- Give the single supported Module Client configuration explicit lifecycle,
  workload-token error recovery, and child registration ownership.
- Bound pending operations and direct-method requests.
- Add direct-method request correlation with `msg.requestId`; send native JSON
  response payloads rather than double-encoded objects.
- Add Node-RED runtime tests, Node 22 CI, package-content checks, and updated
  X.509, workload, migration, and rollback guidance.

This is a prerelease. Live IoT Hub/IoT Edge qualification, soak testing, and a
field canary are required before promotion to 1.0.0.
