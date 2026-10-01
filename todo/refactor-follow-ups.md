# Refactor Follow-ups

The duplicate Node-RED registration warning was introduced after the working
`1.0.0-beta.2` artifact by declaring the combined module runtime once for each
node type. The manifest has been restored to one entry per JS/HTML pair and is
covered by source and packed-artifact regression tests.

The current runtime and editor files are otherwise byte-for-byte equivalent to
the local `1.0.0-beta.2` package. The items below are separate release and
reliability work, not causes of the duplicate-registration warning.

## Release Blockers

- Restore strict release tag, checkout manifest, and packed-artifact version
  equality checks in `.github/workflows/npmpublish.yml`. Also fail before
  publication when the selected version already exists in npm.
- Reconcile the supported Node.js range. The manifest advertises `>=22 <26`,
  but CI, `.nvmrc`, the README, and the modernization plan qualify Node 22 only.
  Either restore `<23` or qualify every advertised major.
- Refresh the dependency lock and production vulnerability assessment. The
  current production tree includes a high-severity `brace-expansion` advisory
  that is not recorded in `docs/dependency-risk.md`; assess reachability and
  update to a fixed compatible resolution or document an approved exception.

## Runtime Reliability

- Prevent replacement module and device clients after startup `open()` fails
  unless the failed client is known to have closed. A failed or timed-out close
  currently permits overlapping identity clients; the module path can also
  remove the uncertain client's last error listener.
- Retry transient device `getTwin()` failures for passive Device Twin nodes.
  The promise becomes retryable, but no retry is scheduled unless another event
  happens to request the twin.
- Reserve capacity for direct-method responses or separate them from the shared
  operation limit. A response can currently be removed from the pending request
  map and then rejected locally when the general operation pool is full, leaving
  the cloud caller to time out.
- Include Module Output nodes in owner connection-status fanout. Their displayed
  status can remain disconnected after startup or connected through an actual
  disconnect even though message readiness is handled by the owner.

## Test And Documentation Gaps

- Add startup failure plus failed/hung close tests for both client owners.
- Add device twin retry, method-response saturation, output status, and device
  reconnect tests, including exact Node-RED `done()` behavior.
- Install the packed artifact into an isolated Node-RED user directory in CI and
  assert successful registry discovery with no duplicate node-set errors.
- Parse or execute JavaScript embedded in editor HTML as part of linting.
- Correct Device Twin editor help that says Node-RED must run as an IoT Edge
  module; this path connects directly to IoT Hub using the configured X.509
  device identity.
- Complete live IoT Edge workload, direct X.509 device, reconnect/fault, token
  renewal, and soak acceptance before a stable release.
