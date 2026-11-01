import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

// scripts/test-native-e2e.mjsがビルドと保存先の隔離を行ってから呼ぶ。
export default defineConfig({
    testDir: './e2e/native', workers: 1, retries: 0, forbidOnly: true, timeout: 90_000,
    // Playwrightの初期化が他の監査画像を消さないよう、実行ごとの隔離先へ保存する。
    outputDir: process.env.AURALYN_E2E_ROOT ? join(process.env.AURALYN_E2E_ROOT, 'results') : './test-results/native-e2e',
    webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 1427', url: 'http://127.0.0.1:1427', reuseExistingServer: false, timeout: 60_000 },
});
