# Azure IoT Node-RED Modernization Plan

Status: proposed; implementation requires approval.

Owner-decided initial runtime scope: Node.js 22.x and Node-RED 4.x only.
Node.js 24 and Node-RED 5 are separate follow-on work, not release requirements.

Research date: September 8, 2026.

Repository reviewed: `modernize`, commit `f75a4b3`; package version `0.6.1`.
Historical comparison: local `v0.6.1` tag, commit `ef5dd7e`.

This document is the only planned deliverable of the planning task. No runtime,
editor, dependency, lockfile, workflow, deployment, or published package changes
are authorized by it. Research used repository inspection, npm metadata, Azure
documentation, and SDK source. No live Azure tests or vulnerability audit were
performed. Findings about this checkout do not establish failures in the deployed
artifact that has worked in the field.

## 1. Recommended Direction

1. Establish the exact field-deployed baseline and capture its behavior before
   modifying the implementation. This checkout contains an unfinished refactor
   and must not be assumed to match production.
2. Keep plain CommonJS JavaScript, ordinary Node-RED constructors, and the existing
   editor/runtime node types, configuration references, ports, and message shapes.
   Use asynchronous functions inside constructors, not as node constructors.
   Target only Node.js 22 and Node-RED 4 for the first release.
3. Upgrade the coordinated Azure SDK family to the latest stable, supported
   published versions, currently device `1.18.4` and MQTT `1.16.4`. Remove the
   unused AMQP dependency after confirming the field artifact exposes no AMQP
   option. Do not replace the device SDK with a service or management SDK.
4. Make direct device X.509 and IoT Edge workload authentication mandatory tested
   paths. These are different identities/authentication mechanisms, even when the
   Edge host itself was provisioned using X.509.
5. Separate device and module connection ownership internally, but retain the
   existing npm package for the first stable modernization release. Reconsider
   independent packages only after this release passes field acceptance.
6. Repair lifecycle, error handling, redeploy, and message-completion problems in
   small, independently tested changes. Treat externally visible bug fixes as
   explicit compatibility decisions, not incidental cleanup.
7. Require real Node-RED package tests, live X.509/Edge acceptance, fault injection,
   soak testing, and a rehearsed rollback before a staged production rollout.

"Latest" is a candidate selection rule, not a reliability guarantee. Recheck
versions and advisories at implementation and release time; qualify and freeze
an exact candidate rather than changing dependencies during the soak period.

## 2. Repository Baseline And Risks

Paths and line references below describe `f75a4b3`, not an asserted production
baseline. Convert each relevant finding into a regression test before fixing it.

| Area | Evidence | Consequence for the plan |
| --- | --- | --- |
| Incomplete module refactor | `azure-iot-edge-module-client.js:21-25,283-315`; `azure-iot-edge-module-client.html:2-157` | Runtime registers `iot-edge-module-*`, but editor/example use `moduleclient`, `moduletwin`, `moduleinput`, `moduleoutput`, `modulemethod`. Runtime expects `azureConfig`; editor persists `client`. Restore the field-proven contract rather than migrate flows to an unfinished design. |
| Invalid Node-RED constructors | `azure-iot-edge-module-client.js:21,52,94,119,148` | Async functions cannot be instantiated as normal JavaScript constructors. Actual Node-RED registration/deployment tests are essential. |
| Missing config registration | `package.json:30-35`; `azure-iot-edge-config.js:36-40` | New shared config node is not in the manifest and has no matching editor HTML. Its declared connection-string credential is unused. Do not retain it simply because it exists on this branch. |
| Broken client lookup | `azure-iot-edge-module-client.js:207-209` | Helper references an out-of-scope `config`. Static linting and real flow tests should catch this. |
| X.509 loading at registration | `azure-iot-edge-device-client.js:21-42` | Certificate files are read even when no device config node is used. Module-only installation must work without these files. |
| Global device state | `azure-iot-edge-device-client.js:44-45,75-86,99-105` | Config nodes overwrite shared client/twin state; device twin ignores its configured `client` reference. Scope state to its owning config node. |
| Global module state | `azure-iot-edge-module-client.js:18-19,212-236` | Twin and direct-method response caches are not isolated by client or request. Remove global operational state. |
| Unsafe startup/shutdown | `azure-iot-edge-config.js:13-33`; device source `:57-85` | Concurrent opens, lost failed clients, unchecked `setOptions`, late cleanup registration, and close rejection need deterministic handling. |
| Listener leaks and broad cleanup | module source `:39-44,64-69,106-108,161-204`; device source `:75-81,107-113,141-144` | Child redeploy does not detach owned listeners; `removeAllListeners()` can remove SDK or sibling listeners. Method handlers require special ownership. |
| Uncontained failures | device source `:61-69,119-127`; module source `:71-82,132-137,247-252` | Async throws, invalid JSON, SDK errors, and rejected promises must become controlled node errors, not process failures. |
| False send completion | module source `:262-280` | An async helper returns before callback-style `sendOutputEvent` completes. Implement Node-RED `done` on actual SDK completion. |
| Method response ambiguity | module source `:161-195,220-236` | Method-name-only queue can misroute concurrent or late responses; response objects are pre-stringified. Fixing either can change cloud-visible behavior. |
| Runtime support mismatch | `package.json:16-24`; `package-lock.json:256-312`; `.github/workflows/npmpublish.yml:12-27` | Manifest says Node `>=0.12.0`, locked Azure packages require `>=14`, and CI uses Node 12. No Node-RED support range is declared. |
| No test baseline | `package.json`; `.github/workflows/npmpublish.yml:15-16` | No test scripts/dependencies/fixtures; release workflow only installs dependencies and its test step is commented out. |
| Sensitive logging and incomplete docs | device source `:71-73,101,109-110`; module source `:37,66,195`; `README.md:73-96` | Remove raw client/credential/payload logging; document identity roles, certificate permissions, trust, rotation, and diagnostics. Raw client logging is a potential exposure, not a confirmed secret leak from a running system. |

The current device functionality is device twin access, not a full device
telemetry/C2D/direct-method node suite. Expanding it is out of scope.

## 3. Current Azure And Runtime Targets

### 3.1 Dependency Selection

Verified with npm metadata and the official Azure repository [S1-S4].

| Package | Current lock | Latest stable observed | Proposed treatment |
| --- | --- | --- | --- |
| `azure-iot-device` | `1.18.0` | `1.18.4` | Upgrade; owns both `Client` and `ModuleClient`. |
| `azure-iot-device-mqtt` | `1.16.0` | `1.16.4` | Upgrade alongside device; it depends exactly on device `1.18.4`. |
| `azure-iot-device-amqp` | `1.14.0` | `1.14.4` | Remove unless field inventory identifies an actual supported AMQP path. No repository runtime imports it. |
| Provisioning/security packages | Not direct dependencies | Not selected | Do not add DPS, TPM, or X.509 provisioning libraries just to use an existing PEM certificate with `Client`. |

