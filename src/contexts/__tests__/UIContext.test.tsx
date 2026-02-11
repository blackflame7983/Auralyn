/**
 * UIContext のユニットテスト
 * useReducer パターンへの移行後の動作を検証
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { UIProvider, useUIState } from '../../contexts/UIContext';
import React from 'react';

// UIProvider でラップするヘルパー
function renderUIHook() {
    return renderHook(() => useUIState(), {
        wrapper: ({ children }: { children: React.ReactNode }) =>
            React.createElement(UIProvider, null, children),
    });
}

describe('UIContext', () => {
    describe('初期状態', () => {
        it('全モーダルが閉じている', () => {
            const { result } = renderUIHook();

            expect(result.current.isSettingsOpen).toBe(false);
            expect(result.current.isBrowserOpen).toBe(false);
            expect(result.current.isOBSGuideOpen).toBe(false);
            expect(result.current.isDiscordGuideOpen).toBe(false);
            expect(result.current.isWizardOpen).toBe(false);
            expect(result.current.isTemplateWizardOpen).toBe(false);
            expect(result.current.isLicenseModalOpen).toBe(false);
            expect(result.current.isRecoveryModalOpen).toBe(false);
            expect(result.current.isPresetManagerOpen).toBe(false);
            expect(result.current.isLargeMeterOpen).toBe(false);
        });

        it('crashError が null', () => {
            const { result } = renderUIHook();
            expect(result.current.crashError).toBeNull();
        });
    });

    describe('モーダル操作', () => {
        it('setIsSettingsOpen(true) で設定モーダルが開く', () => {
            const { result } = renderUIHook();

            act(() => {
                result.current.setIsSettingsOpen(true);
            });

            expect(result.current.isSettingsOpen).toBe(true);
        });

        it('setIsSettingsOpen(false) で設定モーダルが閉じる', () => {
            const { result } = renderUIHook();

            act(() => {
                result.current.setIsSettingsOpen(true);
            });
            act(() => {
                result.current.setIsSettingsOpen(false);
            });

            expect(result.current.isSettingsOpen).toBe(false);
        });

        it('複数のモーダルを同時に開ける', () => {
            const { result } = renderUIHook();

            act(() => {
                result.current.setIsSettingsOpen(true);
                result.current.setIsBrowserOpen(true);
            });

            expect(result.current.isSettingsOpen).toBe(true);
            expect(result.current.isBrowserOpen).toBe(true);
            // 他のモーダルは影響を受けない
            expect(result.current.isOBSGuideOpen).toBe(false);
        });

        it('setIsLargeMeterOpen にコールバック関数を渡すとトグルとして動作する', () => {
            const { result } = renderUIHook();

            // 初期状態: false → トグル → true
            act(() => {
                result.current.setIsLargeMeterOpen((prev: boolean) => !prev);
            });
            expect(result.current.isLargeMeterOpen).toBe(true);

            // true → トグル → false
            act(() => {
                result.current.setIsLargeMeterOpen((prev: boolean) => !prev);
            });
            expect(result.current.isLargeMeterOpen).toBe(false);
        });
    });

    describe('crashError', () => {
        it('setCrashError でエラーメッセージを設定できる', () => {
            const { result } = renderUIHook();

            act(() => {
                result.current.setCrashError('オーディオエンジンがクラッシュしました');
            });

            expect(result.current.crashError).toBe('オーディオエンジンがクラッシュしました');
        });

        it('setCrashError(null) でクリアできる', () => {
            const { result } = renderUIHook();

            act(() => {
                result.current.setCrashError('エラー');
            });
            act(() => {
                result.current.setCrashError(null);
            });

            expect(result.current.crashError).toBeNull();
        });
    });

    describe('エラーハンドリング', () => {
        it('UIProvider 外で useUIState を呼ぶとエラーを投げる', () => {
            // renderHook は React コンテキスト外で呼ばれるとエラーになることを検証
            expect(() => {
                renderHook(() => useUIState());
            }).toThrow('useUIState must be used within a UIProvider');
        });
    });
});
