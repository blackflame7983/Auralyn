/**
 * 公開リポジトリ（Auralyn-Releases）に Release アセットをアップロードするスクリプト
 *
 * 前提:
 * - createUpdaterArtifactsとTauri署名環境変数を設定済み
 * - Git worktreeがcleanで、バイナリと同じHEADがcheckoutされている
 * - gh CLI がインストールされ、認証済み
 *
 * 使い方:
 *   node scripts/upload-release-to-public-repo.cjs [version]
 *   version 省略時は tauri.conf.json の version を使用
 *
 * 環境変数（任意）:
 *   PUBLIC_REPO=blackflame7983/Auralyn-Releases
 *   BUNDLE_DIR=src-tauri/target/release/bundle
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runReleaseReadinessCheck } = require('./check-release-readiness.cjs');
const { writeWindowsManifest } = require('./generate-release-manifest.cjs');
const { assertCleanWorktree, createSourceArchive } = require('./generate-source-archive.cjs');
const { prepareAsioSdk } = require('./prepare-asio-sdk.cjs');
const {
  assertFreshSignature,
  assertSigningEnvironment,
  clearStaleSignatures,
} = require('./signing-safety.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_REPO = process.env.PUBLIC_REPO || 'blackflame7983/Auralyn-Releases';
const BUNDLE_DIR = path.resolve(PROJECT_ROOT, process.env.BUNDLE_DIR || 'src-tauri/target/release/bundle');

function getVersion() {
  const arg = process.argv[2];
  if (arg) return arg.replace(/^v/, '');
  const confPath = path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  return conf.version || '0.0.0';
}

function findFile(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && predicate(e.name)) return full;
    if (e.isDirectory()) {
      const found = findFile(full, predicate);
      if (found) return found;
    }
  }
  return null;
}

const version = getVersion();
const tag = `v${version}`;
const releaseTitle = process.env.AURALYN_RELEASE_TITLE || `Auralyn v${version}`;
const releaseNotes = process.env.AURALYN_RELEASE_NOTES || [
  `Auralyn v${version} official Windows release.`,
  '',
  '- License: GPL-3.0-only',
  '- Signed Windows installer and Tauri updater signature',
  '- Corresponding Source ZIP, SHA-256, and manifest attached to this Release',
].join('\n');

try {
  runReleaseReadinessCheck({ publicRepo: PUBLIC_REPO });
  assertCleanWorktree(PROJECT_ROOT);
  assertSigningEnvironment(process.env);
  clearStaleSignatures(BUNDLE_DIR, version);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log(`Uploading release ${tag} to ${PUBLIC_REPO}`);
console.log('');

let asioSdk;
try {
  asioSdk = prepareAsioSdk();
  console.log(`Using pinned ASIO SDK ${asioSdk.sdkVersion}: ${asioSdk.archiveSha256}`);
} catch (error) {
  console.error(`ASIO SDKの固定に失敗しました: ${error.message}`);
  process.exit(1);
}

// Always rebuild after the clean-tree GPL gate so the binary and source
// archive originate from the same checked-out commit.
try {
  console.log('Building signed release artifacts from the current clean HEAD...');
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'npm';
  const args = npmExecPath
    ? [npmExecPath, 'run', 'tauri', 'build']
    : ['run', 'tauri', 'build'];
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
    env: { ...process.env, CPAL_ASIO_DIR: asioSdk.sdkDir },
  });
} catch (error) {
  console.error(`リリースビルドに失敗しました: ${error.message}`);
  process.exit(error.status ?? 1);
}

// 1) Prefer the NSIS installer used by the public download flow, then MSI.
const msiDir = path.join(BUNDLE_DIR, 'msi');
const nsisDir = path.join(BUNDLE_DIR, 'nsis');
const versionToken = `_${version}_`;
const installerPath = findFile(nsisDir, (n) => n.includes(versionToken) && n.endsWith('.exe'))
  || findFile(msiDir, (n) => n.includes(versionToken) && n.endsWith('.msi'));

if (!installerPath) {
  console.error(`Installer for v${version} not found. Run: npm run tauri build`);
  process.exit(1);
}

// 2) Tauri creates the installer signature, while the static latest.json is
// generated here in the official Tauri v2 static updater format.
const signaturePath = `${installerPath}.sig`;
try {
  assertFreshSignature(installerPath, signaturePath);
} catch (error) {
  console.error(error.message);
  console.error('Set TAURI_SIGNING_PRIVATE_KEY and run: npm run tauri build');
  process.exit(1);
}

const latestPath = path.join(BUNDLE_DIR, 'latest.json');
const signature = fs.readFileSync(signaturePath, 'utf8').trim();
writeWindowsManifest(latestPath, {
  version,
  repo: PUBLIC_REPO,
  tag,
  assetName: path.basename(installerPath),
  signature,
  notes: releaseNotes,
});

// GPLv3 section 6 requires equivalent access to the Corresponding Source.
// Generate it from the exact clean HEAD and upload it beside the binary.
let sourceAssets;
try {
  sourceAssets = createSourceArchive({ version, asioSdkDir: asioSdk.sdkDir });
} catch (error) {
  console.error(`対応ソースの生成に失敗しました: ${error.message}`);
  process.exit(1);
}

const filesToUploadAbsolute = [
  installerPath,
  signaturePath,
  latestPath,
  sourceAssets.archivePath,
  sourceAssets.checksumPath,
  sourceAssets.manifestPath,
  path.join(PROJECT_ROOT, 'LICENSE'),
  path.join(PROJECT_ROOT, 'NOTICE.md'),
  path.join(PROJECT_ROOT, 'SOURCE-DISTRIBUTION.md'),
];
const portablePath = path.join(PROJECT_ROOT, 'release_artifacts', `Auralyn_v${version}_Portable.zip`);
if (fs.existsSync(portablePath)) filesToUploadAbsolute.push(portablePath);

const filesToUpload = filesToUploadAbsolute.map((p) => path.relative(PROJECT_ROOT, p));
console.log('Files to upload:', filesToUpload);
console.log(`Corresponding Source commit: ${sourceAssets.manifest.commit}`);

try {
  execFileSync('gh', [
    'release', 'create', tag, ...filesToUpload,
    '--repo', PUBLIC_REPO,
    '--title', releaseTitle,
    '--notes', releaseNotes,
  ], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
  console.log('');
  console.log('Done. Release:', `https://github.com/${PUBLIC_REPO}/releases/tag/${tag}`);
} catch (e) {
  if (e.status === 1) {
    console.error('Tip: Release may already exist. Try: gh release upload', tag, '...', '--repo', PUBLIC_REPO);
  }
  process.exit(e.status ?? 1);
}
