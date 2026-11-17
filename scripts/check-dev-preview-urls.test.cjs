const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findDevPreviewUrls,
  isTargetSpec,
  listSpecFiles,
  checkDevPreviewUrls,
} = require('./check-dev-preview-urls.cjs');

test('?mock=、?screen=、&screen= を含む URL を、行番号つきで見つける', () => {
  const source = [
    "await page.goto('/?mock=live-home');",
    "await page.goto('/');",
    'await page.goto(`/?screen=${name}`);',
    "await page.goto('/?foo=1&screen=settings');",
  ].join('\n');
  assert.deepEqual(findDevPreviewUrls(source).map(hit => hit.line), [1, 3, 4]);
});

test('名前が似ているだけの引数は見つけない', () => {
  const source = [
    "await page.goto('/?lang=ja');",
    "const mockData = 'screenshot=1';",
    "await page.goto('/?smock=1');",
  ].join('\n');
  assert.deepEqual(findDevPreviewUrls(source), []);
});

test('行コメントとブロックコメントの中の言及は無視する', () => {
  const source = [
    '// 開発プレビュー（?mock=）の画面記録。',
    "await page.goto('/'); // ?screen=settings は使わない",
    '/*',
    ' * ?mock=live-home&screen=voice-check',
    ' */',
    "await page.goto('/');",
  ].join('\n');
  assert.deepEqual(findDevPreviewUrls(source), []);
});

test('ブロックコメントのあとでも、行番号と元の行を出す', () => {
  const source = "/* 1行目\n2行目 */\nawait page.goto('/?mock=a'); // 3行目";
  assert.deepEqual(findDevPreviewUrls(source), [{ line: 3, text: "await page.goto('/?mock=a'); // 3行目" }]);
});

test('正規表現リテラルの中の // や引用符で、文字列とコメントを取り違えない', () => {
  assert.deepEqual(findDevPreviewUrls('const re = /[//]/; await page.goto("/?mock=live-home");').map(hit => hit.line), [1]);
  assert.deepEqual(findDevPreviewUrls('const re = /"/; // ?mock=documentation-only\nawait page.goto("/");'), []);
  assert.deepEqual(findDevPreviewUrls("const re = /'/;\nawait page.goto(`/?screen=${/`/.source}`);").map(hit => hit.line), [2]);
});

test('正規表現リテラルそのものは URL として扱わない', () => {
  assert.deepEqual(findDevPreviewUrls('expect(page.url()).not.toMatch(/[?&]mock=/);'), []);
});

test('文字列の中の // はコメントとして扱わない', () => {
  const source = "await page.goto('http://localhost/?screen=home');";
  assert.deepEqual(findDevPreviewUrls(source).map(hit => hit.line), [1]);
});

test('テンプレート文字列の ${ } の中に別のテンプレートがあっても、後ろの行を見失わない', () => {
  const source = [
    'const name = `${flag ? `a` : `b`}`;',
    '// ?mock= の説明',
    'await page.goto(`/?mock=${name}`);',
  ].join('\n');
  assert.deepEqual(findDevPreviewUrls(source).map(hit => hit.line), [3]);
});

test('画面記録の試験（*-shots.spec.ts）は対象から除く', () => {
  assert.equal(isTargetSpec('dialog-overflow.spec.ts'), true);
  assert.equal(isTargetSpec('design-renewal-d-shots.spec.ts'), false);
  assert.equal(isTargetSpec('tauriFixture.ts'), false);
  assert.equal(isTargetSpec('notes.md'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preview-urls-'));
  try {
    fs.mkdirSync(path.join(dir, 'browser'));
    fs.writeFileSync(path.join(dir, 'browser', 'a.spec.ts'), '');
    fs.writeFileSync(path.join(dir, 'browser', 'a-shots.spec.ts'), '');
    fs.writeFileSync(path.join(dir, 'browser', 'helper.ts'), '');
    assert.deepEqual(
      listSpecFiles(dir).map(file => path.relative(dir, file).split(path.sep).join('/')),
      ['browser/a.spec.ts'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('違反はファイル名、行番号、直し方を出す', () => {
  const errors = checkDevPreviewUrls([
    { name: 'e2e/browser/ok.spec.ts', source: "await page.goto('/');" },
    { name: 'e2e/browser/bad.spec.ts', source: "\nawait page.goto('/?screen=voice-check');" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^e2e\/browser\/bad\.spec\.ts:2:/);
  assert.match(errors[0], /試験の模擬応答（tauriFixture）と UI 操作で画面を開く/);
});

test('違反が無ければ空', () => {
  assert.deepEqual(checkDevPreviewUrls([
    { name: 'e2e/browser/ok.spec.ts', source: "// ?mock=\nawait page.goto('/');" },
  ]), []);
});

test('現行の e2e に、開発プレビューの URL は無い', () => {
  const root = path.resolve(__dirname, '..');
  const files = listSpecFiles(path.join(root, 'e2e')).map(full => ({
    name: path.relative(root, full).split(path.sep).join('/'),
    source: fs.readFileSync(full, 'utf8'),
  }));
  assert.ok(files.length > 0);
  assert.deepEqual(checkDevPreviewUrls(files), []);
});
