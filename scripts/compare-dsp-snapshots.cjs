const fs = require('node:fs');
const path = require('node:path');

function expectedSnapshots() {
  const expected = new Map();
  const frameBytes = 481 * 4; // 480サンプルとVADをu32として保存する。
  for (let kind = 0; kind < 6; kind += 1) expected.set(`cold-${kind}.bin`, 32 * frameBytes);
  for (const custom of [false, true]) {
    for (const dirty of [0, 1, 7, 32]) expected.set(`reset-${custom}-${dirty}.bin`, 32 * frameBytes);
  }
  for (let reset = 0; reset < 3; reset += 1) expected.set(`borrowed-${reset}.bin`, 32 * frameBytes);
  expected.set('clone.bin', 25 * frameBytes);
  for (const rate of [8000, 44100, 48000, 96000, 192000]) {
    for (const dirty of [0, 1, 440, 480, 511, 2000]) {
      expected.set(`engine-${rate}-${dirty}.bin`, 8192 * 2 * 4);
    }
  }
  return expected;
}

function compareSnapshots(debugDir, releaseDir) {
  if (fs.realpathSync(debugDir) === fs.realpathSync(releaseDir)) {
    throw new Error('debugとreleaseには別の記録先を指定してください');
  }
  const expected = expectedSnapshots();
  const names = [...expected.keys()].sort();
  for (const dir of [debugDir, releaseDir]) {
    if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify(names)) {
      throw new Error(`記録ファイルの集合が48ケースと一致しません: ${dir}`);
    }
  }
  let bytes = 0;
  for (const [name, size] of expected) {
    const buffers = [debugDir, releaseDir].map((dir) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size !== size) throw new Error(`記録サイズが不正です: ${file}`);
      return fs.readFileSync(file);
    });
    if (!buffers[0].equals(buffers[1])) throw new Error(`出力ビット列が一致しません: ${name}`);
    bytes += size;
  }
  return { files: expected.size, bytes, bitwiseEqual: true };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('使用法: node scripts/compare-dsp-snapshots.cjs <debug記録先> <release記録先>');
    console.log(JSON.stringify(compareSnapshots(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { compareSnapshots, expectedSnapshots };
