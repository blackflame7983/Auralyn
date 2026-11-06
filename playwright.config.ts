import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e/browser',
    // Playwrightが開始時に消す範囲を限定し、実Hostの証拠や試験用アプリを保護する。
    outputDir: './test-results/browser-output',
    forbidOnly: true,
    // page単位のIPC/Storageモックは独立している。CIはファイル単位で2並列にし、
    // 各ファイル内の順序は維持する。CLIの--workers=1で直列の再現もできる。
    workers: process.env.CI ? 2 : 1,
    retries: 0,
    // CI の実行環境は手元より遅い。失敗を再試行で隠さず、待つ上限だけを CI で延ばす。
    timeout: process.env.CI ? 60_000 : 30_000,
    expect: { timeout: process.env.CI ? 15_000 : 5_000 },
    use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:1427', trace: 'retain-on-failure' },
    webServer: {
        // CI は直前の手順で作った本番ビルドを配る。開発サーバーは部品を1つずつ変換して返すため、
        // CI では設定画面などの遅延読込が途中で止まり、操作しても画面が出ないことがあった（#318）。
        // 手元は古い dist を試さないよう、開発サーバーのまま動かす。E2E_PREVIEW=1 で CI と同じ形を試せる。
        command: process.env.CI || process.env.E2E_PREVIEW
            ? 'npx vite preview --host 127.0.0.1 --port 1427 --strictPort'
            : 'npm run dev -- --host 127.0.0.1 --port 1427',
        url: 'http://127.0.0.1:1427',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
