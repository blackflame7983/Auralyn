import { expect, test, type Page } from '@playwright/test';
import { installTauriMock, type TauriMockOptions } from '../../src/dev/tauriMock';
import { collectScreenAudit, type AuditHit } from './helpers/screenAudit';
import { waitForStableLayout } from './helpers/waitForStableLayout';
import { deniedStorageOnErrorPage, retryTransientNavigation } from './helpers/transientGoto';
import { knownViolations, purposeAllowances, type KnownViolation, type PurposeAllowance } from './screen-matrix.known';

// 状態×使い方×窓×言語で画面を開き、重なり・はみ出し・折り返し・同じ文・空の枠・用途の混ざりを止める（#634）。
// ?mock= と data-auralyn-preview は開発サーバーだけが付ける。CI は本番ビルドを配るので、付かないときはレールから同じ画面を開く。
// 未設定の模擬名はプレビューに無い。unconfigured-live.spec.ts と同じく、セットアップ済みで機器設定が無い状態にする。

type State = 'live' | 'stopped' | 'unconfigured';
type Purpose = 'voice' | 'music';
type Locale = 'ja' | 'en';
type ScreenId = 'home' | 'sound' | 'sound-singing' | 'vst' | 'connect' | 'appearance' | 'shortcuts' | 'obs' | 'system' | 'stream-mix';

interface Context {
    screen: ScreenId;
    state: State;
    purpose: Purpose;
    locale: Locale;
    size: string;
}

const homeSizes = [{ width: 900, height: 600, name: '900x600' }, { width: 1024, height: 768, name: '1024x768' }, { width: 1280, height: 800, name: '1280x800' }];
const pageSizes = [{ width: 900, height: 600, name: '900x600' }, { width: 1280, height: 800, name: '1280x800' }];
const pageScreens: ScreenId[] = ['sound', 'sound-singing', 'vst', 'connect', 'appearance', 'shortcuts', 'obs', 'system', 'stream-mix'];

const previewScreen: Record<ScreenId, string | null> = {
    home: null,
    sound: 'settings-sound',
    // 音づくりの「歌向け」タブ。下に固定した保存の欄があるので、最後まで送って重なりを見る（#645）。
    'sound-singing': 'settings-sound',
    vst: 'vst',
    connect: 'settings-audio',
    appearance: 'settings-appearance',
    shortcuts: 'settings-shortcuts',
    obs: 'settings-obs',
    system: 'settings-system',
    'stream-mix': 'stream-mix',
};

const labels = {
    ja: { nav: '行き先', sound: '音づくり', singing: '歌向け', vst: 'VST', connect: '接続（オーディオの設定）', settings: '設定', appearance: '外観', shortcuts: 'ホットキー', obs: 'OBS連携', system: 'システム' },
    en: { nav: 'Destinations', sound: 'Sound', singing: 'Singing', vst: 'VST', connect: 'Connection (audio settings)', settings: 'Settings', appearance: 'Appearance', shortcuts: 'Hotkeys', obs: 'OBS', system: 'System' },
} as const;

const configured = {
    vst_host_wizard_done: 'true',
    vst_host_setup_goal: 'obs',
    auralyn_vst_panel_open: 'false',
    vst_host_audio_config: JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }),
};

function mockOptions(state: State): TauriMockOptions {
    return {
        liveHome: state !== 'unconfigured',
        stoppedHome: state === 'stopped',
        registeredModes: true,
        builtinEnabled: false,
        nativeMeterProfile: false,
        // プレビューと同じく、画面を描くための未定義 IPC では落とさない。
        strict: false,
    };
}

function mockName(state: State) {
    if (state === 'live') return 'live-home';
    if (state === 'stopped') return 'stopped-home';
    return 'unconfigured';
}

function applyStorage(payload: { locale: string; purpose: string; entries: [string, string][] }) {
    localStorage.setItem('vst_host_theme', 'dark');
    localStorage.setItem('vst_host_locale', payload.locale);
    localStorage.setItem('auralyn_display_purpose', payload.purpose);
    for (const [key, value] of payload.entries) localStorage.setItem(key, value);
}

function applies(entry: { screen?: string; state?: string; purpose?: string; size?: string; locale?: string }, ctx: Context) {
    return (entry.screen === undefined || entry.screen === ctx.screen)
        && (entry.state === undefined || entry.state === ctx.state)
        && (entry.purpose === undefined || entry.purpose === ctx.purpose)
        && (entry.size === undefined || entry.size === ctx.size)
        && (entry.locale === undefined || entry.locale === ctx.locale);
}

function containsWord(text: string, word: string, locale: Locale) {
    if (locale === 'ja') return text.includes(word);
    return new RegExp(`(^|[^A-Za-z])${word}`, 'i').test(text);
}

