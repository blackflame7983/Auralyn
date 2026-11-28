# Auralyn corresponding source distribution

Auralyn is distributed under GPL-3.0-only. Every official binary release must
provide equivalent, no-additional-charge access to the Corresponding Source
from the same GitHub Release page.

Status (2026-11-28): the Tauri-based packaging and release uploader were removed
together with the Tauri UI. The GPUI-based application has no release packaging
yet, so no new version is published until that packaging, including the source
assets below, is rebuilt. The requirements in this document still apply to it.

## Release assets

For version `x.y.z`, the public release must contain all of the following:

- `Auralyn_vx.y.z_Source.zip`: source archived from the exact, clean Git commit
  used for the release, plus the GPL-selected ASIO SDK source used by that build
- `Auralyn_vx.y.z_Source.zip.sha256`: SHA-256 checksum of that archive
- `Auralyn_vx.y.z_Source.json`: version, commit, license, archive name, size,
  checksum, and generation time
- `LICENSE`, `NOTICE.md`, and `SOURCE-DISTRIBUTION.md`: license text, legal
  notices, and the source-access instructions shown next to the binary
- the installer and any updater metadata

The release process must verify a clean worktree, rebuild the signed binary
from that HEAD, and then generate these source assets from the same HEAD. It
must refuse to continue when the Git worktree has tracked or untracked changes.

## Building from source

Prerequisites:

- Windows 11 x64
- Rust 1.100.0 (pinned by `rust-toolchain.toml`; `rustup` installs it automatically) with the `x86_64-pc-windows-msvc` target
- Visual Studio Build Tools with the MSVC and Windows SDK components
- LLVM/Clang required by `asio-sys`

Build steps:

```powershell
$env:CPAL_ASIO_DIR = (Resolve-Path '.\third_party\Steinberg-ASIO-SDK-2.3.4')
cargo build --release --locked
```

This builds `auralyn-gpui.exe`, `audio_engine.exe`, and `plugin_scanner.exe`
into `target\release`. The root `Cargo.lock` is part of the Corresponding
Source and pins the Rust dependency graph for each release.

The Rust dependency `nnnoiseless` uses the modified local source at
`third_party/nnnoiseless-0.5.2`. This directory, including its model data,
`COPYING`, and `PATCHES.md`, must remain in the same source archive. The
registry version is also pinned as a development-only comparison dependency;
it is not selected by the production dependency. No separate download of the
local modifications is needed to build from the archive.

CPAL 0.17.3 is selected through Cargo's `[patch.crates-io]` from
`third_party/cpal-0.17.3`. Its ASIO stream-build failure cleanup is modified;
include this entire directory, its Apache-2.0 `LICENSE`, upstream provenance,
and `PATCHES.md` in the same source archive. The existing source archive uses
the full Git tree, so this tracked local dependency requires no extra download.
The dependency version and the ASIO SDK selection remain unchanged.

`scripts/prepare-asio-sdk.cjs` downloads the Steinberg ASIO SDK from
`https://www.steinberg.net/asiosdk` and verifies the SHA-256 pinned in
`config/asio-sdk.json`. The release process must set `CPAL_ASIO_DIR` to that
SDK for the signed build and copy the SDK's `common` and `host` source trees plus license files into
`third_party/Steinberg-ASIO-SDK-2.3.4` in the Source ZIP. This ensures the
ASIO source in the archive is the same source selected for the binary build.

Do not bundle proprietary VST plug-ins or third-party ASIO drivers with the
Auralyn release. Users install and license those independent components
separately.

## Planned OBS source plugin (not shipped)

An independently distributed GPL-2.0-or-later OBS source plugin is proposed in
[the design](docs/OBS_SOURCE_PLUGIN_DESIGN.md). It would communicate with the
GPL-3.0-only Auralyn process through local IPC, with no libobs linkage in Auralyn.
The plugin needs its own exact-commit source archive, dependency notices,
checksums, source manifest, and build instructions beside its binary.
No current release process packages or publishes this plugin.
Implementation and distribution changes follow design agreement; this section
does not change the current application's license or source release gates.
