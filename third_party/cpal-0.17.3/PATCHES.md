# Auralyn local CPAL 0.17.3 patch

Source: crates.io `cpal` 0.17.3, retaining its Apache-2.0 `LICENSE`, upstream
source, build files and examples. The upstream revision is recorded in
`.cargo_vcs_info.json`. No dependency version or ASIO SDK change is included.

Upstream `src/host/asio/stream.rs` SHA-256 before modification:
`0e2338e53a5416ad623f99fa114d8676c5def4bfc5490b5cbc021fbc655ba4fe`.

The ASIO input/output builders register the error/message callback only after
stream preparation succeeds, and construct the `Stream` owning both callback
IDs. Driver start is deferred to `Stream::play`. Building both directions before
playing therefore avoids an ASIOStart/ASIOStop cycle between the two builds.
Buffer preparation still happens per direction; this does not batch the two
ASIOCreateBuffers calls. The shared asio-sys Driver makes repeated start calls
while Running a no-op. A failed play restores the callback gate, and Auralyn's
StreamPair drops both streams on play failure, removing their registrations
before device/processor teardown. Pause remains a callback gate, so pausing one
direction does not stop the other. `build_lifecycle.rs` and Auralyn's lifecycle
tests exercise start failure and ownership with non-device mocks.

The ASIO Host exposes registration-only `driver_names` and selected-only
`device_by_name` lookup, and implements direct `device_by_id` lookup. Auralyn's
scanner uses registration names without opening drivers. Its device resolver
uses the ASIO Host directly rather than enumerating/loading every driver before
finding the selected one. Registration is not evidence of device availability
or capabilities; these are checked when starting the selected device.

This patch does not change Auralyn's build order or play order, sample
conversion, audio processing, buffer selection or channel mapping.
Driver/OS failure recovery and callback timing still require device checks.

The complete directory must be included in the corresponding source archive.
The Cargo `[patch.crates-io]` entry selects this copy for Auralyn and its
transitive dependencies. Do not edit the Cargo registry cache to reproduce it.
