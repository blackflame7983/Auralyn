// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { message, type MessageKey } from '../i18n/messages';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
const locales = ['ja', 'en'] as const;
const pages = ['index', 'setup', 'obs', 'discord', 'home', 'sound', 'troubleshooting', 'settings', 'shortcuts', 'glossary'];
const catalogSource = read('src/i18n/messages.ts').split('const en:')[0];
const keys = [...catalogSource.matchAll(/^\s*"([^"\n]+)":/gm)].map(match => match[1] as MessageKey);
const links: Record<string, string> = JSON.parse(read('user-docs/links.json'));

// front matterはJSON文字列・数値・文字列配列に限定し、YAML依存を増やさない。
function parseDoc(source: string) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
    expect(front, 'front matterが必要です').not.toBeNull();
    const fields = Object.fromEntries(front![1].split(/\r?\n/).map(line => {
        const field = /^(\w+): (.+)$/.exec(line);
        expect(field, `不正なfront matter: ${line}`).not.toBeNull();
        return [field![1], JSON.parse(field![2]) as unknown];
    }));
    const body = source.slice(front![0].length);
    const headings = body.split(/\r?\n/).filter(line => /^#{2,6}\s/.test(line));
    const anchors = headings.flatMap(line => [...line.matchAll(/\{#([a-z]+(?:-[a-z]+)*)\}/g)].map(match => match[1]));
    return { fields, body, headings, anchors };
}
const docs = Object.fromEntries(locales.map(locale => [locale, Object.fromEntries(pages.map(page => [page, parseDoc(read(`user-docs/${locale}/${page}.md`))]))]));

// コード、リンク先URLを除いた表示文を検査する。リンクの表示名は検査に残す。
function prose(body: string) {
    return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
        .replace(/`[^`\n]*`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/[^\s<>]+/g, '');
}
function expectTarget(target: string, extension: boolean) {
    const match = (extension ? /^\.\/([a-z]+)\.md#([a-z]+(?:-[a-z]+)*)$/ : /^([a-z]+)#([a-z]+(?:-[a-z]+)*)$/).exec(target);
    expect(match, `不正なリンク: ${target}`).not.toBeNull();
    for (const locale of locales) {
        expect(pages, target).toContain(match![1]);
        expect(docs[locale][match![1]].anchors, `${locale}: ${target}`).toContain(match![2]);
    }
}

describe('利用者向け原稿', () => {
    it('日英で10ページがそろう', () => {
        const expected = pages.map(page => `${page}.md`).sort();
        for (const locale of locales) expect(readdirSync(resolve(root, `user-docs/${locale}`)).sort()).toEqual(expected);
    });
    it('アプリ用リンクのページと印が日英に実在する', () => {
        expect(Object.keys(links).length).toBeGreaterThan(0);
        for (const [name, target] of Object.entries(links)) {
            expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)*$/);
            expectTarget(target, false);
        }
        for (const symptom of ['no-sound', 'not-received', 'dropouts', 'latency', 'vst-load']) {
            expect(links[`troubleshooting.${symptom}`]).toBe(`troubleshooting#${symptom}`);
        }
        for (const name of ['help.home', 'help.setup', 'help.glossary', 'help.shortcuts', 'home.stage', 'home.noise-reduction', 'home.voice-shaping', 'home.vst', 'home.audio-check', 'home.output-volume']) expect(links[name], name).toBeDefined();
    });
    for (const page of pages) {
        it(`${page}: 日英の見出しの印が一致する`, () => {
            expect([...docs.ja[page].anchors].sort()).toEqual([...docs.en[page].anchors].sort());
        });
        for (const locale of locales) {
            it(`${locale}/${page}: メタデータ・見出し・文言・表記・リンク`, () => {
                const { fields, body, headings, anchors } = docs[locale][page];
                for (const field of ['title', 'description']) {
                    expect(typeof fields[field]).toBe('string');
                    expect((fields[field] as string).trim().length).toBeGreaterThan(0);
                }
                expect(Number.isInteger(fields.order)).toBe(true);
                expect(fields.order).toBe(pages.indexOf(page) + 1);
                expect(headings.length).toBeGreaterThan(0);
                for (const heading of headings) expect(heading).toMatch(/^#{2,6} .+ \{#[a-z]+(?:-[a-z]+)*\}$/);
                expect(new Set(anchors).size).toBe(anchors.length);
                const labels = fields.uiLabels;
                expect(Array.isArray(labels)).toBe(true);
                const quoted = [...body.matchAll(locale === 'ja' ? /「([^」]+)」/g : /“([^”]+)”/g)].map(match => match[1]);
                // この原稿では引用括弧をUI名専用とし、登録漏れと使われない登録も防ぐ。
                expect([...new Set(quoted)].sort()).toEqual([...(labels as string[])].sort());
                const values = keys.map(key => message(locale, key));
                for (const label of labels as string[]) expect(values, label).toContain(label);
                const text = prose(body);
                expect(text).not.toMatch(/\d(?:ms|s|Hz|kHz|MHz|dBFS|dBTP|dB|LUFS|LU|MB|GB|KB)\b/);
                if (locale === 'ja') {
                    for (const line of text.split('\n').filter(line => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line))) {
                        expect(line).not.toMatch(/[:()]/);
                        expect(line).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}] +VST|VST +[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
                    }
                }
                for (const link of body.matchAll(/\]\((\.\/[^)]+)\)/g)) expectTarget(link[1], true);
                expect(body.trim()).toMatch(/## [^\n]+ \{#related\}\n\n(?:- \[[^\n]+\n?)+$/);
            });
        }
    }
    it('使い方の全用語に短い定義と補足がある', () => {
        const termKeys = keys.filter(key => /^help\.term\..+\.title$/.test(key));
        expect(termKeys.length).toBeGreaterThan(0);
        for (const locale of locales) {
            const body = docs[locale].glossary.body;
            const terms = [...body.matchAll(/^### (.+) \{#term-[a-z-]+\}\n\n([^\n]+)\n\n([^#][\s\S]*?)(?=\n###? |$)/gm)];
            expect(terms.length).toBe(docs[locale].glossary.anchors.filter(anchor => anchor.startsWith('term-')).length);
            for (const key of termKeys) expect(terms.map(term => term[1])).toContain(message(locale, key));
            for (const term of terms) {
                expect(term[2].match(locale === 'ja' ? /。/g : /\.(?: |$)/g)).toHaveLength(1);
                expect(term[3].trim().length).toBeGreaterThan(0);
            }
            for (const term of ['ASIO', 'WASAPI', 'VST', 'dBFS']) expect(terms.map(value => value[1])).toContain(term);
        }
    });
});
