const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseMessages,
  glossaryUseNames,
  findAvoidViolations,
  findJaRepeats,
  findEnRepeats,
  findRepeatViolations,
  findUseMismatches,
  checkUiTerms,
} = require('./check-ui-terms.cjs');

const ROOT = path.resolve(__dirname, '..');

const DESIGN = [
  '## 4. 用語集',
  '',
  '| 概念 | 正規名 | 使わない表記 | 補足 |',
  '| :--- | :--- | :--- | :--- |',
  '| ホームの稼働表示 | 実行中 | 処理稼働中 | |',
  '| 送り出す音 | マイクの音 | 通常送出、送出音 | |',
  '| 仮想オーディオケーブル | 仮想ケーブル | 仮想デバイス、仮想オーディオデバイス | |',
  '| 聴き比べ | VST を外して比較（Bypass VST） | Compare without VST | |',
  '',
  '## 5. 次',
  '',
].join('\n');

function messagesSource(jaLines, enLines) {
  return [
    'const ja = {',
    ...jaLines,
    '} as const;',
    'const en: Record<MessageKey, string> = {',
    ...enLines,
    '};',
  ].join('\n');
}

const TERMS = {
  terms: [
    { use: '実行中', avoid: ['処理稼働中'], locale: 'ja', ref: '#599' },
    { use: 'マイクの音', avoid: ['通常送出', '送出音'], locale: 'ja' },
    { use: '仮想ケーブル', avoid: ['仮想デバイス', '仮想オーディオデバイス'], locale: 'ja' },
    { use: 'Bypass VST', avoid: ['Compare without VST'], locale: 'en', ref: '#609' },
  ],
  allow: [],
};

test('使わない語を見つけ、似た別の語と例外は見つけない', () => {
  const parsed = parseMessages(messagesSource(
    [
      '    "status.running": "いまは処理稼働中です",',
      '    "status.similar": "いまは処理中です",',
      '    "status.allowed": "処理稼働中の表示を残す",',
      '    "cable.long": "仮想オーディオケーブルを使います",',
    ],
    [
      '    "compare.label": "Compare without VST",',
      '    "compare.similar": "Compare with VST",',
    ],
  ));
  assert.deepEqual(parsed.errors, []);
  const allow = [{ key: 'status.allowed', term: '処理稼働中', reason: '試験用の例外' }];
  const errors = findAvoidViolations(parsed.messages, TERMS.terms, allow);
  assert.deepEqual(errors, [
    '使わない語: ja status.running に「処理稼働中」（使う語: 「実行中」、出どころ: #599）',
    '使わない語: en compare.label に「Compare without VST」（使う語: 「Bypass VST」、出どころ: #609）',
  ]);
});

test('3文字以上の同じ語句が、かぎかっこや空白だけを挟んで続くのを見つける', () => {
  assert.deepEqual(findJaRepeats('保存した「保存したVSTの構成」'), ['保存した']);
  assert.deepEqual(findJaRepeats('保存した 保存した'), ['保存した']);
  assert.deepEqual(findJaRepeats('保存した　保存した'), ['保存した']);
  assert.deepEqual(findJaRepeats('保存した」「保存した'), ['保存した']);
  assert.deepEqual(findJaRepeats('保存した設定を保存した'), []);
  assert.deepEqual(findJaRepeats('保存した（保存した'), []);
  assert.deepEqual(findJaRepeats('確認「確認」'), []);
});

test('英語は、同じ単語が空白を挟んで続くのを見つける', () => {
  assert.deepEqual(findEnRepeats('the the'), ['the']);
  assert.deepEqual(findEnRepeats('The  the'), ['the']);
  assert.deepEqual(findEnRepeats('the theme'), []);
  assert.deepEqual(findEnRepeats('theme the'), []);
  assert.deepEqual(findEnRepeats('real-time real-time'), ['real-time']);
});

test('語句の重なりは例外に入れたキーだけを除く', () => {
  const parsed = parseMessages(messagesSource(
    ['    "copy.repeat": "保存した「保存したVSTの構成」",', '    "copy.other": "削除した 削除した",'],
    ['    "copy.repeat": "the the",', '    "copy.other": "Keep the theme",'],
  ));
  const allow = [{ key: 'copy.repeat', term: '保存した', reason: '試験用の例外' }];
  assert.deepEqual(findRepeatViolations(parsed.messages, allow), [
    '語句の重なり: ja copy.other に「削除した」',
    '語句の重なり: en copy.repeat に「the」',
  ]);
  assert.deepEqual(findRepeatViolations(parsed.messages, [
    { key: 'copy.repeat', term: 'the', reason: '英語の例外' },
  ]), [
    '語句の重なり: ja copy.repeat に「保存した」',
    '語句の重なり: ja copy.other に「削除した」',
  ]);
});

test('使う語が用語集の使う語の列に無いと失敗する', () => {
  const glossary = glossaryUseNames(DESIGN);
  assert.deepEqual(glossary.errors, []);
  assert.deepEqual(findUseMismatches([
    { use: '実行中', avoid: ['処理稼働中'], locale: 'ja', ref: '#599' },
    { use: '未登録の語', avoid: ['仮'], locale: 'ja' },
  ], glossary.uses), [
    '用語集に無い使う語: ja 「未登録の語」が4章の使う語にありません',
  ]);
});

test('読めない行は飛ばさず失敗する', () => {
  const parsed = parseMessages(messagesSource(
    ['    "bad": `template`,', '    "ok": "読める",'],
    ['    "ok": "readable",'],
  ));
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /^読めない行: ja \d+:/);
  assert.equal(parsed.messages.ja.ok, '読める');
});

test('値の次の行にある読点だけは、現行の書き方として読める', () => {
  const parsed = parseMessages(messagesSource(
    ['    "voice.candidateValues": "候補"', ',', '    "autoGain.title": "音量",'],
    ['    "voice.candidateValues": "Candidate",', '    "autoGain.title": "Level",'],
  ));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.messages.ja['voice.candidateValues'], '候補');
  assert.equal(parsed.messages.en['autoGain.title'], 'Level');
});

test('3つの検査をまとめて、問題が無い定義は通す', () => {
  const source = messagesSource(
    ['    "status.running": "実行中",'],
    ['    "compare.label": "Bypass VST",'],
  );
  assert.deepEqual(checkUiTerms({
    messagesSource: source,
    designSource: DESIGN,
    termsConfig: TERMS,
  }), []);
});

test('現行の文言ファイルを行の形から読め、定義した使う語は用語集にある', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'messages.ts'), 'utf8');
  const parsed = parseMessages(source);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.messages.ja['help.title'], '使い方');
  assert.equal(
    Object.keys(parsed.messages.ja).length,
    Object.keys(parsed.messages.en).length,
  );

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ui-terms.json'), 'utf8'));
  const design = fs.readFileSync(path.join(ROOT, 'docs', 'DESIGN.md'), 'utf8');
  const glossary = glossaryUseNames(design);
  assert.deepEqual(glossary.errors, []);
  assert.deepEqual(findUseMismatches(config.terms, glossary.uses), []);
});
