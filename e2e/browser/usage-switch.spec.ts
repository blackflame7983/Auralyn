import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import type { StartRequest } from './tauriWindow';
import { message } from '@/i18n/messages';

const shots = 'test-results/ux-eval-check/723-fix2';
const sizes = [{ width: 900, height: 600 }, { width: 1024, height: 768 }, { width: 1280, height: 800 }] as const;

interface UsageRecord { output: string; inputSource: { config: { purpose: string } } }
interface StoredState {
    display: string | null;
    config: { output: string; inputSource: { config: { purpose: string } } };
    usage: { voice: UsageRecord; music: UsageRecord };
    starts: StartRequest[];
}
async function seed(page: Page, { purpose, records, locale = 'ja', appMusic = false }: { purpose: 'voice' | 'music'; records: readonly ('voice' | 'music')[]; locale?: 'ja' | 'en'; appMusic?: boolean }) {
    await page.addInitScript(({ purpose, records, locale, appMusic }) => {
        // 保存値は最初の読み込みだけに入れる。再読み込み（アプリの再起動）では、利用者が残した値を読み直す。
        const seeded = sessionStorage.getItem('e2e-usage-seeded') === 'true';
        sessionStorage.setItem('e2e-usage-seeded', 'true');
        if (!seeded) seedStorage();
        function seedStorage() {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('auralyn_display_purpose', purpose);
        const make = (kind: string, output: string, outputId: string) => ({
            host: 'WASAPI', input: 'CABLE Output', inputId: 'mic', output, outputId, sampleRate: 48000, bufferSize: 512,
            inputSource: { kind: 'device', config: { purpose: kind } },
        });
        localStorage.setItem('vst_host_audio_config', JSON.stringify(make(purpose, 'スピーカー', 'headphones')));
        const store: Record<string, unknown> = { version: 1 };
        if (records.includes('voice')) store.voice = make('voice', 'スピーカー', 'headphones');
        if (records.includes('music')) {
            store.music = appMusic ? {
                host: 'WASAPI', output: 'USB Headphones', outputId: 'phones', sampleRate: 48000, bufferSize: 512,
                inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'endpoint', purpose: 'music' } },
            } : make('music', 'USB Headphones', 'phones');
        }
        localStorage.setItem('auralyn_usage_devices', JSON.stringify(store));
        }
        // 模擬の IPC に無い再起動は開始と同じ応答にし、操作ロックは試験の旗で本番モードの応答へ重ねる。
        const internals = window.__TAURI_INTERNALS__;
        if (!internals) return;
        const original = internals.invoke;
        internals.invoke = async (command, args) => {
            if (command === 'restart_audio_engine') return original('start_audio', args);
            const result = await original(command, args);
            if (command === 'live_modes' && window.__e2eArmed && typeof result === 'object' && result !== null) return { ...result, armed: true };
            return result;
        };
    }, { purpose, records, locale, appMusic });
}

const setFlag = (page: Page, flag: '__e2eStartFailure' | '__e2eArmed', value: boolean) =>
    page.evaluate(({ flag, value }) => { window[flag] = value; }, { flag, value });

test.use({ liveHome: true });
test.beforeAll(() => mkdirSync(shots, { recursive: true }));

for (const locale of ['ja', 'en'] as const) {
    for (const purpose of ['voice', 'music'] as const) {
        for (const size of sizes) {
            test(`接続の使い道 ${locale} ${purpose} ${size.width}x${size.height}`, async ({ page }) => {
                await seed(page, { purpose, records: ['voice', 'music'], locale });
                await page.setViewportSize(size);
                await page.goto('/?mock=live-home&screen=settings-audio');
                const inputName = message(locale, purpose === 'music' ? 'music.source' : 'settings.AudioSettingsModal.038');
                const input = page.getByRole('combobox', { name: inputName, exact: true });
                await expect(input).toBeVisible();
                const box = await input.boundingBox();
                expect(box && box.y >= 0 && box.y + box.height <= size.height).toBe(true);
                await page.screenshot({ path: `${shots}/${locale}-${purpose}-${size.width}x${size.height}.png`, animations: 'disabled' });
                if (size.width !== 1024) return;
                const opener = page.getByRole('button', { name: message(locale, 'purpose.switch'), exact: true });
                await opener.click();
                const dialog = page.getByRole('alertdialog', { name: message(locale, 'purpose.switchTitle') });
                await expect(dialog).toBeVisible();
                if (purpose === 'voice') await expect(dialog).toContainText(message(locale, 'settings.saveRestartHint'));
                await page.screenshot({ path: `${shots}/${locale}-${purpose}-dialog.png`, animations: 'disabled' });
                await page.getByRole('button', { name: message(locale, 'common.cancel') }).click();
                await expect(dialog).toHaveCount(0);
                await expect(opener).toBeFocused();
            });
        }
    }
}

