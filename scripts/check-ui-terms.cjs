const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// かぎかっこ（「」『』）と空白だけを、同じ語句のあいだに挟める。
const JA_BRACKETS = new Set(['「', '」', '『', '』']);

function isJaSeparator(char) {
  return JA_BRACKETS.has(char) || /\s/u.test(char);
}

function parseMessages(source) {
  const lines = source.split(/\r?\n/);
  const messages = { ja: {}, en: {} };
  const errors = [];
  const jaStart = lines.findIndex(line => /^const ja = \{\s*$/.test(line));
  const enStart = lines.findIndex(line => /^const en\b.*\{\s*$/.test(line));
  if (jaStart < 0) errors.push('読めない行: ja のオブジェクトがありません');
  if (enStart < 0) errors.push('読めない行: en のオブジェクトがありません');
  if (jaStart >= 0) errors.push(...readLocale(lines, jaStart + 1, 'ja', messages.ja).errors);
  if (enStart >= 0) errors.push(...readLocale(lines, enStart + 1, 'en', messages.en).errors);
  return { messages, errors };
}

function readLocale(lines, start, locale, messages) {
  const errors = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    if (/^\s*\}\s*(?:as const)?;?\s*$/.test(line)) return { errors };
    if (/^\s*$/.test(line) || /^\s*,\s*$/.test(line)) continue;
    const matched = line.match(/^\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/);
    if (!matched) {
      errors.push(`読めない行: ${locale} ${lineNo}: ${line.trim()}`);
      continue;
    }
    try {
      const key = JSON.parse(`"${matched[1]}"`);
      const value = JSON.parse(`"${matched[2]}"`);
      messages[key] = value;
    } catch {
      errors.push(`読めない行: ${locale} ${lineNo}: ${line.trim()}`);
    }
  }
  errors.push(`読めない行: ${locale} のオブジェクトが閉じていません`);
  return { errors };
}

function glossaryUseNames(design) {
  const parts = design.split(/^## 4\. 用語集\s*$/m);
  if (parts.length < 2) return { uses: [], errors: ['用語集: 4章が見つかりません'] };
  const section = parts[1].split(/^## /m)[0];
  const uses = [];
  let sawTable = false;
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    sawTable = true;
    if (/^\|\s*:?-+/.test(line)) continue;
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    if (cells[0] === '概念') continue;
    if (!cells[1]) return { uses, errors: [`用語集: 使う語が空の行があります: ${line.trim()}`] };
    uses.push(cells[1]);
  }
  if (!sawTable) return { uses, errors: ['用語集: 4章の表が見つかりません'] };
  return { uses, errors: [] };
}

function validateTermsConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['用語定義: オブジェクトではありません'];
  }
  if (!Array.isArray(config.terms)) return ['用語定義: terms が配列ではありません'];
  if (!Array.isArray(config.allow)) return ['用語定義: allow が配列ではありません'];
  const errors = [];
  config.terms.forEach((term, index) => {
    if (!term || typeof term.use !== 'string' || term.use.trim() === '') {
      errors.push(`用語定義: terms[${index}].use が空です`);
    }
    if (!Array.isArray(term.avoid) || term.avoid.some(item => typeof item !== 'string' || item.trim() === '')) {
      errors.push(`用語定義: terms[${index}].avoid が空でない文字列の配列ではありません`);
    }
    if (!term || (term.locale !== 'ja' && term.locale !== 'en')) {
      errors.push(`用語定義: terms[${index}].locale が ja または en ではありません`);
    }
    if (term && term.ref !== undefined && typeof term.ref !== 'string') {
      errors.push(`用語定義: terms[${index}].ref が文字列ではありません`);
    }
  });
  config.allow.forEach((item, index) => {
    if (!item
      || typeof item.key !== 'string' || item.key.trim() === ''
      || typeof item.term !== 'string' || item.term.trim() === ''
      || typeof item.reason !== 'string' || item.reason.trim() === '') {
      errors.push(`用語定義: allow[${index}] には key、term、reason が必要です`);
    }
  });
  return errors;
}

function isAllowed(allow, key, term) {
  return allow.some(item => item.key === key && item.term === term);
}

function sourceSuffix(ref) {
  return ref ? `、出どころ: ${ref}` : '';
}

