import { defineConfig } from '@playwright/test';

// 通常の npm run test:e2e と CI は playwright.config.ts（testDir: e2e/browser）だけを使う。
// webServer はそちらの設定と同じ。模擬（?mock=）は開発サーバーにしか入らない。
export default defineConfig({
    testDir: './e2e/ux-eval',
    testMatch: 'capture.ts',
    outputDir: './test-results/ux-eval-playwright',
    forbidOnly: true,
    fullyParallel: true,
    workers: 2,
    retries: 0,
    timeout: 180_000,
    expect: { timeout: 60_000 },
    use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:1427', trace: 'retain-on-failure' },
    webServer: {
        command: process.env.CI || process.env.E2E_PREVIEW
            ? 'npx vite preview --host 127.0.0.1 --port 1427 --strictPort'
            : 'npm run dev -- --host 127.0.0.1 --port 1427',
        url: 'http://127.0.0.1:1427',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