function formatHit(hit: AuditHit, ctx: Context) {
    const parts = hit.text.includes(' × ') ? hit.text.split(' × ') : [hit.text];
    const headText = parts.map(part => part.replace(/\s+/g, ' ').trim().slice(0, 28)).join(' × ');
    const word = hit.word ? ` [${hit.word}]` : '';
    return `${ctx.screen} ${ctx.state} ${ctx.purpose} ${ctx.size} ${ctx.locale} ${hit.check} ${hit.selector} 「${headText}」${word}`;
}

function formatKnown(entry: KnownViolation | PurposeAllowance) {
    return `${entry.screen ?? '*'} ${'state' in entry ? entry.state ?? '*' : '*'} ${entry.purpose ?? '*'} ${entry.size ?? '*'} ${entry.locale ?? '*'} ${'check' in entry ? entry.check : 'purpose-allow'} ${entry.match}`;
}

function judge(hits: AuditHit[], ctx: Context) {
    const fresh: string[] = [];
    const stale: string[] = [];
    const knownSeen = new Set<number>();
    const allowSeen = new Set<number>();
    for (const hit of hits) {
        if (hit.check === 'purpose' && hit.word) {
            let rest = hit.fullText ?? hit.text;
            const allowances = purposeAllowances
                .map((entry, index) => ({ entry, index }))
                .filter(item => applies(item.entry, ctx))
                .sort((a, b) => b.entry.match.length - a.entry.match.length);
            for (const item of allowances) {
                if (!rest.includes(item.entry.match)) continue;
                rest = rest.split(item.entry.match).join('');
                allowSeen.add(item.index);
            }
            if (!containsWord(rest, hit.word, ctx.locale)) continue;
        }
        let matched = false;
        knownViolations.forEach((entry, index) => {
            if (entry.check !== hit.check || !applies(entry, ctx)) return;
            const hay = `${hit.selector} ${hit.text} ${hit.fullText ?? ''} ${hit.word ?? ''}`;
            if (!hay.includes(entry.match)) return;
            knownSeen.add(index);
            matched = true;
        });
        if (!matched) fresh.push(formatHit(hit, ctx));
    }
    knownViolations.forEach((entry, index) => {
        if (applies(entry, ctx) && !knownSeen.has(index)) stale.push(formatKnown(entry));
    });
    purposeAllowances.forEach((entry, index) => {
        if (applies(entry, ctx) && !allowSeen.has(index)) stale.push(formatKnown(entry));
    });
    return [...fresh, ...stale.map(line => `直ったので例外を外してください ${line}`)];
}

function assertProblems(problems: string[]) {
    const fresh = problems.filter(line => !line.startsWith('直ったので例外を外してください'));
    const stale = problems.filter(line => line.startsWith('直ったので例外を外してください'));
    expect(fresh, '新しい違反').toEqual([]);
    expect(stale, '直ったので例外を外してください').toEqual([]);
}