Azure identifies device SDK `1.18.4` as **Active**. npm records its publication on
January 30, 2026. The coordinated GitHub release is tagged `2026-01-28`. The SDK
remains in the `azure-iot-*` package family; newer-looking `@azure/arm-iothub`,
`azure-iothub`, and `@azure/identity` serve different purposes [S1-S5, S9].

Important qualification details:

- Published device `1.18.4` and MQTT `1.16.4` still declare Node `>=14`. That is an
  install constraint, not a reason to deploy an end-of-life Node runtime.
- Device `1.18.4` pins `@azure/storage-blob` to `12.8.0`, whereas this repository
  currently locks `12.10.0` through an older caret range. Newest device SDK does
  not imply every transitive dependency is newest or free from advisories.
- Review the complete resolved tree, npm advisories, upstream fixes, and license
  inventory. Do not use `npm audit fix --force` or arbitrary transitive-major
  overrides. Record exploitability and any approved, expiring exceptions.
- Root overrides in the SDK source repository do not automatically propagate to
  applications installing its published packages. Verify the actual artifact.
- Initially pin the two direct SDK versions exactly and commit the generated
  lockfile using a pinned npm version. Use grouped, reviewed dependency-update PRs
  rather than freezing indefinitely.
- A library's `package-lock.json` does not lock its consumers' installations.
  Test both `npm ci` in this repo and a fresh install of its packed tarball.
  Production container builds should use an application-level lock and immutable
  image digest. No npm shrinkwrap or vendored SDK is proposed by default.
- The new MQTT `mqtt.forceDisconnect` option affects SAS-replacement reconnects.
  Keep the upstream default initially; compare under representative load before
  opting in. It is not a universal reconnect or delivery fix [S3, S13].

### 3.2 Initial Support Matrix

The owner has selected Node.js 22.x and Node-RED 4.x as the only supported runtime
majors for the first release. Exact patch versions still need inventory and
qualification; this scope decision is not a claim that testing has passed.

| Component | Initial qualification | Follow-on or additional qualification |
| --- | --- | --- |
| Node.js | Node 22.x only; pin the qualified patch and npm version | Node 24 is deferred to a separately approved follow-on |
| Node-RED | Node-RED 4.x only; test the selected current 4.x patch and field-used 4.x patches that must remain | Node-RED 5 is deferred; adapt only if later qualification shows a need |
| IoT Edge | Latest patched 1.6 LTS | Actual deployed 1.5 patch while still supported; no ongoing 1.5 promise beyond November 10, 2026 |
| Module platform | Linux containers on field-used, Microsoft-supported OS/CPU pairs | Test both AMD64 and ARM64 if deployed; explicitly investigate ARM32 image availability if present |

Run CI, packed-package tests, live X.509/workload tests, fault/recovery, redeploy,
soak, and canary acceptance on Node 22 with Node-RED 4. Do not add Node 24 or
Node-RED 5 jobs, compatibility shims, or support claims in this release. No Node
18/20 support is planned. Validate other installed nodes, native modules,
container images, and certificate trust when moving to Node 22; this package's
tests alone cannot qualify the entire installation.

Bound future manifest declarations to these majors: `engines.node` must have a
qualified minimum within 22.x and an upper bound `<23`; `node-red.version` must
have a qualified minimum within 4.x and an upper bound `<5`. Record the exact
minimums after dependency and field tests, rather than advertising every old
patch or borrowing the minimum from Node-RED 5. Pin the Node-RED development/test
dependency to an exact 4.x version; an unqualified `node-red@latest` would select
the wrong major. Match local tooling, CI, package metadata, and container builds.
Metadata is not a substitute for tests or a custom runtime-rejection feature.

Node 22 support ends April 30, 2027 [S17]. Schedule the Node 24 follow-on early
enough to qualify before that deadline; extending the Node.js range does not
require simultaneously adopting Node-RED 5. Node-RED 5 gets its own qualification
and adaptation decision. Current upstream Node 24 recommendations [S15] do not
override the owner's narrower initial scope.

Azure's current Edge support page lists 1.6 LTS through November 14, 2028, and
1.5 through November 10, 2026 [S14]. Do not assume the old `iotedge-1.5`
documentation query selects the latest supported product; the fetched page now
describes 1.6.

Do not upgrade every field component simultaneously. Qualify the node package,
Node/Node-RED image, and Edge host changes as distinguishable steps, with rollback
artifacts for each. Coordinate the approaching Edge 1.5 deadline separately.
If the deployed runtime cannot meet a supported target, agree on a transition
release before dropping support. Set package `engines`, Node-RED metadata, CI,
and documentation to the combinations actually tested, not an unlimited range.

## 4. Compatibility Contract

### 4.1 Preserve Unless Field Evidence Requires Otherwise

| Surface | Contract to characterize and preserve |
| --- | --- |
| npm identity | `node-red-contrib-azure-iot-edge-kpm` for the first release. |
| Serialized node types | `moduleclient`, `moduletwin`, `moduleinput`, `moduleoutput`, `modulemethod`, `device-client`, `device-twin`, subject to verification against the deployed artifact. |
| Editor schema | Existing `client`, `name`, `input`, `output`, and `method` properties; node IDs, wires, port counts, config-node references, palette appearance, and help/templates. |
| Device X.509 configuration | Existing `IOTEDGE_IOTHUBHOSTNAME`, `IOTEDGE_DEVICEID`, `PATH_TO_CERTIFICATE_FILE`, `PATH_TO_KEY_FILE` continue to work without flow edits. |
| Twin desired output | `{ payload: delta, topic: "desired" }`, including initial desired-state delivery and later patches. Preserve Azure metadata within the delta. |
| Twin reported input | Object payload or JSON-text payload; no new acknowledgement output port. Preserve deletion/null semantics supported by Azure twins. |
| Module input | Exact configured input-name match; parsed JSON payload; `topic: "input"` and `input: inputName`. |
| Module output | Configured output name, existing fallback if used; JSON encoding, `application/json`, `utf-8`. A string payload means JSON text, not arbitrary text. |
| Method request | Existing `payload`, `topic: "method"`, `method`; any new correlation property is additive but may need to survive a flow that constructs a replacement message. |
| Method response | Existing `msg.status` and `msg.payload`; characterize actual cloud-visible encoding before changing it. |
| Status/error integration | Test flows using Status and Catch nodes, not just Debug output. Retain familiar statuses where truthful; document corrected transitions and message completion. |

