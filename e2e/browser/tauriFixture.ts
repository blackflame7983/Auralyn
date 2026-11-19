import { test as base, expect } from '@playwright/test';
import { installTauriMock, type MockDeviceSet } from '../../src/dev/tauriMock';
import './tauriWindow';
import { deniedStorageOnErrorPage, retryTransientNavigation, transientNavigationError } from './helpers/transientGoto';

// この層だけがIPCをモックする。模擬応答の本体は開発プレビュー（?mock=）と共有する。実接続試験はe2e/nativeに分離する。
export const test = base.extend<{ transport: void; nativeMeterProfile: boolean; stoppedHome: boolean; liveHome: boolean; registeredModes: boolean; builtinEnabled: boolean; devices: MockDeviceSet }>({
    nativeMeterProfile: [false, { option: true }],
    stoppedHome: [false, { option: true }],
    liveHome: [false, { option: true }],
    registeredModes: [true, { option: true }],
    builtinEnabled: [false, { option: true }],
    devices: ['legacy', { option: true }],
    transport: [async ({ page, liveHome, stoppedHome, registeredModes, builtinEnabled, nativeMeterProfile, devices }, use, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(installTauriMock, { liveHome, stoppedHome, registeredModes, builtinEnabled, nativeMeterProfile, devices, strict: true });
        // 一時的なソケット不足のときだけ開き直す（helpers/transientGoto.ts）。
        const transientRetries = retryTransientNavigation(page, errors);
        await use();
        const retried = transientRetries();
        if (retried > 0) testInfo.annotations.push({ type: 'transient-network-retry', description: `${transientNavigationError} で ${retried} 回開き直した` });
        const unexpected = await page.evaluate(() => window.__e2eUnexpected);
        expect(unexpected, '未定義IPCを成功した応答で隠さない').toEqual([]);
        // 例外の発生は非同期なので、開き直した場合は、エラーページの localStorage の拒否だけを除く。
        expect(retried > 0 ? errors.filter(message => message !== deniedStorageOnErrorPage) : errors, '画面の実行時例外').toEqual([]);
    }, { auto: true }],
});
export { expect };
