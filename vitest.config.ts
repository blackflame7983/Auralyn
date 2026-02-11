import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        // テスト環境: jsdomを使用してDOM APIをエミュレート
        environment: 'jsdom',
        // テストファイルのパターン
        include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
        // セットアップファイル
        setupFiles: ['src/__tests__/setup.ts'],
        // グローバルなテスト関数（describe, it, expect等）を自動インポート
        globals: true,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