Capture sanitized real flow exports and cloud-observed message fixtures. The
bundled example is useful but not sufficient: its response function assigns a
property to a string and uses status `100`. Preserve the original as a fixture;
publish a corrected example separately after the contract is agreed.

Do not add aliases for the unfinished `iot-edge-module-*` names or the
`azure-iot-edge-config` schema unless an actual deployed flow uses them. Existing
persisted flows justify compatibility code; hypothetical consumers do not.

### 4.2 Changes That Need Explicit Approval

- Emitting valid JSON `false`, `0`, `""`, and `null` instead of silently dropping
  them on module input; preserving falsy direct-method request payloads.
- Correcting pre-stringified direct-method responses to native JSON values.
  This changes the cloud-visible JSON type and can break callers parsing twice.
- Requiring a method request correlation field for safe concurrent/late response
  handling. Fully reliable correlation cannot be inferred from method name alone.
- Reporting malformed payloads and disconnected/overloaded sends through
  `done(error)` rather than ignoring, throwing, or silently dropping them.
- New finite operation/admission limits and explicit method timeout responses.
- Any environment-precedence change, removal of an actually used authentication
  fallback, raised runtime minimum, or eventual npm package split.

Prefer a clearly documented `1.0.0` modernization release, preceded by
`1.0.0-beta.N`, if these changes or runtime minimums are adopted. Final versioning
depends on the baseline and approved compatibility scope. Do not label a breaking
release as a patch because the upstream SDK changes are patches.

## 5. Authentication And Certificate Design

### 5.1 Minimal Authentication Matrix

| Scenario | Implementation direction | Commitment |
| --- | --- | --- |
| Direct device identity using X.509 | `Client.fromConnectionString("HostName=...;DeviceId=...;x509=true", Mqtt)`; await `setOptions({cert, key})`, then `open()` | Required, first-class; preserve existing deployment variables and PEM file mounts. |
| Node-RED as an Edge module | `ModuleClient.fromEnvironment(Mqtt)` with Edge-injected environment, workload API, and SDK-managed trust/SAS renewal | Required, including on X.509-provisioned Edge hosts. |
| Direct device identity using symmetric key | Explicit device-scoped `SharedAccessKey` connection string; SDK manages token creation/renewal | Optional follow-up, only if wanted; no new production SDK dependency. Do not delay required X.509/workload qualification for this. |
| Existing module environment connection-string fallback | SDK recognizes `EdgeHubConnectionString` before `IotHubConnectionString` before workload | Inventory first. Preserve/test if used; otherwise document workload-only scope and reject conflicting overrides rather than silently switch identity. Approval required for a behavior change. |
| Application-level DPS, TPM/HSM, custom token plugins, manually supplied expiring SAS | Separate provisioning/security lifecycle | Defer; Edge host provisioning remains external and supported. |
| Microsoft Entra/managed identity for device operations | IoT Hub device APIs do not support it | Do not offer it. Entra is appropriate for separate service-side test/admin tooling [S9]. |
| Standalone module X.509 | This Node SDK's module connection-string factory rejects X.509 | Do not add it or confuse it with device X.509/Edge host provisioning [S11]. |

An X.509-provisioned Edge host uses its certificate for identity operations; its
modules normally authenticate with runtime-managed SAS material. The application
must not be given the device private key simply to operate as a module [S7].

If optional device connection strings are added, store them as Node-RED password
credentials, not ordinary editor properties. Accept device-scoped identities,
not hub-wide service policy keys; test export redaction and SDK token renewal.

The current device client connects directly to IoT Hub as the device identity.
It does not use the workload API or an Edge gateway hostname. Preserve that
topology. Do not silently turn it into a downstream gateway client or a module
twin client. Check whether any other process already connects under the same
device identity, since competing sessions can affect connectivity.

### 5.2 X.509 Handling

1. Resolve and validate configuration only when a device config node is created.
   Module-only flows must register and deploy with no device certificate access.
2. Keep existing environment defaults. If explicit per-config identity/path
   fields are needed for actual multi-device deployments, define explicit value
   over environment precedence and preserve the no-field legacy behavior.
3. Read files asynchronously per new client lifecycle; keep full PEM chain
   contents. Validate nonempty hostname/device ID, readable certificate/key,
   parseable PEM, matching key/certificate, and validity dates using Node's
   built-in crypto/TLS facilities rather than a new crypto dependency.
4. Match IoT Hub's thumbprint versus CA-signed identity requirements, including
   chain and CN/device-ID rules where applicable [S6]. Do not impose an unrelated
   certificate policy that rejects valid field credentials.
5. Attach applicable error handlers, await successful `setOptions`, then open.
   Classify missing configuration, permissions, invalid certificate, TLS trust,
   clock skew, DNS/network, and hub authorization failures distinctly where the
   SDK exposes enough information. Never fall back from failed X.509 to SAS.
6. Keep certificate/private-key contents out of flows, node context, logs, and
   fixtures. Use read-only mounts, least-privilege file permissions and container
   user, and protect Node-RED's user directory and credential encryption secret.
7. If encrypted keys are needed, add the SDK's optional `passphrase` through a
   password credential, with export/redaction tests. Otherwise give a clear
   unsupported-key error rather than adding a secret-management integration.
8. Rotate externally: install a consistent certificate/key pair atomically,
   arrange hub trust/primary-secondary thumbprint overlap as appropriate, and
   recreate the owning config client through a documented redeploy or restart.
   A normal child-only redeploy may leave the config client alive; test and name
   the required deployment action. Environment changes generally need a process
   or container restart. No file watcher or automatic issuer integration in v1.
9. Warn on impending expiry using an agreed threshold, proposed 30 days, without
   exposing sensitive contents. Test rotation, expired/not-yet-valid certificates,
   mismatches, unreadable mounts, old CA bundles, and time synchronization.

Client certificate/key authentication and server CA trust are separate. Preserve
the SDK's workload trust bundle for module connections. For direct IoT Hub,
validate the actual Node/container trust configuration against Azure's current
guidance: DigiCert Global Root G2 and Microsoft RSA Root CA 2017 [S8]. Do not
assume the host OS store automatically configures Node's TLS trust. Never disable
hostname/certificate verification or pin leaf/intermediate server certificates.
Keep supported classic endpoints/TLS 1.2; TLS 1.3 endpoints and Microsoft-backed
certificate-management SDK features are previews, not part of this reliability
release. The latter has no Node.js implementation listed in current guidance [S5].

Downstream gateway X.509 is a separate future feature. The inspected release's
device connection-string X.509 path does not preserve `GatewayHostName` in its
provider construction; generic gateway documentation is not enough to promise
that combination without a targeted SDK/API spike and live test [S10].

### 5.3 Edge Workload Reliability

