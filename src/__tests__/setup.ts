/**
 * テスト環境のセットアップ
 * - testing-library の拡張マッチャーを追加
 * - Tauri APIのモック
 */
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Tauri の invoke APIをモック化
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

// Tauri の event APIをモック化
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(() => Promise.resolve(() => { })),
    emit: vi.fn(),
}));

// Tauri の opener プラグインをモック化
vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(),
}));
