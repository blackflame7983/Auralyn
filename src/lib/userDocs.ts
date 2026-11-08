import links from '../../user-docs/links.json';
import jaGlossary from '../../user-docs/ja/glossary.md?raw';
import enGlossary from '../../user-docs/en/glossary.md?raw';
import type { Locale } from '@/i18n/locale';

export type UserDocName = keyof typeof links;

export function buildUserDocUrl(target: string, locale: Locale): string {
    const [page, anchor] = target.split('#');
    const base = `https://www.kuro7983.com/${locale === 'en' ? 'en/' : ''}apps/auralyn/docs`;
    return `${base}${page === 'index' ? '' : `/${page}`}${anchor ? `#${anchor}` : ''}`;
}

export function getUserDocUrl(name: UserDocName, locale: Locale): string {
    return buildUserDocUrl(links[name], locale);
}

// 原稿の各用語見出しと直後の段落だけを取り込む。補足はサイトで読む。
export function parseGlossary(source: string) {
    return [...source.replace(/\r\n/g, '\n').matchAll(/^### (.+) \{#(term-[a-z-]+)\}\n+([^#\n][^\n]*(?:\n(?!\n|#)[^\n]+)*)/gm)]
        .map(([, title, anchor, summary]) => ({ title, anchor, summary: summary.replace(/\n/g, ' ') }));
}

export const glossary = { ja: parseGlossary(jaGlossary), en: parseGlossary(enGlossary) };
export function glossaryDocName(anchor: string): UserDocName {
    const entry = Object.entries(links).find(([name, target]) => name.startsWith('glossary.') && target === `glossary#${anchor}`);
    if (!entry) throw new Error(`用語のリンクがありません: ${anchor}`);
    return entry[0] as UserDocName;
}