Validate the full required Edge environment, not only `IOTEDGE_WORKLOADURI`:
`IOTEDGE_DEVICEID`, `IOTEDGE_MODULEID`, `IOTEDGE_MODULEGENERATIONID`,
`IOTEDGE_IOTHUBHOSTNAME`, and `IOTEDGE_AUTHSCHEME` (`sasToken`), plus correct
workload socket access, gateway DNS, routes, and trust bundle. Leave signing,
token renewal, and trust retrieval to the SDK [S11].

Default SDK token lifetime is one hour with renewal 15 minutes before expiry.
Test sustained traffic across many approximately 45-minute renewals. Do not add
an application SAS timer or export runtime signing keys.

Source inspection identified a release-blocking question: a workload signing
failure during timer-driven renewal can emit an authentication-provider `error`
without scheduling another renewal; the inspected MQTT path does not appear to
forward that provider error to the client. A client `error` handler alone must
not be assumed sufficient [S12-S13]. Reproduce against the exact published SDK
with an unavailable workload socket at renewal in a subprocess test and on Edge.
If confirmed, prefer an upstream fix/release. Any minimal public-API workaround
must retain SDK trust/signing behavior and be separately reviewed and tested.
Do not reach into private fields, monkey-patch the SDK, or swallow process-wide
uncaught exceptions to claim reliability. If no acceptable recovery exists,
block release and present the tradeoff for approval.

## 6. Packaging And JavaScript Architecture

### 6.1 Keep One Package Initially

| Choice | Benefit | Cost/risk | Recommendation |
| --- | --- | --- | --- |
| Combined npm package, separate internals | No install/flow migration; one release and rollback; most reliability benefits still possible | Users still install both node sets and the shared SDK family | First release. |
| Two independent packages | Clear scope/docs; independent installation and eventual release cadence | Package migration, duplicate type conflicts, two release matrices, possible drift in shared logic | Optional second milestone, after canary success. |
| Two packages plus compatibility umbrella/shared runtime package | Potential installation continuity/code reuse | Three or more artifacts, discovery behavior, version coupling, compatibility maintenance | Do not introduce without a demonstrated need and package-discovery prototype. |

Both clients already come from the same Azure device package, so splitting does
not remove that shared dependency. The immediate operational problem is eager
credential loading and shared state, not the npm boundary. Two packages inside
one Node-RED process are not a credential/security isolation boundary.

Retain distinct existing device and module config nodes. Each owns its client,
readiness, associated twin, reconnect supervision, and consumer registrations.
Keep identity creation separate; share a small lifecycle helper only if it
demonstrably removes duplicated tested behavior. No universal authentication
framework, transport plugin system, inheritance hierarchy, ESM conversion,
transpilation, or TypeScript migration is proposed. Use brief JSDoc where it
clarifies the config/message contracts and a consistent minimal ESLint setup.

File-level direction: preserve existing JS/HTML entry points; implement most
changes there first. Add internal `lib/` files only for genuinely shared or
separately testable logic. Remove or replace the unfinished shared config file
after establishing that it is not a shipped public contract. Avoid unrelated
file moves/formatting in functional commits.

### 6.2 Optional Later Split

If independent installs/releases remain valuable after qualification:

1. Choose available scoped npm names with the owner, following current Node-RED
   guidance for new packages; do not preemptively rename this
   package. Keep the repo together initially with two package directories if that
   is the smallest maintainable arrangement.
2. Device package owns `device-client` and `device-twin`; module package owns the
   five established module types. Preserve serialized types and `client` fields.
3. Give each runtime entry its sibling HTML, icons, docs, examples, manifest,
   accurate engines, and MIT attribution. Keep both existing copyright notices.
4. Use exactly one installed owner for each type. Do not have the old combined
   package register the same types alongside the new packages. Test both new
   packages together as well as individually.
5. Document backup, stop Node-RED, remove old package, install the selected new
   package(s), verify unchanged flow references, then restart. Prefer baking this
   into an immutable replacement image rather than interactive field npm changes.
6. Rehearse rollback to the old image and flow/credential snapshot. Publish the
   split through its own prerelease/canary cycle. Only build an umbrella if actual
   Node-RED discovery tests establish that it works without duplicate registration.

## 7. Lifecycle And Messaging Design

### 7.1 Connection Ownership

- Use ordinary constructors that synchronously create the node and register
  input/close handlers. Start caught async initialization afterward.
- Resolve the child's config using `RED.nodes.getNode(config.client)`. No global
  client/twin cache and no busy-wait loops checking a global variable.
- One in-flight connect promise per owner. Children wait for the same readiness
  result; a failed attempt rejects and is cleaned up, not converted into `null`.
- Verify promise/callback signatures in the selected published SDK. Use native
  promise overloads where available; explicitly wrap callback-only operations so
  callback errors reject. Do not mix completion styles or assume `await` turns a
  callback-based return value into operation completion. Test delayed/failed
  `setOptions` before `open`, and delayed send/update completion before `done`.
- Distinguish idle/connecting/ready/recovering/closing/closed states. Obtain a twin
  lazily for twin consumers so a twin failure need not disable routed messaging.
- Characterize initial desired-state delivery when a twin child attaches after
  the shared twin is ready, including child-only redeploy. Use the SDK's public
  desired-properties subscription behavior where it meets the baseline; do not
  add a manual snapshot that duplicates its initial emission. Test a patch racing
  attachment for ordering, gaps, and duplicate initialization. If sharing an
  application dispatcher, explicitly preserve this late-subscriber contract.
- Guard asynchronous continuations with an owner generation/closing flag. A
  client created after close begins must be disposed of, not attached to old nodes.
- Attach client/twin errors and owned event listeners once per instance. Detach
  only owned listeners when a child closes; close the SDK client when its config
  owner closes. Never remove SDK internals with blanket `removeAllListeners()`.
- Register cleanup before initialization. Close is idempotent and completes the
  Node-RED close callback exactly once even on partial startup or close failure.
  Bound shutdown below the configured Node-RED timeout and record unresolved
  operations. A timed-out wait does not mean the underlying SDK work was cancelled.
- Treat SDK `close()` as terminal: create a new client for a new lifecycle rather
  than reopening a closed object. Clear owned timers, pending registrations, and
  readiness waiters; prevent output/status updates from closed generations.
- Prevent multiple simultaneous clients for the same module identity. The
  documented one-module-client usage remains supported; do not silently promise
  multiple module identities from one process environment. Test separate device
  configs for state isolation if that capability is retained.

### 7.2 Retry, Admission, And Delivery

Use Azure's exponential-backoff-with-jitter retry behavior for SDK operations.
Add one owner-level jittered supervisor for failed startup or exhausted recovery,
not a second loop around every SDK operation [S18]. Local invalid configuration
should fail clearly; transient outages should recover without redeploy. Bound
retry frequency and redact/rate-limit repeated errors.

