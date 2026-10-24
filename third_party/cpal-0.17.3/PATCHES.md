# Auralyn local CPAL 0.17.3 patch

Source: crates.io `cpal` 0.17.3, retaining its Apache-2.0 `LICENSE`, upstream
source, build files and examples. The upstream revision is recorded in
`.cargo_vcs_info.json`. No dependency version or ASIO SDK change is included.

Upstream `src/host/asio/stream.rs` SHA-256 before modification:
`0e2338e53a5416ad623f99fa114d8676c5def4bfc5490b5cbc021fbc655ba4fe`.

The ASIO input/output builders now register the error/message callback only
after stream preparation succeeds, and construct the `Stream` owning both
callback IDs before calling driver start. Failed start drops that Stream,
removing both registrations without relying on final Driver destruction.
`build_lifecycle.rs` contains these two small generic ownership boundaries;
Auralyn's lifecycle tests exercise them with non-device mocks.

This patch does not change build order, play order, driver callback execution,
sample conversion, audio processing, buffer selection or channel mapping.
Driver/OS failure recovery and callback timing still require device checks.

The complete directory must be included in the corresponding source archive.
The Cargo `[patch.crates-io]` entry selects this copy for Auralyn and its
transitive dependencies. Do not edit the Cargo registry cache to reproduce it.
