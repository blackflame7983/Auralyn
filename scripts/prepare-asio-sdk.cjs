const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_ROOT = path.join(PROJECT_ROOT, 'release_artifacts', '.source-cache');

function calculateSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertWithin(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`安全でない作業パスです: ${child}`);
  }
}

function validateAsioSdk(sdkDir) {
  const required = [
    'LICENSE.txt',
    'README.md',
    'common/asio.h',
    'common/asiosys.h',
    'host/asiodrivers.h',
    'host/pc/asiolist.cpp',
  ];
  const missing = required.filter((relativePath) => !fs.existsSync(path.join(sdkDir, relativePath)));
  if (missing.length > 0) {
    throw new Error(`ASIO SDKに必要なファイルがありません: ${missing.join(', ')}`);
  }

  const licenseText = fs.readFileSync(path.join(sdkDir, 'LICENSE.txt'), 'utf8');
  if (!licenseText.includes('General Public License (GPL) Version 3')) {
    throw new Error('ASIO SDKのLICENSE.txtにGPL Version 3の選択肢がありません。');
  }
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function prepareAsioSdk(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const policyPath = path.join(projectRoot, 'config', 'release-policy.json');
  const policy = options.policy || JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const asio = policy.asio || {};
  const sdkVersion = asio.sdkVersion;
  const expectedHash = String(asio.sdkArchiveSha256 || '').toLowerCase();
  const downloadUrl = asio.licenseSource;
  const cacheRoot = path.resolve(options.cacheRoot || CACHE_ROOT);

  if (!sdkVersion || !/^[a-f0-9]{64}$/.test(expectedHash) || !downloadUrl) {
    throw new Error('ASIO SDK version、download URL、SHA-256をrelease-policy.jsonに固定してください。');
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const archivePath = path.join(cacheRoot, `ASIOSDK-${sdkVersion}.zip`);
  const extractRoot = path.join(cacheRoot, `ASIOSDK-${sdkVersion}`);
  assertWithin(cacheRoot, archivePath);
  assertWithin(cacheRoot, extractRoot);

  if (!fs.existsSync(archivePath)) {
    if (process.platform !== 'win32') {
      throw new Error('ASIO SDKの自動取得はWindows Release環境でのみ対応しています。');
    }
    const command = [
      "$ProgressPreference='SilentlyContinue'",
      `Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(downloadUrl)} -OutFile ${powershellQuote(archivePath)}`,
    ].join('; ');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], { stdio: 'inherit' });
  }

  const actualHash = calculateSha256(archivePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `ASIO SDKのSHA-256が固定値と一致しません。expected=${expectedHash}, actual=${actualHash}`,
    );
  }

  if (fs.existsSync(extractRoot)) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(extractRoot, { recursive: true });
  execFileSync('tar', ['-xf', archivePath, '-C', extractRoot], { stdio: 'inherit' });

  const sdkDir = path.join(extractRoot, 'ASIOSDK');
  validateAsioSdk(sdkDir);
  return { sdkDir, sdkVersion, archivePath, archiveSha256: actualHash, downloadUrl };
}

if (require.main === module) {
  try {
    const result = prepareAsioSdk();
    console.log(`ASIO SDK ${result.sdkVersion} prepared: ${result.sdkDir}`);
    console.log(`SHA-256: ${result.archiveSha256}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  assertWithin,
  calculateSha256,
  prepareAsioSdk,
  validateAsioSdk,
};