The inspected SDK has an approximately four-minute operation retry budget, not a
hard cancellation deadline. Recovery is feature-driven; `disconnect` is not an
exhaustive indication of every transport interruption, and may carry a
`Disconnected` result with an underlying `transportObj`. First-connect failures
can be wrapped in a generic error whose text misleadingly says "Not authorized".
Do not infer permanently invalid credentials from that text alone [S13, S18].

Register Node-RED input handlers immediately. Proposed v1 admission policy:
bounded pending work while connecting/recovering, with explicit count, byte, and
age limits established from measured field throughput in Phase 0. Record exact
defaults before implementation approval; use finite conservative test values in
the harness. Expired/rejected work calls `done(error)` once with the originating
message, never disappears silently. No persistent local spool is added.

Await actual `sendOutputEvent`/reported-update completion. Do not signal success
on queue admission. Preserve FIFO dispatch for each output's accepted work where
required by the baseline, while recognizing Azure does not guarantee universal
end-to-end ordering. Bound in-flight work, test burst capacity, and document
shutdown treatment of pending versus already-submitted operations.

Never re-submit a timed-out operation just because the wrapper stopped waiting:
it might still complete and duplicate a side effect. Generation guards prevent
stale callbacks but do not cancel network I/O. Application timeouts must lead to
an explicit uncertain outcome and coordinated cleanup/recovery, not concurrent
duplicate operations.

MQTT input completion is automatic; the SDK's `complete()` is effectively a
no-op on this transport. Removing redundant calls or moving one after parsing
cannot provide downstream acknowledgement or redelivery guarantees [S13]. Edge
store-and-forward only covers messages accepted by Edge Hub and depends on its
routes/storage/TTL. This wrapper does not promise durable queuing, exactly-once
delivery, or transactionally acknowledged downstream Node-RED processing.

### 7.3 Payload And Error Handling

Catch JSON parse/serialization errors at the operation boundary. Validate twin
patches and method status/payload against the documented Azure contract without
arbitrarily narrowing established valid inputs. Test objects, JSON text, arrays,
scalars, null, buffers, undefined, circular objects, and Azure size limits.
Malformed input must leave the node able to process subsequent valid messages.

For incoming SDK events, use `node.error(error, relevantMessage)` where safe and
meaningful; for Node-RED input operations use `done(error)` once. Avoid duplicate
Catch emissions from both mechanisms. Do not log whole payloads by default.
Statuses should reflect observed readiness/errors, not just the last operation;
document that SDK events cannot provide perfect transport-state telemetry.

### 7.4 Direct Methods: Explicit Compatibility Decision

Use one stable SDK method dispatcher per method per client lifetime, with an
application-owned registry of active Node-RED consumers. The SDK rejects duplicate
method registration and exposes no matching public removal API [S19]. Reject
duplicate active handlers clearly; child redeploy changes the registry, not the
SDK registration. An inactive dispatcher returns an explicit unavailable response.
Bound retained registrations, including inactive names from renamed/deleted nodes.
At the agreed limit, perform a controlled owner-client replacement through the
same drain/cleanup/readiness path, then register only active methods. Do not
accumulate inactive dispatchers indefinitely or reset a client on every child
redeploy. Test repeated method rename/delete cycles as well as unchanged names.

Recommended safe response contract, subject to approval:

1. Emit the existing request fields plus a unique `msg.requestId` tied to this
   client generation and SDK response object. Reserve/document that field.
2. Require response input to preserve `requestId`, `status`, and `payload`.
   This works with flows forwarding the received message, but flows constructing
   a new message must copy the ID explicitly. Update examples and migration docs.
3. Keep a bounded per-owner request map. Validate status and payload; atomically
   complete each request once. Reject unknown, expired, duplicate, cross-node,
   and previous-generation IDs. Bind each request to the originating child
   instance, not just its serialized node ID or config-client generation. On
   child close, terminate its pending requests once with the approved unavailable
   response where possible and clear their timers/map entries. A replacement
   child with the same node ID cannot answer an old request. Never match only on
   method name.
4. Use a finite configurable response timeout aligned below the caller's method
   timeout, proposed 25 seconds with a documented caller timeout of at least 30
   seconds. Confirm field latency requirements first. Return one explicit timeout
   status (proposed `504`); on shutdown/unavailable handler use `503`. Clean the
   map on every terminal path.
5. Send native JSON-compatible response values rather than JSON-stringifying an
   object before `response.send`. Decide separately whether existing response
   strings are literal strings or documented JSON text; use field wire fixtures.
6. Catch async handler failures locally. The SDK does not await a returned handler
   promise, and its response is one-shot even if transport sending fails. Do not
   retry the same response object or automatically replay a side-effecting command.

If unchanged legacy method flows are mandatory, do not pretend that a
single-flight method-name fallback solves stale/late/duplicate response ambiguity.
It cannot prove which invocation an uncorrelated message answers. Either defer
the method-contract change and explicitly accept that residual limitation for a
bounded compatibility release, or approve the small correlation-field migration
before stable release. A legacy encoding/response mode is justified only by
actual field callers; it must have its own tests, limits, documented risks, and
retirement decision. No speculative dual-mode framework is proposed.

## 8. Implementation Phases And Exit Gates

No phase below begins without approval to implement. Keep functional changes,
dependency changes, and mechanical formatting separate for review and bisection.

