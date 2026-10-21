const fs = require('fs');
const path = require('path');

// 古いMSIがbundleに残っていても、通常版の公開候補には採用しない。
function findNsisInstaller(bundleDir, version) {
  const directory = path.join(bundleDir, 'nsis');
  if (!fs.existsSync(directory)) return null;
  const find = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.includes(`_${version}_`) && entry.name.endsWith('.exe')) return full;
      if (entry.isDirectory()) {
        const found = find(full);
        if (found) return found;
      }
    }
    return null;
  };
  return find(directory);
}

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
  findNsisInstaller,
  assertAssetMatchesVersion,
  buildWindowsManifest,
  writeWindowsManifest,
};
