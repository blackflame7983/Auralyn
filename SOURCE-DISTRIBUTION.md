# Auralyn corresponding source distribution

Auralyn is distributed under GPL-3.0-only. Every official binary release must
provide equivalent, no-additional-charge access to the Corresponding Source
from the same GitHub Release page.

## Release assets

For version `x.y.z`, the public release must contain all of the following:

- `Auralyn_vx.y.z_Source.zip`: source archived from the exact, clean Git commit
  used for the release, plus the GPL-selected ASIO SDK source used by that build
- `Auralyn_vx.y.z_Source.zip.sha256`: SHA-256 checksum of that archive
- `Auralyn_vx.y.z_Source.json`: version, commit, license, archive name, size,
  checksum, and generation time
- `LICENSE`, `NOTICE.md`, and `SOURCE-DISTRIBUTION.md`: license text, legal
  notices, and the source-access instructions shown next to the binary
- the installer, updater signature, and `latest.json`

The release uploader first verifies a clean worktree, rebuilds the signed
binary from that HEAD, and then generates these source assets automatically.
It refuses to continue when the Git worktree has tracked or untracked changes.

## Building from source

Prerequisites:

- Windows 11 x64
- Node.js and npm
- Rust stable with the `x86_64-pc-windows-msvc` target
- Visual Studio Build Tools with the MSVC and Windows SDK components
- LLVM/Clang required by `asio-sys`

Build steps:

```powershell
npm ci
npm run gen-cargo-licenses
$env:CPAL_ASIO_DIR = (Resolve-Path '.\third_party\Steinberg-ASIO-SDK-2.3.4')
npm run tauri build
```

`package-lock.json` and `src-tauri/Cargo.lock` are part of the Corresponding
Source and pin the JavaScript and Rust dependency graphs for each release.

The release workflow downloads the Steinberg ASIO SDK from
`https://www.steinberg.net/asiosdk`, verifies the SHA-256 pinned in
`config/release-policy.json`, sets `CPAL_ASIO_DIR` for the signed build, and
copies the SDK's `common` and `host` source trees plus license files into
`third_party/Steinberg-ASIO-SDK-2.3.4` in the Source ZIP. This ensures the
ASIO source in the archive is the same source selected for the binary build.

Do not bundle proprietary VST plug-ins or third-party ASIO drivers with the
Auralyn release. Users install and license those independent components
separately.
