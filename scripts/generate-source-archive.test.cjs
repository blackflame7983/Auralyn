const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSourceArchive, calculateSha256 } = require('./generate-source-archive.cjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('cleanなcommitから対応ソース一式を生成する', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-source-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outputDir = path.join(tempRoot, 'output');
  const asioSdkDir = path.join(tempRoot, 'asio-sdk');

  try {
    fs.mkdirSync(path.join(projectRoot, 'src-tauri'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(asioSdkDir, 'common'), { recursive: true });
    fs.mkdirSync(path.join(asioSdkDir, 'host', 'pc'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
    fs.writeFileSync(path.join(projectRoot, 'NOTICE.md'), 'GPL-3.0-only WITHOUT ANY WARRANTY\n');
    fs.writeFileSync(path.join(projectRoot, 'SOURCE-DISTRIBUTION.md'), 'Corresponding Source\n');
    fs.writeFileSync(path.join(projectRoot, '.gitattributes'), 'release_artifacts export-ignore\n');
    fs.writeFileSync(
      path.join(projectRoot, 'config', 'release-policy.json'),
      JSON.stringify({
        asio: {
          sdkVersion: '2.3.4',
          licenseSource: 'https://www.steinberg.net/asiosdk',
          sdkArchiveSha256: 'b'.repeat(64),
        },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'auralyn', version: '1.1.0', license: 'GPL-3.0-only' }),
    );
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}\n');
    fs.writeFileSync(
      path.join(projectRoot, 'src-tauri', 'tauri.conf.json'),
      JSON.stringify({ version: '1.1.0' }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'src-tauri', 'Cargo.toml'),
      '[package]\nname = "vst-host"\nversion = "1.1.0"\nlicense = "GPL-3.0-only"\n',
    );
    fs.writeFileSync(path.join(projectRoot, 'src-tauri', 'Cargo.lock'), 'version = 4\n');
    // ローカル依存の修正ソース・モデル・ライセンスもgit archiveから配布する。
    const localDspRoot = path.join(projectRoot, 'third_party', 'nnnoiseless-0.5.2');
    fs.mkdirSync(path.join(localDspRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(localDspRoot, '.gitattributes'), '* text eol=lf\nsrc/weights.rnn -text\n');
    fs.writeFileSync(path.join(localDspRoot, 'Cargo.toml'), '[package]\nname="nnnoiseless"\nversion="0.5.2"\n');
    fs.writeFileSync(path.join(localDspRoot, 'COPYING'), 'BSD-3-Clause fixture\n');
    fs.writeFileSync(path.join(localDspRoot, 'PATCHES.md'), '# Local modifications fixture\n');
    fs.writeFileSync(path.join(localDspRoot, 'UPSTREAM_HASHES.json'), '{}\n');
    fs.writeFileSync(path.join(localDspRoot, 'src', 'fft.rs'), '// local FFT workspace fixture\n');
    fs.writeFileSync(path.join(localDspRoot, 'src', 'weights.rnn'), Buffer.from([1, 13, 10, 2, 3]));
    fs.writeFileSync(
      path.join(asioSdkDir, 'LICENSE.txt'),
      'This SDK is alternatively licensed under the General Public License (GPL) Version 3.\n',
    );
    fs.writeFileSync(path.join(asioSdkDir, 'README.md'), 'ASIO SDK test fixture\n');
    fs.writeFileSync(path.join(asioSdkDir, 'changes.txt'), '2.3.4\n');
    fs.writeFileSync(path.join(asioSdkDir, 'common', 'asio.h'), '// test\n');
    fs.writeFileSync(path.join(asioSdkDir, 'common', 'asiosys.h'), '// test\n');
    fs.writeFileSync(path.join(asioSdkDir, 'host', 'asiodrivers.h'), '// test\n');
    fs.writeFileSync(path.join(asioSdkDir, 'host', 'pc', 'asiolist.cpp'), '// test\n');

    git(projectRoot, ['init']);
    git(projectRoot, ['config', 'user.name', 'Auralyn Test']);
    git(projectRoot, ['config', 'user.email', 'test@example.invalid']);
    git(projectRoot, ['add', '.']);
    git(projectRoot, ['commit', '-m', 'source fixture']);

    const result = createSourceArchive({ projectRoot, outputDir, version: '1.1.0', asioSdkDir });
    const expectedCommit = git(projectRoot, ['rev-parse', 'HEAD']);
    const listing = execFileSync('tar', ['-tf', result.archivePath], { encoding: 'utf8' });

    assert.equal(result.manifest.commit, expectedCommit);
    assert.equal(result.manifest.sha256, calculateSha256(result.archivePath));
    assert.match(listing, /Auralyn-1\.1\.0\/LICENSE/);
    assert.match(listing, /Auralyn-1\.1\.0\/package-lock\.json/);
    assert.match(listing, /Auralyn-1\.1\.0\/src-tauri\/Cargo\.lock/);
    assert.match(listing, /third_party\/Steinberg-ASIO-SDK-2\.3\.4\/common\/asio\.h/);
    assert.match(listing, /third_party\/Steinberg-ASIO-SDK-2\.3\.4\/LICENSE\.txt/);
    for (const file of ['Cargo.toml', 'COPYING', 'PATCHES.md', 'UPSTREAM_HASHES.json', 'src/fft.rs', 'src/weights.rnn']) {
      const archived = execFileSync('tar', ['-xOf', result.archivePath, `Auralyn-1.1.0/third_party/nnnoiseless-0.5.2/${file}`]);
      assert.deepEqual(archived, fs.readFileSync(path.join(localDspRoot, file)));
    }
    assert.equal(fs.existsSync(result.checksumPath), true);
    assert.equal(fs.existsSync(result.manifestPath), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