function findAvoidViolations(messages, terms, allow) {
  const errors = [];
  for (const term of terms) {
    const values = messages[term.locale] || {};
    for (const banned of term.avoid) {
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string' || !value.includes(banned)) continue;
        if (isAllowed(allow, key, banned)) continue;
        errors.push(`使わない語: ${term.locale} ${key} に「${banned}」（使う語: 「${term.use}」${sourceSuffix(term.ref)}）`);
      }
    }
  }
  return errors;
}

function findJaRepeats(text) {
  const chars = Array.from(text);
  const found = [];
  for (let start = 0; start < chars.length; start += 1) {
    let longest = 0;
    for (let length = 3; start + length < chars.length; length += 1) {
      if (!isJaSeparator(chars[start + length])) continue;
      let next = start + length;
      while (next < chars.length && isJaSeparator(chars[next])) next += 1;
      if (next + length > chars.length) continue;
      let same = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (chars[start + offset] !== chars[next + offset]) {
          same = false;
          break;
        }
      }
      if (same) longest = length;
    }
    if (longest > 0) found.push(chars.slice(start, start + longest).join(''));
  }
  const maximal = found.filter(phrase => !found.some(other => other.length > phrase.length && other.includes(phrase)));
  return [...new Set(maximal)];
}

function findEnRepeats(text) {
  const words = [];
  const pattern = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  let match = pattern.exec(text);
  while (match) {
    words.push({ word: match[0], index: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  const found = [];
  for (let index = 1; index < words.length; index += 1) {
    const gap = text.slice(words[index - 1].end, words[index].index);
    if (!/^\s+$/u.test(gap)) continue;
    if (words[index - 1].word.toLowerCase() !== words[index].word.toLowerCase()) continue;
    found.push(words[index - 1].word.toLowerCase());
  }
  return [...new Set(found)];
}

function findRepeatViolations(messages, allow) {
  const errors = [];
  for (const [key, value] of Object.entries(messages.ja || {})) {
    if (typeof value !== 'string') continue;
    for (const phrase of findJaRepeats(value)) {
      if (isAllowed(allow, key, phrase)) continue;
      errors.push(`語句の重なり: ja ${key} に「${phrase}」`);
    }
  }
  for (const [key, value] of Object.entries(messages.en || {})) {
    if (typeof value !== 'string') continue;
    for (const word of findEnRepeats(value)) {
      if (isAllowed(allow, key, word)) continue;
      errors.push(`語句の重なり: en ${key} に「${word}」`);
    }
  }
  return errors;
}

function findUseMismatches(terms, uses) {
  const errors = [];
  for (const term of terms) {
    if (typeof term.use !== 'string' || term.use === '') continue;
    if (uses.some(name => name.includes(term.use))) continue;
    errors.push(`用語集に無い使う語: ${term.locale} 「${term.use}」が4章の使う語にありません${sourceSuffix(term.ref)}`);
  }
  return errors;
}

function checkUiTerms({ messagesSource, designSource, termsConfig }) {
  const parsed = parseMessages(messagesSource);
  const glossary = glossaryUseNames(designSource);
  const configErrors = validateTermsConfig(termsConfig);
  const errors = [...parsed.errors, ...glossary.errors, ...configErrors];
  if (configErrors.length > 0) return errors;
  errors.push(...findAvoidViolations(parsed.messages, termsConfig.terms, termsConfig.allow));
  errors.push(...findRepeatViolations(parsed.messages, termsConfig.allow));
  if (glossary.errors.length === 0) {
    errors.push(...findUseMismatches(termsConfig.terms, glossary.uses));
  }
  return errors;
}

function runUiTermsCheck() {
  let termsConfig;
  try {
    termsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ui-terms.json'), 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`用語定義を読めません: ${message}`);
  }
  const messagesSource = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
  const designSource = fs.readFileSync(path.join(ROOT, 'docs', 'DESIGN.md'), 'utf8');
  const errors = checkUiTerms({ messagesSource, designSource, termsConfig });
  if (errors.length > 0) {
    const failure = new Error(`UI用語の検査に失敗しました (${errors.length}件)`);
    failure.errors = errors;
    throw failure;
  }
  return errors;
}

if (require.main === module) {
  try {
    runUiTermsCheck();
    console.log('UI terms: PASS');
  } catch (error) {
    if (error && Array.isArray(error.errors)) {
      for (const line of error.errors) console.error(line);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  parseMessages,
  glossaryUseNames,
  validateTermsConfig,
  findAvoidViolations,
  findJaRepeats,
  findEnRepeats,
  findRepeatViolations,
  findUseMismatches,
  checkUiTerms,
  runUiTermsCheck,
};