| Phase | Work and deliverables | Exit gate |
| --- | --- | --- |
| 0. Field baseline and decisions | Identify deployed image/package/source SHA and resolved dependency tree; record Node/npm/Node-RED/Edge/OS/CPU; sanitize flows and wire fixtures; inventory auth, topology, traffic, outages, Status/Catch usage, and method callers; capture rollback image and credentials/config backup procedure. | Owner signs off the compatibility contract, support targets, method policy, admission limits, and exact known-good rollback artifact. Do not assume either local tag or HEAD is that artifact. |
| 1. Test foundation | Add plain-JS lint/tests, Node-RED test helper, deterministic SDK fakes, failure injection, structural JS/HTML/manifest checks, and baseline contract fixtures. Test current defects explicitly without blessing them as desired behavior. Add PR CI; publishing remains disabled during development. | Baseline behavior has executable assertions; known HEAD failures are identified; actual Node-RED construction detects async constructors and missing config registration. |
| 2. Minimal loading/ownership repair | Reconcile runtime/editor with proven types and `client` refs; ordinary constructors; lazy device credentials; per-config ownership/readiness; early cleanup/error handlers. Remove unreachable incomplete design only after baseline evidence. Keep old locked SDK for comparison where feasible. | Existing flow fixtures import/deploy/export without unintended changes; module-only startup needs no certificate files; isolation and partial-startup/redeploy tests pass. |
| 3. SDK and platform qualification | Upgrade device/MQTT together; remove unused AMQP; regenerate lock with chosen npm; restrict engines to Node 22 and Node-RED 4; review changelogs/tree/advisories; pack/install test; run the exact-SDK renewal/reconnect spike early. Compare repaired code with old versus new SDK where technically possible. | Required X.509/workload paths connect on qualified Node 22/Node-RED 4 patches; no unexplained dependency changes; renewal-failure risk resolved or release blocked. |
| 4. Reliability hardening | Complete supervisor, bounded operation admission, real send completion, owned listener cleanup, twin readiness, shutdown guards, JSON/error handling, and approved method changes. Add only proven reusable JS helpers. | Deterministic lifecycle/fault tests pass; no unresolved response-correlation decision; public changes have migration tests and release notes. |
| 5. Live Azure acceptance | Run isolated IoT Hub/Edge deployment with asserted routes, real X.509 device twin, workload module messages/twin/methods, network/workload faults, trust/rotation, load and soak. Optional symmetric-key auth is a separate change if approved. | Acceptance matrix below passes with captured evidence on actual deployment architecture(s). No claim of reliability based on mocks alone. |
| 6. Release candidate and canary | Finalize docs/examples, package contents, security/release workflow, exact artifact checksums and dependency inventory; publish only on explicit authorization to a prerelease dist-tag; deploy lab then small representative field cohort. | At least 72-hour lab soak and proposed 7-day canary pass; rollback rehearsed; owner approves promotion. |
| 7. Stable rollout and maintenance | Promote the tested artifact/version through approved rings; freeze dependencies during rollout; monitor metrics; set monthly update triage and urgent security path. | Acceptance remains within approved baseline; no blocking incident; operational owner accepts handover. |
| 8. Optional package split | Execute section 6.2 only if independent installations/releases justify it. | Independent/combined install, migration, duplicate-registration prevention, and rollback tests pass through another canary cycle. |

Do not estimate a calendar completion date until field access, runtime migration,
method-contract decisions, and any upstream SDK blocker are understood. The
72-hour soak and 7-day canary are elapsed-time gates, not development estimates.

### Developer Execution Checklist

These are implementation-phase deliverables, not commands or test files that
already exist. Keep the handoff small and executable rather than adding a new
framework or a parallel set of design documents.

1. Record the exact baseline artifact and candidate Node 22, npm, Node-RED 4,
   SDK, Edge, and container versions in a sanitized qualification record. Include
   fixture provenance and the tested patch minimums used in package metadata.
2. Maintain a short decision ledger alongside the tests: behavior/question,
   field evidence, approved outcome or unresolved status, owner, regression test,
   and phase that it blocks. In particular, do not guess method wire encoding,
   correlation policy, environment precedence, or queue/shutdown limits. Resolved
   Node 22/Node-RED 4 scope is not an open decision. An unresolved policy blocks
   its implementation, not unrelated approved test-foundation work.
3. Separate historical characterization from target-behavior regression tests.
   For a known checkout defect, record the failing assertion and repair phase;
   do not assert that the defect is correct behavior. Any temporary expected
   failure must be explicit, tracked, and removed in its repair phase. No skipped
   or expected-failing required acceptance cases may remain at release.
4. Add documented scripts with clear boundaries: `npm run lint` for JS/editor
   checks, `npm test` for deterministic offline unit and Node-RED runtime tests,
   `npm run test:package` for real tarball discovery/installation, and
   `npm run test:azure` for explicitly invoked live acceptance. A clean Node 22
   checkout should run the offline gates after `npm ci` without Azure credentials.
   Pin Node-RED 4 in package-test temporary installations as well as dev tooling.
   An explicitly requested live test must fail clearly on missing prerequisites,
   not silently skip and report success.
5. Keep tests isolated: fresh config/client instances, restored environment and
   SDK stubs, awaited helper unload/stop, and cleaned-up timers/resources. Generate
   disposable certificate/key material outside tracked fixtures. Use controlled
   events/fake time for race tests rather than arbitrary sleeps, and subprocesses
   for potentially fatal SDK error paths. Do not use fake time as evidence that
   real token renewals work; that remains a live soak gate.
6. Each functional change should identify its contract/decision, include the
   regression test, state which commands passed, and name any untested live
   requirement. Keep published-SDK behavior tests distinct from wrapper fakes so
   a permissive mock cannot conceal an API or lifecycle mismatch.

## 9. Verification Matrix

Use `node-red-node-test-helper` with a compatible JavaScript test runner, proposed
Mocha and Node assertions; add fake timers only where needed. Do not mock away
Node-RED construction or assume helper loading proves manifest discovery.

| Layer | Required cases | Passing evidence |
| --- | --- | --- |
| Runtime scope | Node 22 with qualified Node-RED 4 patches; major-bounded manifest metadata, pinned local/CI/test-install versions | No accidental Node-RED 5 resolution, Node 24 requirement, or unsupported-major claim. |
| Static/structural | Undefined variables, syntax, manifest runtime/HTML pairs, matching runtime/editor/template/help types, config references, example JSON/functions, package allowlist | PR jobs catch the current registration/configuration defects without Azure access. |
| Real Node-RED | Load actual packed package through discovery; instantiate every node; import/export/reimport sanitized field and bundled flows; verify config persistence, ports, wires, Catch/Status/Complete behavior | No unknown nodes, silently lost fields, duplicated registrations, or unexpected flow rewrite. |
| Client lifecycle | Concurrent child startup; factory/options/open/twin errors; close at each await; delayed/rejected/hung close; partial/full redeploy; reconnect exhaustion and later recovery; multiple configs | One client attempt/owner; exact-once completion/cleanup; no stale output; listener/owned timer/request counts return to baseline. |
| Device X.509 | Existing env-only flow; CA chain and thumbprint mode as deployed; missing/malformed/mismatched/expired/not-yet-valid credentials; wrong identity; encrypted key if supported; read permissions; trust/clock failures; rotation | Required field certificate form works; negative cases do not crash unrelated nodes or weaken TLS; new certificate is loaded after documented recreation. |
| Module workload | Required/missing env; socket unavailable initially and at renewal; trust retrieval failure; gateway DNS/trust; EdgeHub restart; token rollover under load; connection-string precedence if retained | Recovers without manual flow redeploy; no process-level unhandled provider errors; signing material never enters flow exports/logs. |
| Twins | Initial desired snapshot, late child attachment/redeploy with a racing patch, later patches, metadata, null deletion, object/JSON text reports, malformed and oversized reports, reconnect/resubscribe, multiple consumers | Expected payload contract; no gaps or duplicate initialization from wrapper subscription handling; actual reported updates verified in IoT Hub. |
| Routed messaging | Matching/nonmatching inputs, several consumers, falsy JSON, malformed input, output encoding/name, delayed/failed send, bursts, overload, close mid-send | SDK completion governs `done`; bounded memory/pending work; no silent parser failure or claims of manual MQTT settlement. |
| Direct methods | Object/scalar/null wire payloads, two concurrent same-name requests, reversed responses, late/duplicate/unknown responses, timeout, no consumer, child replacement with the same node ID, method rename/delete cycles, cross-client isolation | Approved wire contract; correlated mode never answers the wrong request; no leaks or duplicate sends; any legacy limitation separately approved. |
| Dependency/artifact | Locked `npm ci`; fresh consumer tarball install; engines; full dependency tree; advisory/license scan; secret/package-content check | Both resolution modes pass; production lock/image digest captured; no unexplained high/critical production advisory without explicit risk acceptance. |
| Long-running operation | Sustained normal rate and representative burst rate; repeated token renewals, fault/recovery and 100 child redeploy cycles; target CPU/RAM limits | No process crash/unhandled rejection/listener warnings; no accumulating owned resources or sustained post-warmup memory growth. |
| Rollback | Candidate image/flow/config changes rolled back under an induced failure | Previous image and protected flow/credential/config snapshot restore service; no cloud identity re-creation required. |

