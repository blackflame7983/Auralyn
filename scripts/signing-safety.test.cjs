const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertFreshSignature,
  assertSigningEnvironment,
  clearStaleSignatures,
  isEncryptedSigningKey,
} = require('./signing-safety.cjs');

test('base64化された暗号化署名鍵も検出する', () => {
  const encoded = Buffer.from('untrusted comment: minisign encrypted secret key').toString('base64');
  assert.equal(isEncryptedSigningKey(encoded), true);
  assert.throws(
    () => assertSigningEnvironment({ TAURI_SIGNING_PRIVATE_KEY: encoded }),
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/,
  );
  assert.doesNotThrow(() => assertSigningEnvironment({
    TAURI_SIGNING_PRIVATE_KEY: encoded,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'configured',
  }));
});

test('同じ版の古い署名だけをビルド前に削除する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-signing-'));
  try {
    const nsisDir = path.join(root, 'nsis');
    fs.mkdirSync(nsisDir, { recursive: true });
    fs.writeFileSync(path.join(nsisDir, 'Auralyn_1.1.0_x64-setup.exe.sig'), 'stale');
    fs.writeFileSync(path.join(nsisDir, 'Auralyn_1.0.0_x64-setup.exe.sig'), 'keep');
    clearStaleSignatures(root, '1.1.0');
    assert.equal(fs.existsSync(path.join(nsisDir, 'Auralyn_1.1.0_x64-setup.exe.sig')), false);
    assert.equal(fs.existsSync(path.join(nsisDir, 'Auralyn_1.0.0_x64-setup.exe.sig')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('インストーラーより古い署名を拒否する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-signature-age-'));
  try {
    const installer = path.join(root, 'app.exe');
    const signature = `${installer}.sig`;
    fs.writeFileSync(signature, 'old signature');
    fs.writeFileSync(installer, 'new installer');
    const now = Date.now() / 1000;
    fs.utimesSync(signature, now - 10, now - 10);
    fs.utimesSync(installer, now, now);
    assert.throws(() => assertFreshSignature(installer, signature), /古いか空/);
    fs.utimesSync(signature, now + 1, now + 1);
    assert.doesNotThrow(() => assertFreshSignature(installer, signature));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
