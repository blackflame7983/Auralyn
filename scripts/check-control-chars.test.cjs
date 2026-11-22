const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTargetFile,
  findControlChars,
  checkControlChars,
} = require('./check-control-chars.cjs');

test('タブ・LF・CRLF だけなら通る', () => {
  const buffer = Buffer.from('a\tb\r\nc\nd\r\n', 'utf8');
  assert.deepEqual(findControlChars(buffer), []);
});

test('日本語など通常の文字は通る', () => {
  assert.deepEqual(findControlChars(Buffer.from('音声 ✓ `code`\n', 'utf8')), []);
});

test('ESC・BS・NUL・FF・DEL を、行番号と種類つきで見つける', () => {
  const buffer = Buffer.from([0x61, 0x0a, 0x1b, 0x0a, 0x08, 0x62, 0x0a, 0x00, 0x0c, 0x0a, 0x7f]);
  const hits = findControlChars(buffer);
  assert.deepEqual(hits.map(hit => [hit.line, hit.name]), [
    [2, 'ESC'], [3, 'BS'], [4, 'NUL'], [4, 'FF'], [5, 'DEL'],
  ]);
});

test('同じ行の同じ文字は1件にまとめる', () => {
  const buffer = Buffer.from([0x1b, 0x1b, 0x1b]);
  assert.equal(findControlChars(buffer).length, 1);
});

test('エラーにファイル名と行と種類を含める', () => {
  const errors = checkControlChars([
    { name: 'docs/a.md', buffer: Buffer.from('ok\n', 'utf8') },
    { name: 'docs/b.md', buffer: Buffer.from([0x6f, 0x0a, 0x1b]) },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^docs\/b\.md:2: 制御文字 ESC/);
});

test('対象はテキストの拡張子だけで、画像などは見ない', () => {
  for (const name of ['a.rs', 'src/b.tsx', 'c.json', 'd.md', 'e.toml', 'f.yml', 'g.css', 'h.html', '.gitignore']) {
    assert.equal(isTargetFile(name), true, name);
  }
  for (const name of ['a.png', 'b.ico', 'c.bmp', 'd.pen', 'e.lock']) {
    assert.equal(isTargetFile(name), false, name);
  }
});
