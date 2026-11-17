const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const E2E_DIR = 'e2e';

const SHOTS_SUFFIX = '-shots.spec.ts';
const SPEC_SUFFIX = '.spec.ts';
const DEV_PREVIEW_URL = /[?&](?:mock|screen)=/;
const FIX_HINT = '試験の模擬応答（tauriFixture）と UI 操作で画面を開く';

const STRING_PIECE_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// 文字列とテンプレートの断片だけを見る。コメントと正規表現リテラルは構文木に文字列として現れない。
function findDevPreviewUrls(source, fileName = 'spec.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split(/\r?\n/);
  const hitLines = new Set();
  const visit = node => {
    if (STRING_PIECE_KINDS.has(node.kind) && DEV_PREVIEW_URL.test(node.text)) {
      hitLines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...hitLines].sort((a, b) => a - b).map(line => ({ line: line + 1, text: lines[line].trim() }));
}

function isTargetSpec(fileName) {
  return fileName.endsWith(SPEC_SUFFIX) && !fileName.endsWith(SHOTS_SUFFIX);
}

function listSpecFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSpecFiles(full));
    else if (isTargetSpec(entry.name)) files.push(full);
  }
  return files.sort();
}

function checkDevPreviewUrls(files) {
  const errors = [];
  for (const file of files) {
    for (const hit of findDevPreviewUrls(file.source, file.name)) {
      errors.push(`${file.name}:${hit.line}: 開発プレビューの URL（?mock= / ?screen=）は CI の本番ビルドに無い: ${hit.text}\n  直し方: ${FIX_HINT}`);
    }
  }
  return errors;
}

function runDevPreviewUrlsCheck() {
  const files = listSpecFiles(path.join(ROOT, E2E_DIR)).map(full => ({
    name: path.relative(ROOT, full).split(path.sep).join('/'),
    source: fs.readFileSync(full, 'utf8'),
  }));
  const errors = checkDevPreviewUrls(files);
  if (errors.length > 0) {
    const failure = new Error(`開発プレビューの URL の検査に失敗しました (${errors.length}件)`);
    failure.errors = errors;
    throw failure;
  }
  return files.length;
}

if (require.main === module) {
  try {
    const count = runDevPreviewUrlsCheck();
    console.log(`Dev preview URLs: PASS (${count} files)`);
  } catch (error) {
    if (error && Array.isArray(error.errors)) {
      for (const line of error.errors) console.error(line);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  findDevPreviewUrls,
  isTargetSpec,
  listSpecFiles,
  checkDevPreviewUrls,
  runDevPreviewUrlsCheck,
};
