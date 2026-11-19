import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { realisticDeviceNames } from '../../src/dev/tauriMock';
import { message, type MessageKey } from '../../src/i18n/messages';

// 利用者目線の評価用の画面記録。e2e/browser の外なので、通常の npm run test:e2e と CI には入らない。

type MockName = 'live-home' | 'live-home-builtin' | 'stopped-home' | 'first-run';
type ThemeName = 'dark' | 'light' | 'gaming';
type LocaleName = 'ja' | 'en';
type PurposeName = 'voice' | 'music';
type Surface = 'home' | 'wizard' | 'dialog' | 'vst' | 'settings' | 'stream-mix';

interface Shot {
    name: string;
    mock: MockName;
    screen?: string;
    theme: ThemeName;
    locale: LocaleName;
    purpose: PurposeName;
    /** 省いたときは、その mock の既定（live-home 系は登録済み、first-run は未登録）。 */
    registered?: boolean;
    /** 省いたときは、模擬の既定（出力ミュートが ON）。false にすると、レベルを流す前に解除する。 */
    outputMuted?: boolean;
    /** 接続ページの「仮想ケーブルの案内」を開いて撮る。 */
    cableHelp?: boolean;
    /** first-run のセットアップで音楽鑑賞を選び、この手順まで進めて撮る。wizard.musicRoute の文が見えていることも確かめる。 */
    musicWizardStep?: 'input' | 'output';
    surface: Surface;
    purposeLabel: string;
    runningLabel: string;
    registeredLabel: string;
    expects: string[];
}

const streamInput = realisticDeviceNames.streamInput;
const streamOutput = realisticDeviceNames.streamOutput;
const musicInput = realisticDeviceNames.musicInput;
const musicOutput = realisticDeviceNames.musicOutput;

const voice = [streamInput, streamOutput];
const music = [musicInput, musicOutput];

