const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const E2E_DIR = 'e2e';

const SHOTS_SUFFIX = '-shots.spec.ts';
const SPEC_SUFFIX = '.spec.ts';
const DEV_PREVIEW_URL = /[?&](?:mock|screen)=/;
const FIX_HINT = '試験の模擬応答（tauriFixture）と UI 操作で画面を開く';

// 文字列の中身は残し、コメントだけを空白にする。改行は残すので行番号は変わらない。
function stripComments(source) {
  let out = '';
  let index = 0;
  // 'code' の上に、テンプレート文字列の ${ } の深さを積む。
  const templates = [];
  let braceDepth = 0;
  const blank = text => text.replace(/[^\r\n]/g, ' ');

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') {
        end += source[end] === '\\' ? 2 : 1;
      }
      const stop = Math.min(end + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '`') {
      index = readTemplate(source, index + 1, templates, (text) => { out += text; }, '`');
      continue;
    }
    if (char === '{') braceDepth += 1;
    if (char === '}') {
      if (templates.length > 0 && templates[templates.length - 1] === braceDepth) {
        templates.pop();
        braceDepth -= 1;
        out += char;
        index = readTemplate(source, index + 1, templates, (text) => { out += text; }, '');
        continue;
      }
      braceDepth -= 1;
    }
    out += char;
    index += 1;
  }
  return out;

  // テンプレート文字列の本体を読む。`${` に入ったら通常のコードへ戻る。
  function readTemplate(text, start, stack, emit, opener) {
    let cursor = start;
    emit(opener);
    while (cursor < text.length) {
      const current = text[cursor];
      if (current === '\\') {
        emit(text.slice(cursor, cursor + 2));
        cursor += 2;
        continue;
      }
      if (current === '`') {
        emit(current);
        return cursor + 1;
      }
      if (current === '$' && text[cursor + 1] === '{') {
        emit('${');
        braceDepth += 1;
        stack.push(braceDepth);
        return cursor + 2;
      }
      emit(current);
      cursor += 1;
    }
    return cursor;
  }
}

function findDevPreviewUrls(source) {
  const lines = stripComments(source).split(/\r?\n/);
  const found = [];
  lines.forEach((line, index) => {
    if (DEV_PREVIEW_URL.test(line)) found.push({ line: index + 1, text: line.trim() });
  });
  return found;
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
    for (const hit of findDevPreviewUrls(file.source)) {
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
  stripComments,
  findDevPreviewUrls,
  isTargetSpec,
  listSpecFiles,
  checkDevPreviewUrls,
  runDevPreviewUrlsCheck,
};
