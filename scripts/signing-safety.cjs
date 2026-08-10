const fs = require('fs');
const path = require('path');

function signingKeyText(env = process.env) {
  const keyValue = env.TAURI_SIGNING_PRIVATE_KEY;
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH
    || (keyValue && fs.existsSync(keyValue) ? keyValue : null);

  if (!keyValue && !keyPath) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY または TAURI_SIGNING_PRIVATE_KEY_PATH が必要です。');
  }

  return keyPath ? fs.readFileSync(keyPath, 'utf8').trim() : String(keyValue).trim();
}

function isEncryptedSigningKey(keyText) {
  const candidates = [String(keyText)];
  try {
    candidates.push(Buffer.from(String(keyText).trim(), 'base64').toString('utf8'));
  } catch {
    // A non-base64 key can still be inspected as plain text.
  }
  return candidates.some((candidate) => /encrypted secret key/i.test(candidate));
}

function assertSigningEnvironment(env = process.env) {
  const keyText = signingKeyText(env);
  if (isEncryptedSigningKey(keyText) && !env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    throw new Error(
      'Tauri署名鍵は暗号化されています。TAURI_SIGNING_PRIVATE_KEY_PASSWORDを設定してください。',
    );
  }
}

function clearStaleSignatures(bundleDir, version) {
  for (const target of ['nsis', 'msi']) {
    const dir = path.join(bundleDir, target);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isFile()
        && entry.name.endsWith('.sig')
        && entry.name.includes(version)
      ) {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      }
    }
  }
}

function assertFreshSignature(installerPath, signaturePath) {
  if (!fs.existsSync(signaturePath)) {
    throw new Error(`Signature not found: ${signaturePath}`);
  }
  const installer = fs.statSync(installerPath);
  const signature = fs.statSync(signaturePath);
  if (signature.size === 0 || signature.mtimeMs < installer.mtimeMs) {
    throw new Error(`署名がインストーラーより古いか空です: ${signaturePath}`);
  }
}

module.exports = {
  assertFreshSignature,
  assertSigningEnvironment,
  clearStaleSignatures,
  isEncryptedSigningKey,
  signingKeyText,
};
