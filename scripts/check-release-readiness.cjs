const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { planVersionUpdate } = require('./set-version.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function hasAsioFeature(cargoToml) {
  const inlineDependency = cargoToml.match(/^\s*cpal\s*=\s*(\{[\s\S]*?\}|[^\r\n]+)/m)?.[1];
  if (inlineDependency && /features\s*=\s*\[[^\]]*["']asio["'][^\]]*\]/s.test(inlineDependency)) {
    return true;
  }

  const lines = cargoToml.split(/\r?\n/);
  const cpalTableLines = [];
  let inCpalTable = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inCpalTable = /^\s*\[(?:[^\]]+\.)?dependencies\.cpal\]\s*$/.test(line);
      continue;
    }
    if (inCpalTable) cpalTableLines.push(line);
  }
  return /features\s*=\s*\[[^\]]*["']asio["'][^\]]*\]/s.test(cpalTableLines.join('\n'));
}

const ASIO_TRADEMARK_NOTICE = 'ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.';

function validateReleaseReadiness({
  packageJson,
  cargoToml,
  tauriConfig,
  policy,
  publicRepo,
  licenseText = '',
  noticeText = '',
  sourceDistributionText = '',
  npmLicenseData = { libraries: [] },
  trackedFiles = [],
}) {
  const errors = [];
  const warnings = [];
  const expectedRepo = policy.publicReleaseRepository;
  const expectedEndpoint = `https://github.com/${expectedRepo}/releases/latest/download/latest.json`;
  const endpoints = tauriConfig?.plugins?.updater?.endpoints || [];

  if (policy.schemaVersion !== 2) {
    errors.push('config/release-policy.json の schemaVersion が未対応です。');
  }
  if (policy.applicationLicense !== 'GPL-3.0-only') {
    errors.push('applicationLicense は GPL-3.0-only である必要があります。');
  }
  if (!expectedRepo) {
    errors.push('publicReleaseRepository が未設定です。');
  }
  if (publicRepo !== expectedRepo) {
    errors.push(`公開先 ${publicRepo} は許可済みリポジトリ ${expectedRepo} と一致しません。`);
  }
  if (packageJson.private !== true || packageJson.license !== 'GPL-3.0-only') {
    errors.push('package.json は private=true かつ license=GPL-3.0-only である必要があります。');
  }
  if (!/^\s*publish\s*=\s*false\s*$/m.test(cargoToml)) {
    errors.push('src-tauri/Cargo.toml に publish = false が必要です。');
  }
  if (!/^\s*license\s*=\s*["']GPL-3\.0-only["']\s*$/m.test(cargoToml)) {
    errors.push('src-tauri/Cargo.toml は license = "GPL-3.0-only" である必要があります。');
  }
  if (!licenseText.includes('GNU GENERAL PUBLIC LICENSE') || !licenseText.includes('Version 3, 29 June 2007')) {
    errors.push('LICENSE にGNU GPL version 3の全文がありません。');
  }
  if (!noticeText.includes('GPL-3.0-only') || !noticeText.includes('WITHOUT ANY WARRANTY')) {
    errors.push('NOTICE.md にGPL-3.0-onlyの告知と無保証表示がありません。');
  }
  const sourceDistribution = policy.sourceDistribution || {};
  if (
    sourceDistribution.mode !== 'same-release-archive'
    || sourceDistribution.archiveNamePattern !== 'Auralyn_v{version}_Source.zip'
    || sourceDistribution.checksumRequired !== true
    || sourceDistribution.manifestRequired !== true
  ) {
    errors.push('sourceDistributionは同一ReleaseへのSource ZIP・SHA-256・manifest添付を必須にしてください。');
  }
  if (!sourceDistributionText.includes('Corresponding Source')) {
    errors.push('SOURCE-DISTRIBUTION.md に対応ソースの配布方法が記載されていません。');
  }
  const npmLibraries = Array.isArray(npmLicenseData?.libraries) ? npmLicenseData.libraries : [];
  if (npmLibraries.some((library) => library.path || library.licenseFile)) {
    errors.push('npmライセンス一覧にローカルファイルパスを含めないでください。');
  }
  for (const requiredFile of ['package-lock.json', 'src-tauri/Cargo.lock']) {
    if (!trackedFiles.includes(requiredFile)) {
      errors.push(`${requiredFile} をGit管理し、対応ソースへ含める必要があります。`);
    }
  }
  if (!endpoints.includes(expectedEndpoint)) {
    errors.push(`Tauri updater endpoint が ${expectedEndpoint} を参照していません。`);
  }

  const asioEnabled = hasAsioFeature(cargoToml);
  if (asioEnabled) {
    const asio = policy.asio || {};
    const authorized = asio.distributionLicense === 'GPL-3.0-only'
      && asio.publicReleaseAllowed === true
      && asio.licenseSource === 'https://www.steinberg.net/asiosdk'
      && asio.sdkVersion === '2.3.4'
      && typeof asio.sdkArchiveSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(asio.sdkArchiveSha256)
      && typeof asio.reviewedAt === 'string'
      && asio.reviewedAt.trim().length > 0
      && noticeText.includes(ASIO_TRADEMARK_NOTICE);

    if (!authorized) {
      errors.push(
        'ASIO対応ビルドにはSteinberg ASIO SDKのGPL-3.0-only選択（SDK 2.3.4）、公式参照URL、'
        + '固定SHA-256、確認日、NOTICE.mdの正式なASIO商標表示が必要です。',
      );
    }
  } else {
    warnings.push('ASIO featureは無効です。今回の成果物はWASAPI中心のビルドとして扱われます。');
  }

  return { errors, warnings, asioEnabled, expectedEndpoint };
}

function runReleaseReadinessCheck(options = {}) {
  const packageJson = readJson(path.join(PROJECT_ROOT, 'package.json'));
  const cargoToml = readText(path.join(PROJECT_ROOT, 'src-tauri', 'Cargo.toml'));
  const tauriConfig = readJson(path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'));
  const policy = readJson(path.join(PROJECT_ROOT, 'config', 'release-policy.json'));
  const licenseText = readText(path.join(PROJECT_ROOT, 'LICENSE'));
  const noticeText = readText(path.join(PROJECT_ROOT, 'NOTICE.md'));
  const sourceDistributionText = readText(path.join(PROJECT_ROOT, 'SOURCE-DISTRIBUTION.md'));
  const npmLicenseData = readJson(path.join(PROJECT_ROOT, 'src', 'assets', 'licenses-npm.json'));
  const trackedFiles = execFileSync('git', ['ls-files'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  }).split(/\r?\n/).filter(Boolean);
  const publicRepo = options.publicRepo || process.env.PUBLIC_REPO || policy.publicReleaseRepository;
  const result = validateReleaseReadiness({
    packageJson,
    cargoToml,
    tauriConfig,
    policy,
    publicRepo,
    licenseText,
    noticeText,
    sourceDistributionText,
    npmLicenseData,
    trackedFiles,
  });

  // npm経由以外の公開スクリプトから呼ばれた場合も同期を確認する。
  try {
    const mismatches = planVersionUpdate(PROJECT_ROOT, packageJson.version).filter((entry) => entry.changed);
    if (mismatches.length) result.errors.push(`バージョン不一致: ${mismatches.map((entry) => entry.file).join(', ')}`);
  } catch (error) {
    result.errors.push(`バージョン確認に失敗しました: ${error.message}`);
  }

  console.log('Auralyn release readiness check');
  console.log(`- 公開先: ${publicRepo}`);
  console.log(`- ASIO feature: ${result.asioEnabled ? 'enabled' : 'disabled'}`);
  console.log('- 本体ライセンス: GPL-3.0-only');
  console.log('- 対応ソース: 同一ReleaseにSource ZIP・SHA-256・manifestを添付');
  console.log(`- updater: ${result.expectedEndpoint}`);
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    const failure = new Error(`公開前チェックに失敗しました (${result.errors.length}件)`);
    failure.validationErrors = result.errors;
    throw failure;
  }

  console.log('Release readiness: PASS');
  return result;
}

if (require.main === module) {
  try {
    runReleaseReadinessCheck();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  ASIO_TRADEMARK_NOTICE,
  hasAsioFeature,
  validateReleaseReadiness,
  runReleaseReadinessCheck,
};
