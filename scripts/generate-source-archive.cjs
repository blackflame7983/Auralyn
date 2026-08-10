const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertWithin, prepareAsioSdk, validateAsioSdk } = require('./prepare-asio-sdk.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'release_artifacts');
const REQUIRED_SOURCE_FILES = [
  'LICENSE',
  'NOTICE.md',
  'SOURCE-DISTRIBUTION.md',
  '.gitattributes',
  'config/release-policy.json',
  'package-lock.json',
  'src-tauri/Cargo.lock',
];

function runGit(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertCleanStatus(status) {
  if (status.trim().length > 0) {
    throw new Error(
      '対応ソースはcleanなGit HEADからのみ生成できます。未コミット変更をコミットまたは退避してください。'
      + `\n${status.trim()}`,
    );
  }
}

function assertCleanWorktree(projectRoot = PROJECT_ROOT) {
  const status = runGit(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  assertCleanStatus(status);
}

function assertRequiredFilesTracked(projectRoot = PROJECT_ROOT) {
  const missing = [];
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    try {
      runGit(projectRoot, ['ls-files', '--error-unmatch', '--', relativePath]);
    } catch {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(`対応ソースに必要なファイルがGit管理されていません: ${missing.join(', ')}`);
  }
}

function readReleaseVersion(projectRoot = PROJECT_ROOT, explicitVersion) {
  if (explicitVersion) return explicitVersion.replace(/^v/, '');
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  return tauriConfig.version;
}

function assertVersionConsistency(projectRoot, version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`有効なSemVerではありません: ${version}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const cargoToml = fs.readFileSync(path.join(projectRoot, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoVersion = cargoToml.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];

  const versions = {
    'package.json': packageJson.version,
    'src-tauri/tauri.conf.json': tauriConfig.version,
    'src-tauri/Cargo.toml': cargoVersion,
  };
  const mismatches = Object.entries(versions).filter(([, actual]) => actual !== version);
  if (mismatches.length > 0) {
    const details = mismatches.map(([file, actual]) => `${file}=${actual || 'missing'}`).join(', ');
    throw new Error(`指定バージョン ${version} とプロジェクトの版が一致しません: ${details}`);
  }
}

function calculateSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildSourceManifest({ version, commit, archiveName, size, sha256, generatedAt, asioSdk }) {
  return {
    schemaVersion: 1,
    product: 'Auralyn',
    version,
    commit,
    license: 'GPL-3.0-only',
    archive: archiveName,
    size,
    sha256,
    correspondingSource: {
      asioSdk,
    },
    generatedAt,
  };
}

function createSourceArchive(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
  const version = readReleaseVersion(projectRoot, options.version);
  const asioSdkDir = options.asioSdkDir ? path.resolve(options.asioSdkDir) : null;

  assertCleanWorktree(projectRoot);
  assertRequiredFilesTracked(projectRoot);
  assertVersionConsistency(projectRoot, version);
  if (!asioSdkDir) {
    throw new Error('対応ソース生成には、リリースビルドで使用したasioSdkDirが必要です。');
  }
  validateAsioSdk(asioSdkDir);

  const commit = runGit(projectRoot, ['rev-parse', 'HEAD']);
  const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'release-policy.json'), 'utf8'));
  const asioPolicy = policy.asio || {};
  const archiveName = `Auralyn_v${version}_Source.zip`;
  const archivePath = path.join(outputDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  const manifestPath = path.join(outputDir, `Auralyn_v${version}_Source.json`);
  const prefixName = `Auralyn-${version}`;
  const stageRoot = path.join(outputDir, `.source-stage-${process.pid}`);
  const stagedProjectRoot = path.join(stageRoot, prefixName);
  const temporaryTarPath = path.join(outputDir, `.source-${process.pid}.tar`);

  fs.mkdirSync(outputDir, { recursive: true });
  assertWithin(outputDir, stageRoot);
  assertWithin(outputDir, temporaryTarPath);
  if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(temporaryTarPath, { force: true });
  fs.rmSync(archivePath, { force: true });

  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    execFileSync(
      'git',
      [
        'archive',
        '--format=tar',
        `--prefix=${prefixName}/`,
        `--output=${temporaryTarPath}`,
        'HEAD',
      ],
      { cwd: projectRoot, stdio: 'inherit' },
    );
    execFileSync('tar', ['-xf', temporaryTarPath, '-C', stageRoot], { stdio: 'inherit' });

    const stagedAsioRoot = path.join(
      stagedProjectRoot,
      'third_party',
      `Steinberg-ASIO-SDK-${asioPolicy.sdkVersion}`,
    );
    fs.mkdirSync(stagedAsioRoot, { recursive: true });
    for (const entry of ['LICENSE.txt', 'README.md', 'changes.txt', 'common', 'host']) {
      const sourcePath = path.join(asioSdkDir, entry);
      if (fs.existsSync(sourcePath)) {
        fs.cpSync(sourcePath, path.join(stagedAsioRoot, entry), { recursive: true });
      }
    }
    fs.writeFileSync(
      path.join(stagedAsioRoot, 'AURALYN-ASIO-SOURCE.json'),
      `${JSON.stringify({
        sdkVersion: asioPolicy.sdkVersion,
        selectedLicense: 'GPL-3.0-only',
        sourceUrl: asioPolicy.licenseSource,
        sourceArchiveSha256: asioPolicy.sdkArchiveSha256,
        includedForCommit: commit,
      }, null, 2)}\n`,
      'utf8',
    );

    execFileSync('tar', ['-a', '-cf', archivePath, '-C', stageRoot, prefixName], { stdio: 'inherit' });
  } finally {
    fs.rmSync(temporaryTarPath, { force: true });
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
  }

  const sha256 = calculateSha256(archivePath);
  const size = fs.statSync(archivePath).size;
  const manifest = buildSourceManifest({
    version,
    commit,
    archiveName,
    size,
    sha256,
    generatedAt: new Date().toISOString(),
    asioSdk: {
      version: asioPolicy.sdkVersion,
      sourceArchiveSha256: asioPolicy.sdkArchiveSha256,
      includedPath: `third_party/Steinberg-ASIO-SDK-${asioPolicy.sdkVersion}`,
      selectedLicense: 'GPL-3.0-only',
    },
  });

  fs.writeFileSync(checksumPath, `${sha256}  ${archiveName}\n`, 'utf8');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { archivePath, checksumPath, manifestPath, manifest };
}

if (require.main === module) {
  try {
    // Fail before downloading/extracting the SDK when the checked-out sources
    // cannot be tied to a single release commit.
    assertCleanWorktree(PROJECT_ROOT);
    const asioSdk = prepareAsioSdk();
    const result = createSourceArchive({ version: process.argv[2], asioSdkDir: asioSdk.sdkDir });
    console.log('Auralyn corresponding source assets generated:');
    console.log(`- ${result.archivePath}`);
    console.log(`- ${result.checksumPath}`);
    console.log(`- ${result.manifestPath}`);
    console.log(`- commit: ${result.manifest.commit}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_SOURCE_FILES,
  assertCleanStatus,
  assertCleanWorktree,
  assertRequiredFilesTracked,
  assertVersionConsistency,
  buildSourceManifest,
  calculateSha256,
  createSourceArchive,
  readReleaseVersion,
};
