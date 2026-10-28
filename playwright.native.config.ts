import { defineConfig } from '@playwright/test';

// scripts/test-native-e2e.mjsがビルドと保存先の隔離を行ってから呼ぶ。
export default defineConfig({
    testDir: './e2e/native', workers: 1, retries: 0, forbidOnly: true, timeout: 90_000,
    webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 1427', url: 'http://127.0.0.1:1427', reuseExistingServer: false, timeout: 60_000 },
});
