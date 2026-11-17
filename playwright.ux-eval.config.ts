import { defineConfig } from '@playwright/test';

// 通常の npm run test:e2e と CI は playwright.config.ts（testDir: e2e/browser）だけを使う。
// 模擬（?mock=）は開発サーバーにしか入らないので、CI の環境変数があっても vite preview は使わない。
const port = Number(process.env.UX_EVAL_PORT ?? 1427);
const origin = `http://127.0.0.1:${port}`;

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
    use: { browserName: 'chromium', baseURL: origin, trace: 'retain-on-failure' },
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: origin,
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
