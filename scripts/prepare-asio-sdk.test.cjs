const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  assertWithin,
  calculateSha256,
  prepareAsioSdk,
} = require('./prepare-asio-sdk.cjs');

function writeFixtureSdk(sdkDir) {
  fs.mkdirSync(path.join(sdkDir, 'common'), { recursive: true });
  fs.mkdirSync(path.join(sdkDir, 'host', 'pc'), { recursive: true });
  fs.writeFileSync(
    path.join(sdkDir, 'LICENSE.txt'),
    'This SDK is alternatively licensed under the General Public License (GPL) Version 3.\n',
  );
  fs.writeFileSync(path.join(sdkDir, 'README.md'), 'ASIO SDK test fixture\n');
  fs.writeFileSync(path.join(sdkDir, 'common', 'asio.h'), '// test\n');
  fs.writeFileSync(path.join(sdkDir, 'common', 'asiosys.h'), '// test\n');
  fs.writeFileSync(path.join(sdkDir, 'host', 'asiodrivers.h'), '// test\n');
  fs.writeFileSync(path.join(sdkDir, 'host', 'pc', 'asiolist.cpp'), '// test\n');
}

test('固定SHA-256のASIO SDKだけを展開する', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-asio-test-'));
  const inputRoot = path.join(tempRoot, 'input');
  const cacheRoot = path.join(tempRoot, 'cache');
  const sdkDir = path.join(inputRoot, 'ASIOSDK');

  try {
    writeFixtureSdk(sdkDir);
    fs.mkdirSync(cacheRoot, { recursive: true });
    const archivePath = path.join(cacheRoot, 'ASIOSDK-2.3.4.zip');
    execFileSync('tar', ['-a', '-cf', archivePath, '-C', inputRoot, 'ASIOSDK']);
    const archiveSha256 = calculateSha256(archivePath);
    const policy = {
      asio: {
        sdkVersion: '2.3.4',
        sdkArchiveSha256: archiveSha256,
        licenseSource: 'https://www.steinberg.net/asiosdk',
      },
    };

    const prepared = prepareAsioSdk({ projectRoot: tempRoot, cacheRoot, policy });
    assert.equal(prepared.archiveSha256, archiveSha256);
    assert.equal(fs.existsSync(path.join(prepared.sdkDir, 'common', 'asio.h')), true);

    policy.asio.sdkArchiveSha256 = '0'.repeat(64);
    assert.throws(
      () => prepareAsioSdk({ projectRoot: tempRoot, cacheRoot, policy }),
      /SHA-256が固定値と一致しません/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cache外を作業パスとして扱わない', () => {
  const parent = path.join(os.tmpdir(), 'auralyn-safe-parent');
  assert.doesNotThrow(() => assertWithin(parent, path.join(parent, 'child')));
  assert.throws(() => assertWithin(parent, path.dirname(parent)), /安全でない作業パス/);
  assert.throws(() => assertWithin(parent, parent), /安全でない作業パス/);
});
