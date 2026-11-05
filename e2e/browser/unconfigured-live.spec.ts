import { test, expect } from './tauriFixture';

// 未設定のホームは音の流れと次の1歩だけにするが、モードの状態を読めない・本番保護中などの注意は隠さない（#297、#263）。
// 欄を出す判定は、隠して置いた欄の中の LiveModeBar が読む状態に頼る。欄を描画しない形へ戻すと判定が二度と満たされない。
test('未設定のホームでも、モードの初回読込の失敗を示し、再取得で欄を畳む', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        let fail = true;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => {
            if (command === 'live_modes' && fail) { fail = false; return Promise.reject(new Error('lost connection')); }
            return original(command, args);
        };
    });
    await page.goto('/');
    await expect(page.getByRole('region', { name: '音の流れ', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '本番', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('モードの状態を取得できません');
    await page.getByRole('button', { name: 'モードの状態を再取得', exact: true }).click();
    // 未登録・本番保護なしと分かったら、登録の入口だけの欄は出さない。
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('[data-unconfigured-live]')).toBeHidden();
    // 送り先は OBS と決まっているので、次の1歩はマイク。
    await expect(page.getByRole('button', { name: 'マイクを決める', exact: true })).toBeVisible();
});
