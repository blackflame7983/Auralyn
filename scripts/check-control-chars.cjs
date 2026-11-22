const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const TEXT_EXTENSIONS = new Set([
  '.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdc', '.toml', '.yml', '.yaml',
  '.css', '.html', '.svg', '.xml', '.py', '.ps1', '.txt', '.hbs',
]);
const TEXT_BASENAMES = new Set(['.gitignore', '.gitattributes']);
const FIX_HINT = 'PowerShell の二重引用符の中のバッククォートなどで混入しやすい。Write/Edit ツールで書き直す（docs/BUILD_GUIDE.md の PowerShell の注意を参照）';

const NAMES = new Map([
  [0x00, 'NUL'], [0x01, 'SOH'], [0x02, 'STX'], [0x03, 'ETX'], [0x04, 'EOT'], [0x05, 'ENQ'], [0x06, 'ACK'],
  [0x07, 'BEL'], [0x08, 'BS'], [0x0b, 'VT'], [0x0c, 'FF'], [0x0e, 'SO'], [0x0f, 'SI'], [0x10, 'DLE'],
  [0x11, 'DC1'], [0x12, 'DC2'], [0x13, 'DC3'], [0x14, 'DC4'], [0x15, 'NAK'], [0x16, 'SYN'], [0x17, 'ETB'],
  [0x18, 'CAN'], [0x19, 'EM'], [0x1a, 'SUB'], [0x1b, 'ESC'], [0x1c, 'FS'], [0x1d, 'GS'], [0x1e, 'RS'],
  [0x1f, 'US'], [0x7f, 'DEL'],
]);

function isTargetFile(fileName) {
  const base = path.posix.basename(fileName.split(path.sep).join('/'));
  return TEXT_BASENAMES.has(base) || TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function isForbiddenByte(byte) {
  return (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f;
}

// タブ・LF・CR 以外の C0 制御文字と DEL を、行番号つきで返す。同じ行の同じ種類は1件にまとめる。
function findControlChars(buffer) {
  const hits = [];
  const seen = new Set();
  let line = 1;
  for (const byte of buffer) {
    if (byte === 0x0a) line += 1;
    else if (isForbiddenByte(byte)) {
      const key = `${line}:${byte}`;
      if (!seen.has(key)) {
        seen.add(key);
        const hex = byte.toString(16).toUpperCase().padStart(2, '0');
        hits.push({ line, byte, name: NAMES.get(byte) ?? `0x${hex}`, code: `U+00${hex}` });
      }
    }
  }
  return hits;
}

function checkControlChars(files) {
  const errors = [];
  for (const file of files) {
    for (const hit of findControlChars(file.buffer)) {
      errors.push(`${file.name}:${hit.line}: 制御文字 ${hit.name} (${hit.code}) が入っている\n  直し方: ${FIX_HINT}`);
    }
  }
  return errors;
}

function listTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

function runControlCharsCheck(names) {
  const files = names
    .filter(isTargetFile)
    .filter(name => fs.existsSync(path.join(ROOT, name)))
    .map(name => ({ name, buffer: fs.readFileSync(path.join(ROOT, name)) }));
  const errors = checkControlChars(files);
  if (errors.length > 0) {
    const failure = new Error(`制御文字の検査に失敗しました (${errors.length}件)`);
    failure.errors = errors;
    throw failure;
  }
  return files.length;
}

// 引数なしは追跡している全ファイル。--files の後ろに並べた名前だけを見る（verify の --changed 用）。
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--files');
    const names = index >= 0 ? args.slice(index + 1) : listTrackedFiles();
    const count = runControlCharsCheck(names);
    console.log(`Control characters: PASS (${count} files)`);
  } catch (error) {
    if (error && Array.isArray(error.errors)) {
      for (const line of error.errors) console.error(line);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  isTargetFile,
  findControlChars,
  checkControlChars,
  runControlCharsCheck,
};
