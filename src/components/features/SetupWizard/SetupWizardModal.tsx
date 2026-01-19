import React, { useState } from 'react';
import { audioApi } from '../../../api/audio';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { MdAutoFixHigh, MdCheckCircle, MdWarning, MdMic, MdVolumeUp, MdError, MdRefresh, MdSettings, MdOpenInNew, MdCast, MdGraphicEq } from 'react-icons/md';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';

interface SetupWizardModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApplyConfig: (host: string, input?: string, output?: string) => void;
    onOpenSettings?: () => void;
}

type WizardState = 'welcome' | 'goal_selection' | 'diagnosing' | 'result' | 'configuring' | 'complete';
type UserGoal = 'obs' | 'discord' | 'other';

interface DiagnosisResult {
    status: 'ok' | 'warning' | 'critical';
    message: string;
    details: string[];
    canAutoFix: boolean;
    recommendedConfig?: {
        host: string;
        input: string;
        output: string;
    };
}

export const SetupWizardModal: React.FC<SetupWizardModalProps> = ({ isOpen, onClose, onApplyConfig, onOpenSettings }) => {
    const [state, setState] = useState<WizardState>('welcome');
    const [goal, setGoal] = useState<UserGoal | null>(null);
    const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);

    const runDiagnosis = async (selectedGoal: UserGoal) => {
        setGoal(selectedGoal);
        setState('diagnosing');
        try {
            const result = await audioApi.getDevices(true);

            // Analysis Logic
            const inputs = result.inputs;
            const outputs = result.outputs;

            const vbCableIn = outputs.find(d => d.name.includes("CABLE Input") || d.name.includes("VB-Audio"));
            const voicemeeter = outputs.find(d => d.name.includes("Voicemeeter"));

            const hasVirtualCable = !!vbCableIn;

            let status: 'ok' | 'warning' | 'critical' = 'ok';
            let message = "セットアップの準備が整いました";
            let details: string[] = [];
            let canAutoFix = false;
            let recommendedConfig: { host: string; input: string; output: string; } | undefined = undefined;

            // Goal-Specific Logic
            if (!hasVirtualCable && !voicemeeter) {
                if (selectedGoal === 'other') {
                    // For "Other" (Testing/Recording), lack of cable is OK.
                    status = 'ok';
                    message = "仮想ケーブルは未検出です";
                    details.push("仮想ケーブルは未検出ですが、このアプリ単体で“音が出るか”のテスト（モニター）は可能です。");
                    details.push("※ 配信や通話で使用する場合は、別途VB-CABLEの導入を推奨します。");
                } else {
                    // For OBS/Discord, Cable is Critical
                    status = 'critical';
                    const targetName = selectedGoal === 'discord' ? "Discord" : "OBS";
                    message = `${targetName}への出力デバイスが見つかりません`;
                    details.push("「VB-CABLE」または「Voicemeeter」がインストールされていません。");
                    details.push(`Auralynで加工した音声を${targetName}に送るには仮想ケーブルが必要です。`);
                }
            } else {
                details.push("仮想オーディオデバイスを検出しました");
            }

            // Common Device Detection Logic
            // WASAPI優先: WASAPIデバイスを最初に検索
            const wasapiInputs = inputs.filter(d => d.host.toUpperCase() === 'WASAPI');
            const wasapiOutputs = outputs.filter(d => d.host.toUpperCase() === 'WASAPI');

            // Find WASAPI mic (exclude virtual cables)
            const realMic = wasapiInputs.find(d =>
                !d.name.includes("CABLE") &&
                !d.name.includes("Voicemeeter") &&
                !d.name.includes("Stereo Mix")
            ) || inputs.find(d => // Fallback to any host
                !d.name.includes("CABLE") &&
                !d.name.includes("Voicemeeter") &&
                !d.name.includes("Stereo Mix")
            );

            if (!realMic) {
                status = 'warning';
                message = "マイクが見つかりません";
                details.push("有効なマイク入力が見つかりませんでした。");
                canAutoFix = false;
            } else {
                details.push(`マイク検出: ${realMic.name} (${realMic.host})`);

                // If status was critical (no cable for OBS/Discord), it stays critical.
                if (status !== 'critical') {
                    status = 'ok';
                    canAutoFix = true;

                    // Find Output based on Goal
                    let targetOutput = null;

                    if (hasVirtualCable || voicemeeter) {
                        // Use Virtual Cable if available (Preferred for all logic if present)
                        // WASAPI Virtual Output
                        targetOutput = wasapiOutputs.find(d => {
                            const nameLower = d.name.toLowerCase();
                            return nameLower.includes("cable") ||
                                nameLower.includes("vb-audio") ||
                                nameLower.includes("voicemeeter");
                        }) || vbCableIn || voicemeeter;

                        if (selectedGoal === 'other') {
                            details.push("仮想ケーブル経由で出力します");
                        }
                    } else if (selectedGoal === 'other') {
                        // If no cable and goal is other, find a real speaker
                        targetOutput = wasapiOutputs.find(d => {
                            const nameLower = d.name.toLowerCase();
                            return !nameLower.includes("cable") &&
                                !nameLower.includes("voicemeeter");
                        }) || outputs[0];
                        details.push(`モニタリング出力: ${targetOutput?.name || '標準デバイス'}`);
                    }

                    // Constuct Config
                    if (targetOutput && realMic) {
                        // Try to match hosts
                        if (targetOutput.host === realMic.host) {
                            details.push(`${targetOutput.host}モード: 入出力を統一`);
                            recommendedConfig = {
                                host: targetOutput.host,
                                input: realMic.name,
                                output: targetOutput.name
                            };
                        } else if (targetOutput.host === 'WASAPI' || realMic.host === 'WASAPI') {
                            // Force WASAPI if possible
                            const wasapiMic = wasapiInputs.find(d => d.name === realMic.name);
                            const wasapiOut = wasapiOutputs.find(d => d.name === targetOutput!.name);

                            if (wasapiMic && wasapiOut) {
                                recommendedConfig = {
                                    host: "WASAPI",
                                    input: wasapiMic.name,
                                    output: wasapiOut.name
                                };
                                details.push("WASAPI推奨設定を適用可能");
                            } else {
                                // Asio/Wasapi mismatch etc.
                                status = 'warning';
                                message = "デバイス構成が複雑です";
                                details.push("入力と出力のドライバ形式が一致しません。");
                                details.push("推奨: 手動設定を確認してください。");
                                canAutoFix = false;
                            }
                        } else {
                            // Fallback
                            recommendedConfig = {
                                host: realMic.host, // Prefer Mic host
                                input: realMic.name,
                                output: targetOutput.name
                            };
                        }
                    }
                }
            }

            setDiagnosis({
                status,
                message,
                details,
                canAutoFix,
                recommendedConfig
            });
            setState('result');

        } catch (e) {
            console.error("Diagnosis failed:", e);
            const errorMsg = e instanceof Error ? e.message : String(e);
            toast.error(`デバイス情報の取得に失敗: ${errorMsg}`);
            setState('welcome');
        }
    };

    const handleAutoFix = async () => {
        if (diagnosis?.recommendedConfig) {
            setState('configuring');
            try {
                const { host, input, output } = diagnosis.recommendedConfig;
                onApplyConfig(host, input, output);
                await audioApi.start(host, input, output);
                setState('complete');
                toast.success("セットアップが完了しました！");
            } catch (e) {
                console.error(e);
                toast.error("設定の適用に失敗しました");
                setState('result');
            }
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-card border border-border rounded-xl p-8 w-full max-w-2xl shadow-lg relative overflow-hidden">

                {state === 'welcome' && (
                    <div className="text-center space-y-8 animate-in zoom-in-95 duration-300">
                        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-primary/50 shadow-[0_0_30px_rgba(var(--primary),0.2)]">
                            <MdAutoFixHigh className="w-10 h-10 text-primary" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-2xl font-bold text-foreground">かんたんセットアップ</h2>
                            <p className="text-muted-foreground">
                                あなたの目的に合わせて、最適なオーディオ設定を自動で診断・提案します。<br />
                                まずは使用目的を教えてください。
                            </p>
                        </div>
                        <button
                            onClick={() => setState('goal_selection')}
                            className="px-8 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-full shadow-lg transition-all text-lg flex items-center gap-2 mx-auto"
                        >
                            <MdRefresh className="w-5 h-5" />
                            はじめる
                        </button>
                        <button
                            onClick={onClose}
                            className="text-muted-foreground hover:text-foreground transition-colors text-sm underline decoration-muted hover:decoration-muted-foreground underline-offset-4"
                        >
                            スキップして自分で設定する
                        </button>
                    </div>
                )}

                {state === 'goal_selection' && (
                    <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                        <h2 className="text-xl font-bold text-foreground text-center mb-6">どのような用途で使用しますか？</h2>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {/* OBS Goal */}
                            <button
                                onClick={() => runDiagnosis('obs')}
                                className="flex flex-col items-center p-6 border border-border rounded-xl hover:border-primary hover:bg-primary/5 transition-all group"
                            >
                                <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mb-3 group-hover:bg-blue-500/20 text-blue-500">
                                    <MdCast className="w-6 h-6" />
                                </div>
                                <h3 className="font-bold text-foreground mb-1">OBSで配信</h3>
                                <p className="text-xs text-muted-foreground text-center">
                                    加工した音声をOBSに送る設定をします
                                </p>
                            </button>

                            {/* Discord Goal */}
                            <button
                                onClick={() => runDiagnosis('discord')}
                                className="flex flex-col items-center p-6 border border-border rounded-xl hover:border-indigo-500 hover:bg-indigo-500/5 transition-all group"
                            >
                                <div className="w-12 h-12 rounded-full bg-indigo-500/10 flex items-center justify-center mb-3 group-hover:bg-indigo-500/20 text-indigo-500">
                                    <DiscordIcon className="w-6 h-6" />
                                </div>
                                <h3 className="font-bold text-foreground mb-1">そのほか通話</h3>
                                <p className="text-xs text-muted-foreground text-center">
                                    Discord等の通話アプリで使用
                                </p>
                            </button>

                            {/* Other Goal */}
                            <button
                                onClick={() => runDiagnosis('other')}
                                className="flex flex-col items-center p-6 border border-border rounded-xl hover:border-emerald-500 hover:bg-emerald-500/5 transition-all group"
                            >
                                <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mb-3 group-hover:bg-emerald-500/20 text-emerald-500">
                                    <MdGraphicEq className="w-6 h-6" />
                                </div>
                                <h3 className="font-bold text-foreground mb-1">とりあえず試す</h3>
                                <p className="text-xs text-muted-foreground text-center">
                                    音のテスト（モニター）など
                                </p>
                            </button>
                        </div>
                        <div className="text-center mt-4">
                            <button onClick={() => setState('welcome')} className="text-sm text-muted-foreground hover:text-foreground">戻る</button>
                        </div>
                    </div>
                )}

                {state === 'diagnosing' && (
                    <div className="text-center py-12 space-y-6">
                        <div className="w-16 h-16 border-4 border-muted border-t-primary rounded-full animate-spin mx-auto" />
                        <p className="text-xl font-medium text-muted-foreground animate-pulse">
                            デバイスと構成を確認中...
                        </p>
                    </div>
                )}

                {state === 'result' && diagnosis && (
                    <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                        <div className={`p-4 rounded-xl border ${diagnosis.status === 'ok' ? 'bg-green-500/10 border-green-500/30' :
                            diagnosis.status === 'critical' ? 'bg-destructive/10 border-destructive/30' :
                                'bg-yellow-500/10 border-yellow-500/30'
                            } flex items-start gap-4`}>
                            {diagnosis.status === 'ok' ? <MdCheckCircle className="w-6 h-6 text-green-500 mt-1" /> :
                                diagnosis.status === 'critical' ? <MdError className="w-6 h-6 text-destructive mt-1" /> :
                                    <MdWarning className="w-6 h-6 text-yellow-500 mt-1" />}
                            <div>
                                <h3 className={`text-lg font-bold ${diagnosis.status === 'ok' ? 'text-green-500' :
                                    diagnosis.status === 'critical' ? 'text-destructive' :
                                        'text-yellow-500'
                                    }`}>{diagnosis.message}</h3>
                                <ul className="mt-2 space-y-1">
                                    {diagnosis.details.map((d, i) => (
                                        <li key={i} className="text-muted-foreground text-sm flex items-center gap-2">
                                            <span className="w-1 h-1 bg-muted-foreground/50 rounded-full" />
                                            {d}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>

                        {diagnosis.recommendedConfig && (
                            <div className="bg-muted/30 p-6 rounded-xl border border-border space-y-4">
                                <h4 className="text-foreground font-bold flex items-center gap-2">
                                    <MdSettings className="w-5 h-5 text-primary" />
                                    推奨設定 ({goal === 'obs' ? 'OBS向け' : goal === 'discord' ? '通話向け' : '基本設定'})
                                </h4>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div className="bg-card p-3 rounded-lg border border-border">
                                        <span className="text-muted-foreground block text-xs mb-1">入力 (マイク)</span>
                                        <div className="text-foreground truncate flex items-center gap-2">
                                            <MdMic className="w-4 h-4 text-primary" />
                                            {diagnosis.recommendedConfig.input}
                                        </div>
                                    </div>
                                    <div className="bg-card p-3 rounded-lg border border-border">
                                        <span className="text-muted-foreground block text-xs mb-1">出力 ({goal === 'other' ? 'モニター' : '仮想ケーブル'})</span>
                                        <div className="text-foreground truncate flex items-center gap-2">
                                            <MdVolumeUp className="w-4 h-4 text-green-500" />
                                            {diagnosis.recommendedConfig.output}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex flex-wrap gap-3 justify-between pt-4">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setState('goal_selection')}
                                    className="px-4 py-2 text-muted-foreground hover:text-primary transition-colors flex items-center gap-2 whitespace-nowrap flex-shrink-0"
                                >
                                    <MdRefresh className="w-4 h-4" />
                                    目的を選びなおす
                                </button>
                                <button
                                    onClick={() => {
                                        onClose();
                                        onOpenSettings?.();
                                    }}
                                    className="px-4 py-2 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-2 whitespace-nowrap flex-shrink-0"
                                >
                                    <MdSettings className="w-4 h-4" />
                                    手動で設定
                                </button>
                            </div>
                            <div className="flex gap-3">
                                {diagnosis.canAutoFix ? (
                                    <button
                                        onClick={handleAutoFix}
                                        className="px-6 py-2 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow-lg hover:shadow-green-500/20 transition-all flex items-center gap-2 whitespace-nowrap"
                                    >
                                        <MdCheckCircle className="w-4 h-4" />
                                        この設定を適用
                                    </button>
                                ) : (
                                    <div className="flex gap-2">
                                        {(goal === 'obs' || goal === 'discord') && (
                                            <button
                                                onClick={() => invoke('open_url', { url: 'https://vb-audio.com/Cable/' }).catch(() => window.open('https://vb-audio.com/Cable/', '_blank'))}
                                                className="px-4 py-2 bg-muted hover:bg-muted/80 text-foreground text-xs font-bold rounded-lg border border-border transition-all flex items-center gap-2 whitespace-nowrap"
                                            >
                                                <MdOpenInNew className="w-3 h-3" />
                                                VB-CABLE入手
                                            </button>
                                        )}
                                        <button
                                            onClick={() => runDiagnosis(goal!)}
                                            className="px-5 py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-lg shadow-lg hover:shadow-primary/25 transition-all flex items-center gap-2 animate-pulse whitespace-nowrap"
                                        >
                                            <MdRefresh className="w-4 h-4" />
                                            再試行
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {state === 'configuring' && (
                    <div className="text-center py-12 space-y-6">
                        <div className="w-16 h-16 border-4 border-muted border-t-green-500 rounded-full animate-spin mx-auto" />
                        <p className="text-xl font-medium text-green-500">
                            設定を適用中...
                        </p>
                    </div>
                )}

                {state === 'complete' && (
                    <div className="text-center space-y-8 animate-in zoom-in-95 duration-300">
                        <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-green-500/50 shadow-[0_0_30px_rgba(34,197,94,0.2)]">
                            <MdCheckCircle className="w-10 h-10 text-green-500" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-2xl font-bold text-foreground">セットアップ完了！</h2>
                            <p className="text-muted-foreground">
                                オーディオエンジンの起動に成功しました。<br />
                                次は「エフェクトを追加」して、音作りを始めましょう。
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            className="px-8 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-full shadow-lg transition-all text-lg flex items-center gap-2 mx-auto"
                        >
                            さっそくはじめる
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
