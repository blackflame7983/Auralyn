/**
 * 公開リポジトリ（Auralyn）に Release アセットをアップロードするスクリプト
 *
 * 前提:
 * - 開発リポで npm run tauri build 済み
 * - createUpdaterArtifacts 有効状態で latest.json を生成済み
 * - gh CLI がインストールされ、認証済み
 *
 * 使い方:
 *   node scripts/upload-release-to-public-repo.cjs [version]
 *   version 省略時は tauri.conf.json の version を使用
 *
 * 環境変数（任意）:
 *   PUBLIC_REPO=blackflame7983/Auralyn
 *   BUNDLE_DIR=src-tauri/target/release/bundle
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_REPO = process.env.PUBLIC_REPO || 'blackflame7983/Auralyn';
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

console.log(`Uploading release ${tag} to ${PUBLIC_REPO}`);
console.log('');

// 1) MSI or NSIS installer
const msiDir = path.join(BUNDLE_DIR, 'msi');
const nsisDir = path.join(BUNDLE_DIR, 'nsis');
const installerPath = findFile(msiDir, (n) => n.endsWith('.msi'))
  || findFile(nsisDir, (n) => n.endsWith('.exe'));

if (!installerPath) {
  console.error('Installer not found. Run: npm run tauri build');
  process.exit(1);
}

// 2) latest.json (build で生成されたもの)
const latestPath = findFile(BUNDLE_DIR, (n) => n === 'latest.json') || path.join(BUNDLE_DIR, 'latest.json');
const hasLatest = fs.existsSync(latestPath);

if (!hasLatest) {
  console.error('latest.json not found. Run: npm run tauri build (with bundle.createUpdaterArtifacts = true)');
  process.exit(1);
}

const filesToUpload = [installerPath, latestPath].map((p) => path.relative(PROJECT_ROOT, p));
console.log('Files to upload:', filesToUpload);

try {
  execSync(`gh release create "${tag}" ${filesToUpload.map((f) => `"${f}"`).join(' ')} --repo "${PUBLIC_REPO}"`, {
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