const shots: Shot[] = [
    { name: 'setup-first', mock: 'first-run', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'wizard', purposeLabel: '配信', runningLabel: '未設定', registeredLabel: '未登録', expects: ['何に使いますか？'] },
    { name: 'setup-music-input', mock: 'first-run', theme: 'dark', locale: 'ja', purpose: 'voice', musicWizardStep: 'input', surface: 'wizard', purposeLabel: '音楽鑑賞（セットアップで選ぶ）', runningLabel: '未設定', registeredLabel: '未登録', expects: [message('ja', 'wizard.musicRoute')] },
    { name: 'setup-music-output', mock: 'first-run', theme: 'dark', locale: 'ja', purpose: 'voice', musicWizardStep: 'output', surface: 'wizard', purposeLabel: '音楽鑑賞（セットアップで選ぶ）', runningLabel: '未設定', registeredLabel: '未登録', expects: [message('ja', 'wizard.musicRoute')] },
    { name: 'home-voice', mock: 'live-home', theme: 'dark', locale: 'ja', purpose: 'voice', registered: false, surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '未登録', expects: ['いまの声', ...voice] },
    { name: 'home-voice-registered', mock: 'live-home', theme: 'dark', locale: 'ja', purpose: 'voice', registered: true, surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['いまの調整', ...voice] },
    { name: 'home-voice-unmuted', mock: 'live-home', theme: 'dark', locale: 'ja', purpose: 'voice', registered: true, outputMuted: false, surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['いまの調整', ...voice] },
    { name: 'home-voice-builtin', mock: 'live-home-builtin', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み（声を整える ON）', expects: ['いまの調整', '標準', ...voice] },
    { name: 'home-stopped', mock: 'stopped-home', theme: 'dark', locale: 'ja', purpose: 'voice', registered: false, surface: 'home', purposeLabel: '配信', runningLabel: '停止中', registeredLabel: '未登録', expects: ['いまの声', '音声停止中', ...voice] },
    { name: 'home-voice-gaming', mock: 'live-home', theme: 'gaming', locale: 'ja', purpose: 'voice', surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['いまの調整', ...voice] },
    { name: 'home-voice-light-en', mock: 'live-home', theme: 'light', locale: 'en', purpose: 'voice', surface: 'home', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['Custom sound', ...voice] },
    { name: 'home-music', mock: 'live-home', theme: 'dark', locale: 'ja', purpose: 'music', surface: 'home', purposeLabel: '音楽鑑賞', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['音楽鑑賞', ...music] },
    { name: 'home-music-stopped', mock: 'stopped-home', theme: 'dark', locale: 'ja', purpose: 'music', surface: 'home', purposeLabel: '音楽鑑賞', runningLabel: '停止中', registeredLabel: '登録済み', expects: ['音楽鑑賞', '音声停止中', ...music] },
    { name: 'home-music-en', mock: 'live-home', theme: 'dark', locale: 'en', purpose: 'music', surface: 'home', purposeLabel: '音楽鑑賞', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['Music listening', ...music] },
    { name: 'vst', mock: 'live-home', screen: 'vst', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'vst', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'vst-music', mock: 'live-home', screen: 'vst', theme: 'dark', locale: 'ja', purpose: 'music', surface: 'vst', purposeLabel: '音楽鑑賞', runningLabel: '実行中', registeredLabel: '登録済み', expects: music },
    { name: 'sound', mock: 'live-home', screen: 'settings-sound', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['音づくり', ...voice] },
    { name: 'sound-music', mock: 'live-home', screen: 'settings-sound', theme: 'dark', locale: 'ja', purpose: 'music', surface: 'settings', purposeLabel: '音楽鑑賞', runningLabel: '実行中', registeredLabel: '登録済み', expects: music },
    { name: 'audio', mock: 'live-home', screen: 'settings-audio', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'appearance', mock: 'live-home', screen: 'settings-appearance', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['外観', ...voice] },
    { name: 'audio-music', mock: 'live-home', screen: 'settings-audio', theme: 'dark', locale: 'ja', purpose: 'music', cableHelp: true, surface: 'settings', purposeLabel: '音楽鑑賞', runningLabel: '実行中', registeredLabel: '登録済み', expects: [message('ja', 'processInput.cableHelpMusic'), ...music] },
    { name: 'obs', mock: 'live-home', screen: 'settings-obs', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'system', mock: 'live-home', screen: 'settings-system', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'shortcuts', mock: 'live-home', screen: 'settings-shortcuts', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'settings', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'stream-mix', mock: 'live-home', screen: 'stream-mix', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'stream-mix', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['配信ミックス', ...voice] },
    { name: 'stream-mix-en', mock: 'live-home', screen: 'stream-mix', theme: 'dark', locale: 'en', purpose: 'voice', surface: 'stream-mix', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'plugin-browser', mock: 'live-home', screen: 'plugin-browser', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['VSTを追加', ...voice] },
    { name: 'voice-check', mock: 'live-home', screen: 'voice-check', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['ボイスチェック', ...voice] },
    { name: 'presets', mock: 'live-home', screen: 'presets', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'troubleshoot', mock: 'live-home', screen: 'troubleshoot', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'help', mock: 'live-home', screen: 'help', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: ['使い方', ...voice] },
    { name: 'template-wizard', mock: 'live-home', screen: 'template-wizard', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
    { name: 'obs-guide', mock: 'live-home', screen: 'obs-guide', theme: 'dark', locale: 'ja', purpose: 'voice', surface: 'dialog', purposeLabel: '配信', runningLabel: '実行中', registeredLabel: '登録済み', expects: voice },
];

const sizes = [
    { id: 'w900', width: 900, height: 600 },
    { id: 'w1024', width: 1024, height: 768 },
    { id: 'w1280', width: 1280, height: 800 },
    { id: 'w1440', width: 1440, height: 900 },
] as const;

const themeLabel: Record<ThemeName, string> = { dark: 'ダーク', light: 'ライト', gaming: 'ゲーミング' };
const localeLabel: Record<LocaleName, string> = { ja: '日本語', en: '英語' };

function captureRoot() {
    const override = process.env.UX_EVAL_OUT;
    if (override) return path.resolve(override);
    const sha = execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    const short = branch.slice(branch.lastIndexOf('/') + 1);
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return path.resolve('test-results', 'ux-eval', `${day}-${short}-${sha}`);
}

const root = captureRoot();

function readme(size: (typeof sizes)[number]) {
    const rows = shots.map(shot => `| ${shot.name}.png | ${shot.purposeLabel} | ${shot.runningLabel} | ${shot.registeredLabel} | ${shot.outputMuted === false ? '解除済み' : 'ミュート中'} | ${localeLabel[shot.locale]} | ${themeLabel[shot.theme]} | ${size.width}×${size.height} |`);
    return [
        `# ${size.id}（${size.width}×${size.height}）`,
        '',
        '機器名は realistic。配信は Yeti Stereo Microphone → CABLE Input (VB-Audio Virtual Cable)。音楽鑑賞は CABLE Output (VB-Audio Virtual Cable) → USB Headphones。',
        '',
        '評価者へ渡す PROMPT.md と DECIDED.md には、docs/TESTING.md の「模擬データの限界」を写してください。リポジトリに正本はありません。',
        '',
        '| ファイル | 用途 | 実行 | 登録 | 出力 | 言語 | テーマ | 窓 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ].join('\n');
}

// ダブルクリックが残した文字の選択は、利用者の画面には無い。撮る前に外す。
async function clearTextSelection(page: Page) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

// 初回のセットアップで音楽鑑賞を選び、入力の手順（2番目）か出力の手順（3番目）まで、利用者と同じ操作で進める。
// どちらの手順にも、再生アプリから VST までの経路（wizard.musicRoute）が出る。
async function advanceMusicWizard(page: Page, shot: Shot) {
    const dialog = page.getByRole('dialog').first();
    const route = dialog.getByText(message(shot.locale, 'wizard.musicRoute'), { exact: true });
    // カードの題を2回押して、選んで進む。入場後も続く注意の動きで「静止」が成立しないので、静止の待ちだけを外す。
    await dialog.getByText(message(shot.locale, 'wizard.musicGoal'), { exact: true }).dblclick({ force: true });
    await expect(dialog.getByRole('heading', { name: message(shot.locale, 'wizard.musicInput'), exact: true })).toBeVisible();
    await expect(route).toBeVisible();
    await clearTextSelection(page);
    if (shot.musicWizardStep === 'input') return;
    const input = dialog.getByRole('combobox', { name: message(shot.locale, 'guide.copy.188') });
    await input.selectOption({ label: musicInput });
    await dialog.getByRole('button', { name: message(shot.locale, 'common.next') }).click();
    await expect(dialog.getByRole('heading', { name: message(shot.locale, 'wizard.destination'), exact: true })).toBeVisible();
    await expect(route).toBeVisible();
    await clearTextSelection(page);
}

async function openShot(page: Page, shot: Shot, size: (typeof sizes)[number]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.addInitScript(({ theme, locale }) => {
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_locale', locale);
    }, { theme: shot.theme, locale: shot.locale });
    const params = new URLSearchParams({ mock: shot.mock, devices: 'realistic', purpose: shot.purpose });
    if (shot.registered !== undefined) params.set('registered', shot.registered ? '1' : '0');
    if (shot.screen) params.set('screen', shot.screen);
    await page.goto(`/?${params.toString()}`);
    const splash = shot.locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
    await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-auralyn-preview', shot.screen ?? 'home');
    await expect(page.locator('html')).toHaveAttribute('lang', shot.locale);
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${shot.theme}\\b`));
    if (shot.surface === 'home') await expect(page.locator('.home-content')).toBeVisible();
    if (shot.surface === 'wizard' || shot.surface === 'dialog') await expect(page.getByRole('dialog').first()).toBeVisible();
    if (shot.surface === 'vst') await expect(page.locator('[data-vst-page]')).toBeVisible();
    if (shot.surface === 'settings') await expect(page.locator('[data-settings-page]')).toBeVisible();
    if (shot.surface === 'stream-mix') await expect(page.locator('#stream-mix-panel')).toBeVisible();
    if (shot.musicWizardStep) await advanceMusicWizard(page, shot);
    if (shot.cableHelp) {
        // 仮想ケーブルの案内は、接続ページの音の元の欄にある閉じた折りたたみ。利用者が開いたところまで進めて撮る。
        const summary = page.locator('[data-settings-page]').getByText(message(shot.locale, 'processInput.cable'), { exact: true });
        await summary.click();
        const help = page.getByText(message(shot.locale, 'processInput.cableHelpMusic'), { exact: true });
        await expect(help).toBeVisible();
        await help.scrollIntoViewIfNeeded();
    }
    if (shot.runningLabel !== '実行中') return;
    // 模擬は音声レベルを自分では出さない。一定の入力レベルを流して、平らなメーターにする。
    // 出力のレベルは、模擬が実エンジンと同じく出力ミュートと出力音量から決める（src/dev/tauriMock.ts の __e2eMeterLevels）。
    await page.evaluate(unmuted => {
        const host = window as Window & { __e2eEmitLevel?: (level: number) => void; __e2eSetOutputMuted?: (muted: boolean) => void };
        const emitLevel = host.__e2eEmitLevel;
        if (!emitLevel) throw new Error('模擬の __e2eEmitLevel がありません');
        if (unmuted) {
            if (!host.__e2eSetOutputMuted) throw new Error('模擬の __e2eSetOutputMuted がありません');
            host.__e2eSetOutputMuted(false);
        }
        window.setInterval(() => emitLevel(0.1), 50);
    }, shot.outputMuted === false);
    const body = () => page.locator('body').innerText();
    await expect.poll(body).not.toContain(shot.locale === 'ja' ? '状態を読み取れません' : 'Status unavailable');
    // ホーム以外は「受信中」を出さない。出力のピークの数字で、一定のレベルが届いたことを見る。
    // 先に、入力のメーターへ一定のレベルが届いたことを見る。ミュート中でも入力は動く。
    const meterTexts = () => page.evaluate(() => [...document.querySelectorAll('[role="meter"]')].map(meter => `${meter.getAttribute('aria-label') ?? ''}\t${meter.getAttribute('aria-valuetext') ?? ''}`));
    await expect.poll(meterTexts).toContainEqual(expect.stringMatching(/\t[-−]20\.0 dBFS/));
    // 出力ミュート中は、実エンジンと同じく出力レベルが 0 になり、ピークは −∞ のまま。解除していれば −20.0。
    const outputMeters = [message(shot.locale, 'home.sendLevel'), message(shot.locale, 'home.listenLevel')];
    const outputMeterTexts = async () => (await meterTexts()).filter(text => outputMeters.includes(text.split('\t')[0]));
    if (shot.outputMuted === false) {
        await expect.poll(body).toContain('−20.0 dBFS');
        await expect.poll(async () => (await outputMeterTexts()).some(text => /\t[-−]20\.0 dBFS/.test(text)), '解除したのに出力のバーが動かない').toBe(true);
    }
    else {
        await expect.poll(body).toContain('−∞ dBFS');
        expect(await body(), '出力ミュート中なのに出力のピークが動いている').not.toContain('−20.0 dBFS');
        expect((await outputMeterTexts()).filter(text => /\t[-−]20\.0 dBFS/.test(text)), '出力ミュート中なのに出力のバーが動いている').toEqual([]);
    }
}

// 撮影の都合で出る表示は、画像に残さない。評価者が利用者の不具合として数えてしまう。
async function expectNoCaptureArtifacts(page: Page, shot: Shot) {
    const t = (key: MessageKey) => message(shot.locale, key);
    // 接続の「ホームの表示と入力の用途が違います」は、そろえるボタンと一緒に出る。撮影は表示と入力の用途を同じにしてあるので、どの画面にも出ない。
    await expect(page.getByRole('button', { name: t('purpose.align'), exact: true }), '表示と入力の用途がそろっていない').toHaveCount(0);
    if (shot.name !== 'voice-check') return;
    // 録音前のボイスチェックは、試聴先を読めたあと、録音の操作だけが出る。試聴の欄と準備の失敗は、録音したあとか実際の失敗のときだけ。
    await expect(page.getByRole('button', { name: message(shot.locale, 'voice.recordMax', { seconds: '10' }) }), '録音の操作が使える状態になる').toBeEnabled();
    await expect(page.getByRole('region', { name: t('voice.playbackSection'), exact: true }), '録音前に試聴の欄が出ている').toHaveCount(0);
    expect(await page.locator('body').innerText(), '試聴の準備に失敗している').not.toContain(t('voice.copy.126'));
}

async function connectColumnIsOnTheRight(page: Page) {
    const place = await page.locator('.home-connect-column').evaluate(element => {
        const target = element.querySelector('h2, h3, button, p') ?? element;
        const box = target.getBoundingClientRect();
        const content = element.closest('.home-content')?.getBoundingClientRect();
        return { x: box.x, width: box.width, contentX: content?.x ?? 0 };
    });
    expect(place.width).toBeGreaterThan(40);
    expect(place.x).toBeGreaterThan(place.contentX + 200);
}

for (const size of sizes) {
    test.describe(size.id, () => {
        test.beforeAll(() => {
            const dir = path.join(root, size.id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'README.md'), readme(size), 'utf8');
        });

        for (const shot of shots) {
            test(shot.name, async ({ page }) => {
                await openShot(page, shot, size);
                await expectNoCaptureArtifacts(page, shot);
                const text = await page.evaluate(() => document.body.innerText);
                const dir = path.join(root, size.id);
                await page.screenshot({ path: path.join(dir, `${shot.name}.png`), animations: 'disabled' });
                writeFileSync(path.join(dir, `${shot.name}.txt`), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
                expect(text).not.toContain('音声エンジンを起動しています');
                expect(text).not.toContain('Starting the audio engine');
                // 模擬の旧い機器名「スピーカー」は、1行だけの機器名か、経路の区間として出る。本文の「ヘッドホンやスピーカー」のような言葉は数えない。
                expect(text, '機器名に日本語のスピーカーが残っている').not.toMatch(/(^|→\s*)スピーカー(\s*→|\s*$)/m);
                for (const fragment of shot.expects) expect(text).toContain(fragment);
                if (shot.name === 'home-voice') expect(text).not.toContain('いまの調整');
                // 「標準」は OFF でも選択欄に出る。ON の評価画像であることは、スイッチの状態で確かめる（#770）。
                if (shot.name === 'home-voice-builtin') await expect(page.locator('#home-builtin').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
                if (size.width >= 1400 && shot.surface === 'home') await connectColumnIsOnTheRight(page);
            });
        }
    });
}