### Live Environment And Measurements

- Use an isolated test resource group/IoT Hub with device and module twin/direct
  method features available, a real supported Edge host, and workload-matched
  routes. An in-memory mock or generic MQTT broker is not an Edge/IoT Hub emulator.
- Provision disposable test identities and certificates. Keep private keys and
  hub credentials out of git, test output, uploaded artifacts, and fork PR jobs.
  Prefer least-privilege, short-lived service-side CI access; use approved secret
  storage for device credentials. Set resource budgets, cleanup, and retention.
- Test module-only, device-only, and both node sets in the same Node-RED instance.
  Test actual deployed CPU architectures and container base/TLS store, not only
  a macOS development runtime or an AMD64 CI runner.
- Cover offline boot, short and prolonged network loss, DNS failure, throttling,
  EdgeHub/workload restarts, and return to connectivity. Agree recovery SLOs from
  the baseline, with a proposed target of recovery within five minutes after
  infrastructure is healthy, without an operator redeploy.
- Run a minimum 72-hour soak, including many real SAS renewals; use sequence IDs
  in test traffic to distinguish SDK-accepted, downstream-observed, rejected,
  duplicated, and uncertain messages. Do not equate send success with final
  downstream delivery or hide uncertain outcomes in a success count.
- Capture throughput, p50/p95/p99 latency, loss/duplicates, reconnect duration,
  CPU/RSS/heap, pending counts/bytes, listener counts, method timeouts, and errors.
  Establish numerical limits from the field baseline before the run. Proposed
  starting tolerance: no more than 10% regression in steady-state throughput or
  p95 latency at the same load; agree memory ceilings for the smallest target.
- Require zero crashes, unhandled rejections, credential leaks, wrong-request
  responses in correlated mode, and unbounded resource growth. Every timeout,
  overflow, rejected message, and uncertain operation must be observable. Under
  fault-free controlled traffic, account for all expected messages; under faults,
  classify loss/duplicates against the actual transport/Edge guarantees.
- Store a test report with artifact digest, exact runtime/SDK/Edge versions,
  architecture, sanitized config, load/fault schedule, metrics, and exceptions.
  Qualification claims apply only to those tested combinations.

## 10. Release, Rollback, And Operations

Modernize CI only after the test commands exist: PR/push lint/unit/Node-RED tests,
the Node 22/Node-RED 4 patch matrix, packed artifact installation, and separate gated live
Azure jobs. Use maintained GitHub actions, minimal permissions, pinned tooling,
and immutable action references where practical. Verify release tag matches
package version and publish the tested artifact, not an unverified rebuild.

Use npm trusted publishing/provenance if supported by the publishing setup;
otherwise use a tightly scoped, protected publish credential. Release environment
approval, prerelease dist-tag selection, and prevention of concurrent accidental
publishes are explicit gates. Nothing in this plan authorizes publishing.

Before canary rollout, retain the known-good image by digest and securely back up
flows, encrypted credentials, Node-RED settings/credential secret, environment,
certificate references, Edge deployment manifest, and application lockfile.
Never put those secrets in this document or repository.

Deploy lab, then a few representative devices, then approved percentage rings,
proposed 5%, 25%, and 100% only where fleet size makes that meaningful. Observe
the initial canary for at least seven days and subsequent rings for an agreed
period spanning several renewal cycles. Do not run old and new clients
simultaneously under the same identity as a naive shadow test: that can cause
session contention and duplicated processing. Use distinct test identities for
parallel comparisons or replay sanitized traffic offline.

Stop promotion on a crash, certificate/authentication regression, method
miscorrelation, sustained memory growth, recovery-SLO failure, material data
loss/latency regression, or unexplained credential exposure. Roll back using the
old immutable image and matching flow/config snapshot, not `npm install latest`
on a remote device. Preserve diagnostic evidence without credentials. Coordinate
certificate overlap so both the rollback image and new image can authenticate;
rollback must not undo a necessary credential revocation.

After release, document support windows, monthly dependency review, security
triage ownership, and required regression/live tests for SDK or runtime changes.
Track Node 22 and Edge 1.5 retirement explicitly. Avoid automatically merging
Azure updates solely because they are patch releases.

Required user-facing documentation before release:

- Supported Node/Node-RED/Edge/OS/CPU combinations and upgrade prerequisites.
- Node/message contracts, intentional bug fixes, method correlation/encoding
  migration if adopted, admission limits, error/status/completion behavior.
- Device versus module identity diagram; complete environment/credential
  precedence; direct-hub versus Edge routing and store-and-forward boundaries.
- X.509 thumbprint/CA setup, PEM chain/key mounts, least privilege, trust store,
  expiry/rotation/restart runbook, clock synchronization, redacted diagnostics.
- Corrected module example and an added device-X.509 twin example; no real keys.
- Installation, prerelease/canary, immutable artifact backup, rollback, and
  troubleshooting instructions. Preserve MIT licensing and attribution.

## 11. Decisions Needed Before Implementation

