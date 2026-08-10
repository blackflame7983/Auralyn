const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReleaseReadiness } = require('./check-release-readiness.cjs');
const { assertAssetMatchesVersion, buildWindowsManifest } = require('./generate-release-manifest.cjs');
const { assertCleanStatus, buildSourceManifest } = require('./generate-source-archive.cjs');

const PUBLIC_REPO = 'blackflame7983/Auralyn-Releases';
const ENDPOINT = `https://github.com/${PUBLIC_REPO}/releases/latest/download/latest.json`;

function fixture(overrides = {}) {
  return {
    packageJson: { private: true, license: 'GPL-3.0-only' },
    cargoToml: [
      '[package]',
      'publish = false',
      'license = "GPL-3.0-only"',
      'cpal = { version = "0.17.0", features = ["asio"] }',
    ].join('\n'),
    tauriConfig: { plugins: { updater: { endpoints: [ENDPOINT] } } },
    policy: {
      schemaVersion: 2,
      applicationLicense: 'GPL-3.0-only',
      publicReleaseRepository: PUBLIC_REPO,
      sourceDistribution: {
        mode: 'same-release-archive',
        archiveNamePattern: 'Auralyn_v{version}_Source.zip',
        checksumRequired: true,
        manifestRequired: true,
      },
      asio: {
        distributionLicense: 'GPL-3.0-only',
        publicReleaseAllowed: true,
        licenseSource: 'https://www.steinberg.net/asiosdk',
        sdkVersion: '2.3.4',
        sdkArchiveSha256: 'b'.repeat(64),
        reviewedAt: '2026-07-22',
      },
    },
    publicRepo: PUBLIC_REPO,
    licenseText: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007',
    noticeText: [
      'GPL-3.0-only',
      'WITHOUT ANY WARRANTY',
      'ASIO is a trademark of Steinberg Media Technologies GmbH, registered in Europe and other countries.',
    ].join('\n'),
    sourceDistributionText: 'Corresponding Source is attached to the same release.',
    npmLicenseData: { libraries: [{ id: 'react@19.1.0', license: 'MIT' }] },
    trackedFiles: ['package-lock.json', 'src-tauri/Cargo.lock'],
    ...overrides,
  };
}

test('GPL本体・GPL ASIO・対応ソース方針が揃っていれば通過する', () => {
  const result = validateReleaseReadiness(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.asioEnabled, true);
});

test('ASIOがGPL-3.0-onlyでない場合は公開を拒否する', () => {
  const base = fixture();
  base.policy.asio = {
    distributionLicense: 'proprietary',
    publicReleaseAllowed: true,
    licenseSource: 'https://www.steinberg.net/asiosdk',
    sdkVersion: '2.3.4',
    sdkArchiveSha256: 'b'.repeat(64),
    reviewedAt: null,
  };
  const result = validateReleaseReadiness(base);
  assert.match(result.errors.join('\n'), /ASIO SDKのGPL-3\.0-only/);
});

test('複数行のcpal設定でもASIOを検出して不正な方針を拒否する', () => {
  const base = fixture({
    cargoToml: [
      '[package]',
      'publish = false',
      'license = "GPL-3.0-only"',
      'cpal = {',
      '  version = "0.17.0",',
      '  features = [',
      '    "asio",',
      '  ]',
      '}',
    ].join('\n'),
  });
  base.policy.asio = {
    distributionLicense: 'unconfirmed',
    publicReleaseAllowed: false,
    licenseSource: null,
    reviewedAt: null,
  };
  const result = validateReleaseReadiness(base);
  assert.match(result.errors.join('\n'), /ASIO SDKのGPL-3\.0-only/);
});

test('[dependencies.cpal]形式でもASIOを検出して不正な方針を拒否する', () => {
  const base = fixture({
    cargoToml: [
      '[package]',
      'publish = false',
      'license = "GPL-3.0-only"',
      '[dependencies.cpal]',
      'version = "0.17.0"',
      'features = ["asio"]',
      '[dependencies.serde]',
      'version = "1"',
    ].join('\n'),
  });
  base.policy.asio = {
    distributionLicense: 'unconfirmed',
    publicReleaseAllowed: false,
    licenseSource: null,
    reviewedAt: null,
  };
  const result = validateReleaseReadiness(base);
  assert.match(result.errors.join('\n'), /ASIO SDKのGPL-3\.0-only/);
});

test('許可されていない公開先を拒否する', () => {
  const result = validateReleaseReadiness(fixture({ publicRepo: 'blackflame7983/Auralyn' }));
  assert.match(result.errors.join('\n'), /許可済みリポジトリ/);
});

test('ASIOなしのビルドはASIO方針が未確認でも通過する', () => {
  const base = fixture({
    cargoToml: [
      '[package]',
      'publish = false',
      'license = "GPL-3.0-only"',
      'cpal = "0.17.0"',
    ].join('\n'),
  });
  base.policy.asio = {
    distributionLicense: 'unconfirmed',
    publicReleaseAllowed: false,
    licenseSource: null,
    reviewedAt: null,
  };
  const result = validateReleaseReadiness(base);
  assert.deepEqual(result.errors, []);
  assert.equal(result.asioEnabled, false);
});

test('lockfileが対応ソースに含まれない場合は公開を拒否する', () => {
  const result = validateReleaseReadiness(fixture({ trackedFiles: ['package-lock.json'] }));
  assert.match(result.errors.join('\n'), /src-tauri\/Cargo\.lock/);
});

test('npmライセンス一覧にローカルパスが残っている場合は公開を拒否する', () => {
  const result = validateReleaseReadiness(fixture({
    npmLicenseData: {
      libraries: [{ id: 'react@19.1.0', license: 'MIT', path: 'D:\\repo\\node_modules\\react' }],
    },
  }));
  assert.match(result.errors.join('\n'), /ローカルファイルパス/);
});

test('未コミット変更がある状態では対応ソースを生成しない', () => {
  assert.throws(() => assertCleanStatus(' M src/App.tsx'), /cleanなGit HEAD/);
  assert.doesNotThrow(() => assertCleanStatus(''));
});

test('対応ソースmanifestに版・commit・checksumを固定する', () => {
  const manifest = buildSourceManifest({
    version: '1.1.0',
    commit: '0123456789abcdef',
    archiveName: 'Auralyn_v1.1.0_Source.zip',
    size: 12345,
    sha256: 'a'.repeat(64),
    generatedAt: '2026-07-22T00:00:00.000Z',
  });

  assert.equal(manifest.license, 'GPL-3.0-only');
  assert.equal(manifest.commit, '0123456789abcdef');
  assert.equal(manifest.sha256, 'a'.repeat(64));
});

test('Tauri v2のWindows静的更新マニフェストを生成する', () => {
  const manifest = buildWindowsManifest({
    version: '1.1.0',
    repo: PUBLIC_REPO,
    tag: 'v1.1.0',
    assetName: 'Auralyn_1.1.0_x64-setup.exe',
    signature: 'signed-content\n',
    notes: '更新内容',
    pubDate: '2026-07-20T00:00:00.000Z',
  });

  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'signed-content');
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/blackflame7983/Auralyn-Releases/releases/download/v1.1.0/Auralyn_1.1.0_x64-setup.exe',
  );
});

test('指定バージョンと古い成果物の組み合わせを拒否する', () => {
  assert.throws(
    () => assertAssetMatchesVersion('Auralyn_1.0.0_x64-setup.exe', '1.1.0'),
    /指定バージョン 1\.1\.0 と一致しません/,
  );
});