async function openScreen(page: Page, ctx: Context, width: number, height: number) {
    await page.setViewportSize({ width, height });
    const screen = previewScreen[ctx.screen];
    const query = new URLSearchParams({ mock: mockName(ctx.state) });
    if (screen) query.set('screen', screen);
    await page.goto(`/?${query.toString()}`);
    await expect(page.getByText(/音声エンジンを起動しています|Starting the audio engine/)).toHaveCount(0);
    await expect(page.locator('.app-shell')).toBeVisible();
    const devPreview = await page.evaluate(() => Boolean(document.querySelector('script[src*="previewMock"]')));
    if (devPreview) {
        await expect(page.locator('html')).toHaveAttribute('data-auralyn-preview', screen ?? 'home');
    } else if (ctx.screen !== 'home') {
        const name = labels[ctx.locale];
        const nav = page.getByRole('navigation', { name: name.nav, exact: true });
        if (ctx.screen === 'sound' || ctx.screen === 'sound-singing') await nav.getByRole('button', { name: name.sound, exact: true }).click();
        else if (ctx.screen === 'vst') await nav.getByRole('button', { name: name.vst, exact: true }).click();
        else if (ctx.screen === 'connect') await nav.getByRole('button', { name: name.connect, exact: true }).click();
        else if (ctx.screen === 'stream-mix') {
            // ホームのパネル。音楽鑑賞では配信ミックスを描かない。
        } else {
            await nav.getByRole('button', { name: name.settings, exact: true }).click();
            await expect(page.locator('[data-settings-page="settings"]')).toBeVisible();
            await page.getByRole('tab', { name: name[ctx.screen], exact: true }).click();
            await expect(page.getByRole('tab', { name: name[ctx.screen], exact: true })).toHaveAttribute('data-state', 'active');
        }
    }
    if (ctx.screen === 'sound' || ctx.screen === 'sound-singing') await expect(page.locator('[data-settings-page="sound"]')).toBeVisible();
    if (ctx.screen === 'sound-singing') {
        const tab = page.getByRole('tab', { name: labels[ctx.locale].singing, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('data-state', 'active');
        // 保存の欄に最後の操作が潜らないかは、最後まで送った位置で見る。
        await page.locator('[data-settings-page="sound"]').evaluate(root => {
            for (let node: Element | null = root; node; node = node.parentElement) {
                if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
            }
            for (const node of root.querySelectorAll<HTMLElement>('*')) {
                if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
            }
        });
    }
    if (ctx.screen === 'vst') await expect(page.locator('[data-vst-page]')).toBeVisible();
    if (ctx.screen === 'connect') await expect(page.locator('[data-settings-page="connect"]')).toBeVisible();
    if (ctx.screen === 'stream-mix' && ctx.purpose === 'voice') {
        const panel = page.locator('#stream-mix-panel');
        await expect(panel).toBeVisible();
        await page.locator('#mixing-settings').evaluate(element => { (element as HTMLDetailsElement).open = true; });
        // パネルを開いたときの移動（先頭へ揃える）のあとで調べる。本番ビルドは画面指定の移動を持たない。
        await panel.evaluate(element => element.scrollIntoView({ block: 'start' }));
    }
    await page.evaluate(() => (window as unknown as { __e2eSetOutputMuted: (muted: boolean) => void }).__e2eSetOutputMuted(false));
    await waitForStableLayout(page);
    if (ctx.state === 'live') {
        // 実行中の状態は、統計が届くまで「読み取れない」と出る。届いたあとの画面を調べる。
        await page.waitForFunction(() => {
            const text = document.body.innerText;
            return !text.includes('状態を読み取れません')
                && !text.includes('状態を読み取れない項目があります')
                && !text.includes('Status unavailable')
                && !text.includes('Some processing status is unavailable');
        }, undefined, { timeout: 3000 }).catch(() => undefined);
        await waitForStableLayout(page);
    }
}

async function runMatrix(page: Page, retried: () => number, ctx: Context, width: number, height: number, errors: string[]) {
    errors.length = 0;
    await openScreen(page, ctx, width, height);
    const hits = await page.evaluate(collectScreenAudit, { purpose: ctx.purpose, locale: ctx.locale });
    // 一時的なソケット不足で開き直したときは、エラーページの localStorage の拒否だけを除く（helpers/transientGoto.ts）。
    expect(retried() > 0 ? errors.filter(message => message !== deniedStorageOnErrorPage) : errors, '画面の実行時例外').toEqual([]);
    return judge(hits, ctx);
}

test.describe('画面の状態をまとめて開く', () => {
    test.describe.configure({ timeout: 90_000 });

    for (const state of ['live', 'stopped', 'unconfigured'] as const) {
        for (const purpose of ['voice', 'music'] as const) {
            for (const locale of ['ja', 'en'] as const) {
                test(`ホーム ${state} ${purpose} ${locale}`, async ({ page }) => {
                    const errors: string[] = [];
                    page.on('pageerror', error => errors.push(error.message));
                    const retried = retryTransientNavigation(page, errors);
                    const entries = Object.entries(state === 'unconfigured'
                        ? { vst_host_wizard_done: 'true', vst_host_setup_goal: 'obs', auralyn_vst_panel_open: 'false' }
                        : configured);
                    await page.addInitScript(installTauriMock, mockOptions(state));
                    await page.addInitScript(applyStorage, { locale, purpose, entries });
                    const problems: string[] = [];
                    for (const size of homeSizes) {
                        problems.push(...await runMatrix(page, retried, { screen: 'home', state, purpose, locale, size: size.name }, size.width, size.height, errors));
                    }
                    assertProblems(problems);
                });
            }
        }
    }

    for (const screen of pageScreens) {
        for (const purpose of ['voice', 'music'] as const) {
            // 音楽鑑賞の音づくりには「歌向け」タブが無い。
            if (screen === 'sound-singing' && purpose === 'music') continue;
            for (const locale of ['ja', 'en'] as const) {
                test(`${screen} ${purpose} ${locale}`, async ({ page }) => {
                    const errors: string[] = [];
                    page.on('pageerror', error => errors.push(error.message));
                    const retried = retryTransientNavigation(page, errors);
                    const storage: Record<string, string> = { ...configured };
                    if (screen === 'stream-mix') storage.auralyn_stream_mix_panel = 'shown';
                    await page.addInitScript(installTauriMock, mockOptions('live'));
                    await page.addInitScript(applyStorage, { locale, purpose, entries: Object.entries(storage) });
                    const problems: string[] = [];
                    for (const size of pageSizes) {
                        problems.push(...await runMatrix(page, retried, { screen, state: 'live', purpose, locale, size: size.name }, size.width, size.height, errors));
                    }
                    assertProblems(problems);
                });
            }
        }
    }
});