| Decision/question | Recommended default |
| --- | --- |
| What exact artifact and runtimes are deployed, and can sanitized flows/wire examples be captured? | Mandatory Phase 0 input; do not infer from package version alone. |
| Are both direct device-twin X.509 and module workload paths used? Are certificates thumbprint-registered or CA-signed? Any gateway, sovereign cloud, encrypted key, or competing identity clients? | Preserve both current paths; qualify actual certificate/topology variants first. |
| Must installation remain a single package? | Keep it combined for v1, separate internally; decide on split after field acceptance. |
| Which optional authentication is worth maintaining? | Workload and device X.509 required; device symmetric-key connection string only as a small separately tested follow-up. Inventory existing module environment overrides before removing them. |
| Can direct-method flows preserve a request ID, and do cloud callers expect JSON strings or objects? | Prefer safe correlation and correct JSON in a documented major release. Do not silently change wire behavior or promise safe uncorrelated concurrency. |
| What throughput, burst size, offline duration, message age, ordering and loss requirements, method latency, and device memory limits apply? | Use them to fix finite admission/concurrency/shutdown limits and measurable SLOs before coding that policy. Durable exactly-once processing is a separate project if required. |
| Which exact Node 22 and Node-RED 4 patches will be qualified, and which deployed 4.x patches must remain? Can Edge move to 1.6? | Runtime majors are decided: Node 22 and Node-RED 4 only for this release. Node 24 and Node-RED 5 are separate follow-ons, not prerequisites. Inventory patches and qualify the whole installation. Coordinate Edge 1.5 retirement before November 10, 2026. |
| Who owns Azure test access, security exceptions, rollout monitoring, and rollback approval? | Assign named owners before live tests or release; require explicit signoff on unresolved SDK risks. |

## 12. Source Register

All sources below were consulted on September 8, 2026. Mutable documentation,
dist-tags, support dates, and advisories must be rechecked at implementation and
release time. Version-tagged source and published artifacts take precedence over
unversioned `main` for exact package behavior; documentation is not a substitute
for live qualification.

| ID | Resource | Use in this plan |
| --- | --- | --- |
| S1 | [Official Azure IoT Node SDK](https://github.com/Azure/azure-iot-sdk-node) | Active release table, package families, platform guidance, JavaScript samples. |
| S2 | [Device npm metadata](https://registry.npmjs.org/azure-iot-device/latest), [MQTT 1.16.4 metadata](https://registry.npmjs.org/azure-iot-device-mqtt/1.16.4), [AMQP metadata](https://registry.npmjs.org/azure-iot-device-amqp/latest) | Published versions, engines, dependencies; independently checked using `npm view`. |
| S3 | [Azure SDK release 2026-01-28](https://github.com/Azure/azure-iot-sdk-node/releases/tag/2026-01-28) | Coordinated release notes and force-disconnect option. |
| S4 | [Azure SDK releases](https://github.com/Azure/azure-iot-sdk-node/releases) | Intervening changes; distinguish older close-hang/storage fixes from current release. |
| S5 | [Azure IoT SDK catalog and lifecycle](https://learn.microsoft.com/en-us/azure/iot-hub/iot-sdks) | Device versus service/management/provisioning SDKs, active/preview policy, certificate-management preview availability. The older lifecycle URL redirects here. |
| S6 | [IoT Hub X.509 authentication](https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-x509) | Thumbprint/CA identities and certificate-chain requirements. |
| S7 | [IoT Edge certificate roles](https://learn.microsoft.com/en-us/azure/iot-edge/iot-edge-certs#certificate-use-for-module-identity-operations) | Host X.509 provisioning versus module runtime-managed SAS authentication. |
| S8 | [IoT Hub TLS support](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-tls-support) | Current CA roots, TLS/cipher requirements, pinning guidance, optional preview endpoints. |
| S9 | [IoT Hub Microsoft Entra authentication](https://learn.microsoft.com/en-us/azure/iot-hub/authenticate-authorize-azure-ad) | Entra is not supported for device APIs. |
| S10 | [Official CommonJS X.509 example](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/device/samples/javascript/simple_sample_device_x509.js), [device factory](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/device/core/src/device_client.ts) | Certificate/key options, public device construction, gateway caveat. |
| S11 | [Published module client 1.18.4](https://unpkg.com/azure-iot-device@1.18.4/dist/module_client.js) | `fromEnvironment`, environment precedence, trust bundle, module X.509 restriction. |
| S12 | [Published workload provider](https://unpkg.com/azure-iot-device@1.18.4/dist/iotedge_authentication_provider.js), [SAS renewal provider](https://unpkg.com/azure-iot-device@1.18.4/dist/sak_authentication_provider.js) | Workload signing, renewal cadence/error-path risk. These are published Microsoft package files served by a third-party CDN. |
| S13 | [Versioned MQTT transport](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/device/transport/mqtt/src/mqtt.ts), [MQTT base](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/common/transport/mqtt/src/mqtt_base.ts) | Reconnect/renewal, automatic MQTT completion, first-connect error behavior. |
| S14 | [IoT Edge supported platforms/releases](https://learn.microsoft.com/en-us/azure/iot-edge/support) | Edge 1.6/1.5 support dates, Linux platforms and CPU qualification. |
| S15 | [Node-RED supported Node versions](https://nodered.org/docs/faq/node-versions) | Node 24 recommendation and Node-RED version minimums. |
| S16 | [Node-RED npm metadata](https://registry.npmjs.org/node-red/latest) | Research-only observation: latest was Node-RED `5.0.7`, requiring Node `22.9`. Not an initial support target; select and pin 4.x explicitly. |
| S17 | [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) | Current/LTS/end-of-life dates. |
| S18 | [Azure reconnection guidance](https://learn.microsoft.com/en-us/azure/iot-hub/concepts-manage-device-reconnections), [published internal client](https://unpkg.com/azure-iot-device@1.18.4/dist/internal_client.js), [retry operation](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/common/core/src/retry_operation.ts) | Retry ownership, operation budget limitations, client close/recovery semantics. |
| S19 | [Azure direct methods](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-direct-methods), [request parsing](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/device/core/src/device_method/device_method_request.ts), [response implementation](https://github.com/Azure/azure-iot-sdk-node/blob/2026-01-28/device/core/src/device_method/device_method_response.ts) | Correlation/concurrency considerations, timeouts, payload types, one-shot response handling; method registration also inspected in S11/S18. |
| S20 | [Node-RED node authoring](https://nodered.org/docs/creating-nodes/node-js), [config nodes](https://nodered.org/docs/creating-nodes/config-nodes), [packaging](https://nodered.org/docs/creating-nodes/packaging), [test helper](https://github.com/node-red/node-red-node-test-helper) | Implementation-phase reference for constructors, input completion, close, credentials, config ownership, and packaged-node testing. |

## 13. Approval Boundary

Approval of this plan should identify any changed defaults in section 11 and
authorize Phase 0/1 first. It does not require a package split, optional auth,
preview Azure features, or a TypeScript rewrite. Flow-affecting method changes,
support drops, security exceptions, cloud deployments, and publishing retain
their explicit decision gates. Field reliability is demonstrated by the tests
and staged evidence above, not inferred from a version bump.
