import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e/browser',
    forbidOnly: true,
    workers: 1,
    retries: 0,
    timeout: 30_000,
    use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:1427', trace: 'retain-on-failure' },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 1427',
        url: 'http://127.0.0.1:1427',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
