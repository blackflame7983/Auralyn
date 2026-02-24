import React, { useState, useEffect } from 'react';
import { MdClose, MdCheckCircle, MdError, MdWarning, MdRefresh, MdHelpOutline, MdMic, MdVolumeUp, MdExtension, MdCable } from 'react-icons/md';
import { audioApi } from '../../../api/audio';

interface TroubleshootModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenSettings: () => void;
    onOpenOBSGuide: () => void;
}

type CheckStatus = 'pending' | 'checking' | 'ok' | 'warning' | 'error';

interface DiagnosticCheck {
    id: string;
    label: string;
    description: string;
    icon: React.ReactNode;
    status: CheckStatus;
    detail?: string;
    action?: { label: string; onClick: () => void };
}

export const TroubleshootModal: React.FC<TroubleshootModalProps> = ({ isOpen, onClose, onOpenSettings, onOpenOBSGuide }) => {
    const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
    const [isRunning, setIsRunning] = useState(false);

    const updateCheck = (id: string, update: Partial<DiagnosticCheck>) => {
        setChecks(prev => prev.map(c => c.id === id ? { ...c, ...update } : c));
    };

    const runDiagnostics = async () => {
        setIsRunning(true);
        const setupGoal = localStorage.getItem('vst_host_setup_goal');
        const expectsVirtualOutput = setupGoal === 'obs' || setupGoal === 'discord';

        // Initialize checks
        const initialChecks: DiagnosticCheck[] = [
            {
                id: 'engine',
                label: 'オーディオエンジン',
                description: '音声処理エンジンが起動しているか',
                icon: <MdVolumeUp className="w-5 h-5" />,
                status: 'checking',
            },
            {
                id: 'input',
                label: '入力デバイス（マイク）',
                description: 'マイクが認識されているか',
                icon: <MdMic className="w-5 h-5" />,
                status: 'pending',
            },
            {
                id: 'output',
                label: '出力デバイス',
                description: '出力先が設定されているか',
                icon: <MdVolumeUp className="w-5 h-5" />,
                status: 'pending',
            },
            {
                id: 'plugins',
                label: 'プラグイン',
                description: 'エフェクトが正しく動作しているか',
                icon: <MdExtension className="w-5 h-5" />,
                status: 'pending',
            },
            {
                id: 'routing',
                label: '音声ルーティング',
                description: '出力先が仮想ケーブルに接続されているか',
                icon: <MdCable className="w-5 h-5" />,
                status: 'pending',
            },
        ];
        setChecks(initialChecks);

        // Check 1: Engine running?
        try {
            const state = await audioApi.getAudioState();
            if (state && state.is_running) {
                updateCheck('engine', { status: 'ok', detail: 'エンジンは正常に動作中です' });
            } else {
                updateCheck('engine', {
                    status: 'error',
                    detail: 'エンジンが停止しています。設定画面から開始してください。',
                    action: { label: '設定を開く', onClick: () => { onClose(); onOpenSettings(); } }
                });
                setIsRunning(false);
                // Mark remaining as unknown
                ['input', 'output', 'plugins', 'routing'].forEach(id =>
                    updateCheck(id, { status: 'warning', detail: 'エンジンが停止中のため確認できません' })
                );
                return;
            }
        } catch {
            updateCheck('engine', { status: 'error', detail: 'エンジンの状態を取得できませんでした' });
            setIsRunning(false);
            return;
        }

        // Check 2: Input device
        updateCheck('input', { status: 'checking' });
        try {
            const devices = await audioApi.getDevices(true);
            const state = await audioApi.getAudioState();
            const hasInput = state?.config?.input;
            const inputExists = devices.inputs.some((d: any) => d.name === hasInput);

            if (hasInput && inputExists) {
                updateCheck('input', { status: 'ok', detail: `入力: ${hasInput}` });
            } else if (hasInput && !inputExists) {
                updateCheck('input', {
                    status: 'error',
                    detail: `「${hasInput}」が見つかりません。接続を確認してください。`,
                    action: { label: '設定を開く', onClick: () => { onClose(); onOpenSettings(); } }
                });
            } else {
                updateCheck('input', {
                    status: 'warning',
                    detail: '入力デバイスが設定されていません',
                    action: { label: '設定を開く', onClick: () => { onClose(); onOpenSettings(); } }
                });
            }
        } catch {
            updateCheck('input', { status: 'warning', detail: 'デバイス情報を取得できませんでした' });
        }

        // Check 3: Output device
        updateCheck('output', { status: 'checking' });
        try {
            const state = await audioApi.getAudioState();
            const hasOutput = state?.config?.output;
            if (hasOutput) {
                const isVirtualCable = /virtual|vb-|voicemeeter|cable/i.test(hasOutput);
                updateCheck('output', {
                    status: 'ok',
                    detail: `出力: ${hasOutput}${isVirtualCable ? ' (仮想ケーブル ✓)' : ''}`
                });

                // Check 5: Routing hint
                if (isVirtualCable) {
                    updateCheck('routing', {
                        status: 'ok',
                        detail: '仮想ケーブルに出力中。OBSの入力にこのケーブルを設定してください。',
                        action: { label: 'OBSガイド', onClick: () => { onClose(); onOpenOBSGuide(); } }
                    });
                } else if (expectsVirtualOutput) {
                    updateCheck('routing', {
                        status: 'warning',
                        detail: '配信/通話向け設定では、仮想ケーブル出力の方が安定します。',
                        action: { label: 'OBSガイドを見る', onClick: () => { onClose(); onOpenOBSGuide(); } }
                    });
                } else {
                    updateCheck('routing', {
                        status: 'ok',
                        detail: 'スピーカー/ヘッドホン出力です。ローカル試聴用途では問題ありません。'
                    });
                }
            } else {
                updateCheck('output', {
                    status: 'warning',
                    detail: '出力デバイスが設定されていません',
                    action: { label: '設定を開く', onClick: () => { onClose(); onOpenSettings(); } }
                });
                updateCheck('routing', { status: 'warning', detail: '出力未設定のため確認できません' });
            }
        } catch {
            updateCheck('output', { status: 'warning', detail: '出力情報を取得できませんでした' });
            updateCheck('routing', { status: 'warning', detail: '確認できませんでした' });
        }

        // Check 4: Plugins
        updateCheck('plugins', { status: 'checking' });
        try {
            const stats = await audioApi.getEngineRuntimeStats();
            if (stats.enabledPluginCount > 0) {
                updateCheck('plugins', {
                    status: 'ok',
                    detail: `現在 ${stats.enabledPluginCount} 個のプラグインが有効です（読込: ${stats.activePluginCount}）`
                });
            } else {
                updateCheck('plugins', {
                    status: 'warning',
                    detail: '現在有効なプラグインはありません。エフェクトを追加してください。'
                });
            }
        } catch {
            // Fallback to session snapshot when runtime stats are unavailable
            try {
                const sessionRaw = localStorage.getItem('vst_host_session_plugins');
                if (sessionRaw) {
                    const session = JSON.parse(sessionRaw);
                    const pluginCount = Array.isArray(session) ? session.length : 0;
                    const enabledCount = Array.isArray(session) ? session.filter((p: any) => p.enabled !== false).length : 0;
                    if (pluginCount === 0) {
                        updateCheck('plugins', { status: 'warning', detail: 'プラグインが読み込まれていません。エフェクトを追加してください。' });
                    } else {
                        updateCheck('plugins', { status: 'ok', detail: `${pluginCount}個のプラグイン（${enabledCount}個が有効）` });
                    }
                } else {
                    updateCheck('plugins', { status: 'warning', detail: 'プラグイン情報を取得できませんでした' });
                }
            } catch {
                updateCheck('plugins', { status: 'warning', detail: 'プラグイン情報を取得できませんでした' });
            }
        }

        setIsRunning(false);
    };

    useEffect(() => {
        if (isOpen) {
            runDiagnostics();
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const statusIcon = (status: CheckStatus) => {
        switch (status) {
            case 'ok': return <MdCheckCircle className="w-5 h-5 text-emerald-500" />;
            case 'error': return <MdError className="w-5 h-5 text-destructive" />;
            case 'warning': return <MdWarning className="w-5 h-5 text-amber-500" />;
            case 'checking': return <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />;
            default: return <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30" />;
        }
    };

    const errorCount = checks.filter(c => c.status === 'error').length;
    const warnCount = checks.filter(c => c.status === 'warning').length;

    return (
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-lg animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="modal-header-base">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-amber-500/10 rounded-lg">
                            <MdHelpOutline className="w-5 h-5 text-amber-500" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">音声トラブルシューティング</h2>
                            <p className="text-xs text-muted-foreground">設定を自動チェックして問題を特定します</p>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label="トラブルシューティングを閉じる" className="p-2 rounded-lg hover:bg-muted text-muted-foreground">
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                {/* Summary bar */}
                {!isRunning && checks.length > 0 && (
                    <div className={`px-6 py-3 text-sm font-bold flex items-center gap-2 ${
                        errorCount > 0 ? 'bg-destructive/10 text-destructive' :
                        warnCount > 0 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}>
                        {errorCount > 0 ? (
                            <><MdError className="w-4 h-4" /> {errorCount}件の問題が見つかりました</>
                        ) : warnCount > 0 ? (
                            <><MdWarning className="w-4 h-4" /> {warnCount}件の注意点があります</>
                        ) : (
                            <><MdCheckCircle className="w-4 h-4" /> すべて正常です</>
                        )}
                    </div>
                )}

                {/* Checks list */}
                <div className="p-6 space-y-4">
                    {checks.map(check => (
                        <div key={check.id} className="flex items-start gap-4">
                            <div className="mt-0.5 shrink-0">{statusIcon(check.status)}</div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-muted-foreground">{check.icon}</span>
                                    <h3 className="font-bold text-sm text-foreground">{check.label}</h3>
                                </div>
                                {check.detail && (
                                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{check.detail}</p>
                                )}
                                {check.action && (
                                    <button
                                        onClick={check.action.onClick}
                                        className="mt-2 px-3 py-1 text-xs font-bold text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors"
                                    >
                                        {check.action.label}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-muted/30">
                    <p className="text-[10px] text-muted-foreground">
                        解決しない場合は、設定から「エンジン再起動」をお試しください
                    </p>
                    <button
                        onClick={runDiagnostics}
                        disabled={isRunning}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50"
                    >
                        <MdRefresh className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
                        再チェック
                    </button>
                </div>
            </div>
        </div>
    );
};
