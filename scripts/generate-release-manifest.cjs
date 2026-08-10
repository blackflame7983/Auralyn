const fs = require('fs');

function assertAssetMatchesVersion(assetName, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionToken = new RegExp(`(?:^|[_-])${escapedVersion}(?:[_-]|\\.)`);
  if (!versionToken.test(assetName)) {
    throw new Error(`成果物 ${assetName} は指定バージョン ${version} と一致しません。再ビルドしてください。`);
  }
}

function buildWindowsManifest({ version, repo, tag, assetName, signature, notes = '', pubDate }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`有効なSemVerではありません: ${version}`);
  }
  if (!repo || !tag || !assetName || !signature) {
    throw new Error('repo、tag、assetName、signatureは必須です。');
  }
  assertAssetMatchesVersion(assetName, version);

  const encodedAssetName = assetName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  return {
    version,
    notes,
    pub_date: pubDate || new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${encodedAssetName}`,
      },
    },
  };
}

function writeWindowsManifest(filePath, options) {
  const manifest = buildWindowsManifest(options);
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

module.exports = {
  assertAssetMatchesVersion,
  buildWindowsManifest,
  writeWindowsManifest,
};
