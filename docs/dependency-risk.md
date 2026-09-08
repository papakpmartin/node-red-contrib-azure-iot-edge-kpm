# Dependency Risk Record

Assessment date: September 8, 2026.

Candidate: `1.0.0-beta.1`, Node.js 22, Node-RED 4, `azure-iot-device@1.18.4`,
and `azure-iot-device-mqtt@1.16.4`.

`npm audit --omit=dev` reports no critical production vulnerability after the
lockfile resolves `lodash@4.18.1`. It still reports moderate findings inherited
through the latest active Azure IoT Node.js SDK:

- `azure-iot-device@1.18.4` pins `@azure/storage-blob@12.8.0`.
- That package uses unsupported `@azure/core-http@2.3.2`, which resolves
  `uuid@8.3.2` affected by `GHSA-w5hq-g745-h8pq` when callers provide an
  undersized buffer to UUID v3/v5/v6 APIs.
- The Node-RED nodes in this package do not expose Azure blob/file-upload APIs or
  call UUID generation directly. Exploitability in the implemented twin,
  messaging, and method paths has not been established.
- npm proposes downgrading the direct Azure SDK instead of a compatible fix.
  This project will not downgrade from Azure's active release or force an
  unsupported transitive major override.

Release approval must explicitly accept this residual risk or wait for an Azure
SDK release with updated transitive dependencies. Re-run the production audit at
every release and remove this exception when an upstream-compatible fix exists.

Development-only advisories from Node-RED's test dependencies are not shipped in
the npm package, but still require routine review because CI executes that code.