test.describe('使い道の切り替え', () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1024, height: 768 }); });

    test('確認して切り替えると、表示・入力の用途・機器を保存し、実行中なら再起動して、前の機器を覚える', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: '使い道を切り替えます' });
        await expect(dialog).toContainText('音声が一瞬途切れます');
        await expect(dialog).toContainText('CABLE Output → USB Headphones');
        await dialog.getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByText('使い道：音楽鑑賞（PCの音にVSTをかけて聴く）')).toBeVisible();
        await expect(page.getByRole('button', { name: '切り替える', exact: true })).toBeFocused();
        const stored = await page.evaluate((): StoredState => ({
            display: localStorage.getItem('auralyn_display_purpose'),
            config: JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null') as StoredState['config'],
            usage: JSON.parse(localStorage.getItem('auralyn_usage_devices') ?? 'null') as StoredState['usage'],
            starts: window.__e2eStarts ?? [],
        }));
        expect(stored.display).toBe('music');
        expect(stored.config.inputSource.config.purpose).toBe('music');
        expect(stored.config.output).toBe('USB Headphones');
        expect(stored.usage.voice.output).toBe('スピーカー');
        expect(stored.usage.music.output).toBe('USB Headphones');
        expect(stored.starts).toHaveLength(1);
        expect(stored.starts[0].output).toBe('USB Headphones');
        expect(stored.starts[0].inputSource?.source.config.purpose).toBe('music');
    });

    test('再起動に失敗したら小窓に理由を出し、表示も音声設定も元のまま', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.goto('/?mock=live-home&screen=settings-audio');
        const before = await page.evaluate(() => localStorage.getItem('vst_host_audio_config'));
        await setFlag(page, '__e2eStartFailure', true);
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: '使い道を切り替えます' });
        await dialog.getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('テスト用: 機器が見つかりません');
        await expect(dialog.getByRole('alert')).toContainText('表示と音声設定は元のままです');
        expect(await page.evaluate(() => localStorage.getItem('auralyn_display_purpose'))).toBe('voice');
        expect(await page.evaluate(() => localStorage.getItem('vst_host_audio_config'))).toBe(before);
        await setFlag(page, '__e2eStartFailure', false);
        await dialog.getByRole('button', { name: 'キャンセル' }).click();
        await expect(page.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
    });

    test('アプリの音声の記録へは自動で再開せず、表示と入力の用途を下書きにして、アプリの選択欄へ案内する。保存値は保存まで変えない', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'], appMusic: true });
        await page.addInitScript(() => {
            const internals = window.__TAURI_INTERNALS__;
            if (!internals) return;
            const original = internals.invoke;
            internals.invoke = async (command, args) => command === 'get_process_input_sources'
                ? [{ id: 'app-1', appKey: 'b'.repeat(64), name: 'chrome.exe', routes: [{ id: 'endpoint', name: 'スピーカー', muted: false }] }]
                : original(command, args);
        });
        await page.goto('/?mock=live-home&screen=settings-audio');
        const before = await page.evaluate(() => localStorage.getItem('vst_host_audio_config'));
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: '使い道を切り替えます' });
        await expect(dialog).toContainText('アプリ「Player」の音声でした');
        await expect(dialog).not.toContainText('音声が一瞬途切れます');
        await page.screenshot({ path: `${shots}/ja-app-dialog.png`, animations: 'disabled' });
        await dialog.getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const app = page.getByRole('combobox', { name: '再生中のアプリ' });
        await expect(app).toBeFocused();
        await expect(page.getByText('前回のアプリ「Player」は、自動では再開できません。')).toBeVisible();
        await page.screenshot({ path: `${shots}/ja-app-after.png`, animations: 'disabled' });
        await expect(page.getByText('使い道：音楽鑑賞（PCの音にVSTをかけて聴く）')).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('auralyn_display_purpose'))).toBe('voice');
        expect(await page.evaluate(() => localStorage.getItem('vst_host_audio_config'))).toBe(before);
        expect(await page.evaluate(() => window.__e2eStarts ?? [])).toHaveLength(0);
    });

    const withAppCandidates = (page: Page) => page.addInitScript(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals) return;
        const original = internals.invoke;
        internals.invoke = async (command, args) => command === 'get_process_input_sources'
            ? [{ id: 'app-1', appKey: 'b'.repeat(64), name: 'chrome.exe', routes: [{ id: 'endpoint', name: 'スピーカー', muted: false }] }]
            : original(command, args);
    });

    test('アプリの音声の下書きを捨てて移動すると、表示も保存値も元のままで、入り直しても再起動しても食い違わない', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'], appMusic: true });
        await withAppCandidates(page);
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: '再生中のアプリ' })).toBeVisible();
        await page.getByRole('button', { name: 'ホーム', exact: true }).click();
        await page.getByRole('button', { name: '変更を捨てて移動', exact: true }).click();
        const stored = () => page.evaluate(() => ({
            display: localStorage.getItem('auralyn_display_purpose'),
            purpose: (JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null') as StoredState['config']).inputSource.config.purpose,
        }));
        expect(await stored()).toEqual({ display: 'voice', purpose: 'voice' });
        // 入り直し（読み直し）と、アプリの再起動を兼ねた再読み込み。保存値は利用者が残したまま。
        for (const reload of [false, true]) {
            if (reload) await page.reload(); else await page.goto('/?mock=live-home&screen=settings-audio');
            await expect(page.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
            await expect(page.getByText('ホームの表示と入力の用途が違います。')).toHaveCount(0);
            await expect(page.getByRole('button', { name: '切り替える', exact: true })).toBeEnabled();
            expect(await stored()).toEqual({ display: 'voice', purpose: 'voice' });
        }
    });

    test('アプリの音声の下書きは、アプリを選んで保存したときに初めて表示と離れる使い道の記録を確定する', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['music'], appMusic: true });
        await withAppCandidates(page);
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        const app = page.getByRole('combobox', { name: '再生中のアプリ' });
        await expect(app).toBeVisible();
        await app.selectOption({ index: 1 });
        // 記録の出力先はこの環境の機器に無いので、一覧にある出力先を選んでから保存する。
        await page.getByRole('combobox', { name: '出力先', exact: true }).selectOption({ label: 'スピーカー' });
        const save = page.getByRole('button', { name: '接続を保存して再起動' });
        await expect(save).toBeEnabled();
        expect(await page.evaluate(() => localStorage.getItem('auralyn_display_purpose'))).toBe('voice');
        expect(await page.evaluate(() => localStorage.getItem('auralyn_usage_devices'))).not.toContain('"voice"');
        await save.click();
        await expect.poll(() => page.evaluate(() => localStorage.getItem('auralyn_display_purpose'))).toBe('music');
        const after = await page.evaluate(() => ({
            config: JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null') as { inputSource: { kind: string; config: { purpose: string } } },
            usage: JSON.parse(localStorage.getItem('auralyn_usage_devices') ?? 'null') as Record<string, { output: string; inputSource: { kind: string } } | undefined>,
        }));
        expect(after.config.inputSource.kind).toBe('process_loopback');
        expect(after.config.inputSource.config.purpose).toBe('music');
        expect(after.usage.voice?.output).toBe('スピーカー');
        expect(after.usage.music?.inputSource.kind).toBe('process_loopback');
    });

    for (const locale of ['ja', 'en'] as const) {
        test(`アプリの音声の下書き中は、切り替えを押せず、理由を示す ${locale} 900x600`, async ({ page }) => {
            await seed(page, { purpose: 'voice', records: ['voice', 'music'], appMusic: true, locale });
            await withAppCandidates(page);
            await page.setViewportSize({ width: 900, height: 600 });
            await page.goto('/?mock=live-home&screen=settings-audio');
            const opener = page.getByRole('button', { name: message(locale, 'purpose.switch'), exact: true });
            await opener.click();
            await page.getByRole('alertdialog').getByRole('button', { name: message(locale, 'purpose.switch'), exact: true }).click();
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
            await expect(opener).toBeDisabled();
            const reason = page.getByText(message(locale, 'purpose.blockedPending'));
            await expect(reason).toBeVisible();
            await expect(opener).toHaveAccessibleDescription(message(locale, 'purpose.blockedPending'));
            const box = await reason.boundingBox();
            expect(box && box.x >= 0 && box.x + box.width <= 900).toBe(true);
            await page.screenshot({ path: `${shots}/${locale}-app-draft-900x600.png`, animations: 'disabled' });
        });
    }

    test('再起動のあとの VST の復元が失敗したら、切り替えを失敗として元の接続へ戻し、音楽鑑賞に確定しない', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.addInitScript(() => {
            const internals = window.__TAURI_INTERNALS__;
            if (!internals) return;
            const original = internals.invoke;
            let restarts = 0;
            internals.invoke = async (command, args) => {
                if (command === 'restart_audio_engine') {
                    restarts += 1;
                    const result = await original(command, args);
                    // 切り替えの再起動の直後だけ、実ラックの確認を失敗させる。元へ戻す再起動のあとは通常に戻る。
                    window.__e2eVstFailure = restarts === 1;
                    return result;
                }
                if (command === 'session_rack' && window.__e2eVstFailure && (args as { request?: { action?: string } } | undefined)?.request?.action === 'snapshot') {
                    throw new Error('テスト用: VST の確認失敗');
                }
                return original(command, args);
            };
        });
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: '使い道を切り替えます' });
        await dialog.getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText(message('ja', 'purpose.vstIncomplete'));
        await expect(dialog.getByRole('alert')).toContainText('表示と音声設定は元のままです');
        const stored = await page.evaluate(() => ({
            display: localStorage.getItem('auralyn_display_purpose'),
            purpose: (JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null') as StoredState['config']).inputSource.config.purpose,
            starts: window.__e2eStarts ?? [],
        }));
        expect(stored.display).toBe('voice');
        expect(stored.purpose).toBe('voice');
        expect(stored.starts).toHaveLength(2);
        expect(stored.starts[1].output).toBe('スピーカー');
    });

    test('切り替えの応答を待つ間は、ホームへ移る共通の操作を止める', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.addInitScript(() => {
            const internals = window.__TAURI_INTERNALS__;
            if (!internals) return;
            const original = internals.invoke;
            internals.invoke = async (command, args) => {
                if (command === 'restart_audio_engine') {
                    window.__e2eRestartHeld = true;
                    await new Promise<void>(resolve => { window.__e2eReleaseRestart = resolve; });
                }
                return original(command, args);
            };
        });
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '切り替える', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.__e2eRestartHeld)).toBe(true);
        // 小窓の外は読み上げの対象外になるため、includeHidden で共通のレールを指す。
        const home = page.getByRole('button', { name: 'ホーム', exact: true, includeHidden: true });
        await expect(home).toBeDisabled();
        await page.evaluate(() => window.__e2eReleaseRestart?.());
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(home).toBeEnabled();
        await home.click();
        await expect(page.locator('[data-settings-page]')).toHaveCount(0);
    });

    test('確定のあと機器一覧の応答が遅れても、押せるようになった時点で焦点を切り替えるボタンへ戻す', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.addInitScript(() => {
            const internals = window.__TAURI_INTERNALS__;
            if (!internals) return;
            const original = internals.invoke;
            internals.invoke = async (command, args) => {
                if (command === 'get_audio_devices' && window.__e2eBlockDevices) {
                    window.__e2eDevicesHeld = true;
                    await new Promise<void>(resolve => { window.__e2eReleaseDevices = resolve; });
                }
                return original(command, args);
            };
        });
        await page.goto('/?mock=live-home&screen=settings-audio');
        const opener = page.getByRole('button', { name: '切り替える', exact: true });
        await expect(opener).toBeEnabled();
        await opener.click();
        await page.evaluate(() => { window.__e2eBlockDevices = true; });
        await page.getByRole('alertdialog').getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__e2eDevicesHeld)).toBe(true);
        await expect(opener).toBeDisabled();
        await page.evaluate(() => { window.__e2eBlockDevices = false; window.__e2eReleaseDevices?.(); });
        await expect(opener).toBeEnabled();
        await expect(opener).toBeFocused();
    });

    test('切り替え先の記録が無いときは小窓ではなく、その目的でセットアップを開く', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice'] });
        await page.goto('/?mock=live-home&screen=settings-audio');
        await page.getByRole('button', { name: '切り替える', exact: true }).click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        const wizard = page.getByRole('dialog', { name: 'セットアップ' });
        await expect(wizard).toBeVisible();
        await expect(wizard.getByRole('heading', { level: 2 }).first()).toBeVisible();
        await expect(wizard.getByRole('heading', { name: '送り先を選んでください' })).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('auralyn_display_purpose'))).toBe('voice');
    });

    test('操作ロック中は切り替えを押せず、理由を近くに出す', async ({ page }) => {
        await seed(page, { purpose: 'voice', records: ['voice', 'music'] });
        await page.addInitScript(() => { window.__e2eArmed = true; });
        await page.goto('/?mock=live-home&screen=settings-audio');
        await expect(page.getByRole('button', { name: '切り替える', exact: true })).toBeDisabled();
        await expect(page.getByText('操作ロックの間は変更できません。解除すると変えられます。')).toBeVisible();
    });

    for (const purpose of ['voice', 'music'] as const) {
        test(`同じ見出しや欄の名前を続けて2回出さない（#712）${purpose}`, async ({ page }) => {
            await seed(page, { purpose, records: ['voice', 'music'] });
            await page.goto('/?mock=live-home&screen=settings-audio');
            await expect(page.getByRole('button', { name: '切り替える', exact: true })).toBeVisible();
            const lines = (await page.locator('[data-settings-page]').innerText()).split('\n').map(line => line.trim()).filter(Boolean);
            const repeated = lines.filter((line, index) => index > 0 && line === lines[index - 1]);
            expect(repeated).toEqual([]);
        });
    }
});
