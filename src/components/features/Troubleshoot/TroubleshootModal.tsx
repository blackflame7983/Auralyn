import { Modal } from '../../ui/modal';
import { deviceDisplayName, findCableReceiver, receiverDeviceHint } from '../../../lib/audioRouting';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    MdClose, MdCheckCircle, MdError, MdWarning, MdRefresh, MdHelpOutline,
    MdContentCopy, MdArrowBack,
} from 'react-icons/md';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import {
    audioApi,
    type LoopbackProbeResult,
    type RoutingDiagnosticsReport,
} from '../../../api/audio';

interface TroubleshootModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenSettings: () => void;
    onOpenOBSGuide: () => void;
    onOpenDiscordGuide?: () => void;
}

type Purpose = 'discord' | 'obs' | 'other' | 'listen';
type WizardPhase = 'purpose' | 'running' | 'results';
type CheckStatus = 'pending' | 'checking' | 'ok' | 'warning' | 'error' | 'skipped';

interface DiagnosticItem {
    id: string;
    label: string;
    description: string;
    status: CheckStatus;
    detail?: string;
    fixHint?: string;
    action?: { label: string; onClick: () => void };
}

const PURPOSE_OPTIONS: { id: Purpose; label: string; hint: string }[] = [
    { id: 'discord', label: 'Discord（通話）', hint: '仮想ケーブル経由で相手に届ける' },
    { id: 'obs', label: 'OBS（配信・録画）', hint: '仮想ケーブルを OBS の音声入力に' },
    { id: 'other', label: 'その他アプリ', hint: 'Zoom・ゲームなど別アプリへ送る' },
    { id: 'listen', label: 'とりあえず聴きたい', hint: 'スピーカー/ヘッドホンで確認' },
];

const isVirtualCableName = (name: string) =>
    /virtual|vb-|voicemeeter|cable/i.test(name);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const monitorLevels = async (durationMs: number, pick: 'input' | 'output') => {
    let peak = 0;
    const unlisten = await listen<{ input: number[]; output: number[] }>('audio-level', (event) => {
        const levels = pick === 'input' ? event.payload.input : event.payload.output;
        const p = Math.max(levels[0] ?? 0, levels[1] ?? 0);
        if (p > peak) peak = p;
    });
    await sleep(durationMs);
    unlisten();
    return peak;
};

const receiverChecklists = (receiver: string): Record<Purpose, string[]> => ({
    discord: [
        `Discord 設定 → 音声とビデオ → 入力デバイスに「${receiver}」を選択`,
        '「ノイズ抑制（Krisp / Standard）」は ON・OFF を一つずつ切り替え、声の欠けと雑音を試聴して比較',
        '自動入力感度・入力音量も一つずつ比較し、普段の声が途切れない設定を選ぶ',
        'エコー除去を変更する場合は、スピーカーからの回り込みが増えないか確認',
        '通話中でないことを確認してから診断のテストトーンを実行する',
    ],
    obs: [
        'OBS のソースに「音声入力キャプチャ」を追加',
        `デバイスに「${receiver}」を選択`,
        'OBS の音声ミキサーで該当ソースがミュートになっていないか確認',
        '「詳細音声プロパティ」でモニタリングが無効になっていないか確認',
    ],
    other: [
        `受け側アプリのマイク/入力デバイスに「${receiver}」を選択`,
        'アプリ内のノイズ抑制・自動ゲインを一つずつ ON・OFF で比較し、声と雑音を試聴して選ぶ',
        'エコー除去を変更する場合は、スピーカーからの回り込みが増えないか確認',
        'Windows のプライバシー設定でマイクアクセスが許可されているか確認',
    ],
    listen: [
        'Auralyn の出力先をスピーカー/ヘッドホンに設定',
        'Windows の音量ミキサーで Auralyn がミュートでないか確認',
        '仮想ケーブルではなく物理出力を選ぶと耳で確認しやすい',
    ],
});

export const TroubleshootModal: React.FC<TroubleshootModalProps> = ({
    isOpen,
    onClose,
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
}) => {
    const [phase, setPhase] = useState<WizardPhase>('purpose');
    const [purpose, setPurpose] = useState<Purpose | null>(null);
    const [checks, setChecks] = useState<DiagnosticItem[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [showProbeConfirm, setShowProbeConfirm] = useState(false);
    const [copyDone, setCopyDone] = useState(false);
    const routingRef = useRef<RoutingDiagnosticsReport | null>(null);
    const abortRef = useRef(false);
    const probeConfirmRef = useRef<((ok: boolean) => void) | null>(null);

    const askProbeConfirm = () =>
        new Promise<boolean>(resolve => {
            probeConfirmRef.current = resolve;
            setShowProbeConfirm(true);
        });

    const updateCheck = useCallback((id: string, update: Partial<DiagnosticItem>) => {
        setChecks(prev => prev.map(c => (c.id === id ? { ...c, ...update } : c)));
    }, []);

    const openSettingsAction = useCallback(() => {
        onClose();
        onOpenSettings();
    }, [onClose, onOpenSettings]);

    const buildInitialChecks = (): DiagnosticItem[] => [
        { id: 'd1', label: 'D1 マイク入力', description: 'マイクに向かって話したとき入力レベルが上がるか', status: 'pending' },
        { id: 'd2', label: 'D2 エンジン出力', description: '処理後の出力レベルまたはテストトーンが出るか', status: 'pending' },
        { id: 'd3', label: 'D3 出力先の種類', description: '仮想ケーブルか物理出力か', status: 'pending' },
        { id: 'd4', label: 'D4 仮想ケーブル到達', description: '選択した出力と対になる入力へテストトーンが届くか', status: 'pending' },
        { id: 'd5', label: 'D5 サンプルレート', description: 'エンジンと仮想ケーブルのレート一致', status: 'pending' },
        { id: 'd6', label: 'D6 受け側アプリ設定', description: 'Discord/OBS 等の入力デバイス確認リスト', status: 'pending' },
        { id: 'd7', label: 'D7 既定通信デバイス', description: 'Windows の「通信」既定が仮想ケーブルになっていないか', status: 'pending' },
    ];

    const runDiagnostics = useCallback(async (selectedPurpose: Purpose) => {
        abortRef.current = false;
        setIsRunning(true);
        setPhase('running');
        setChecks(buildInitialChecks());

        const expectsVirtual = selectedPurpose === 'discord' || selectedPurpose === 'obs' || selectedPurpose === 'other';

        const stopBeforeMeasurement = (detail: string) => {
            updateCheck('d1', {
                status: 'error', detail,
                fixHint: 'オーディオ設定でマイクと出力先を選び、音声を開始してください',
                action: { label: '設定を開く', onClick: openSettingsAction },
            });
            ['d2', 'd3', 'd4', 'd5', 'd6', 'd7'].forEach(id =>
                updateCheck(id, { status: 'skipped', detail: '音声の開始を確認できないため、未確認です' })
            );
            setPhase('results');
            setIsRunning(false);
        };

        // エンジン起動確認
        let state;
        try {
            state = await audioApi.getAudioState();
        } catch {
            stopBeforeMeasurement('音声の状態を取得できませんでした');
            return;
        }

        // 常駐プロセスの存在だけでは、音声設定やストリームの開始を確認できない。
        if (!state?.is_running || !state.config?.host) {
            stopBeforeMeasurement(state?.config?.host ? '音声処理が停止中です' : '音声設定がまだ完了していません');
            return;
        }
        try {
            const stream = await audioApi.getAudioStreamState();
            if (!stream.running || stream.streamFailed) {
                stopBeforeMeasurement('音声処理が停止中です');
                return;
            }
        } catch {
            stopBeforeMeasurement('音声処理の稼働状態を確認できませんでした');
            return;
        }

        const outputName = state.config?.output ?? '';
        const hostName = state.config?.host ?? '';

        // D1: マイク入力
        updateCheck('d1', { status: 'checking', detail: 'マイクに向かって話してください（約3秒）...' });
        const inputPeak1 = await monitorLevels(3000, 'input');
        if (abortRef.current) return;

        if (inputPeak1 > 0.005) {
            updateCheck('d1', { status: 'ok', detail: `入力レベルを検出しました（ピーク ${(inputPeak1 * 100).toFixed(1)}%）` });
        } else {
            updateCheck('d1', {
                status: 'warning',
                detail: '入力が無音です。もう一度話してください...',
            });
            const inputPeak2 = await monitorLevels(3000, 'input');
            if (inputPeak2 > 0.005) {
                updateCheck('d1', { status: 'ok', detail: `入力レベルを検出しました（ピーク ${(inputPeak2 * 100).toFixed(1)}%）` });
            } else {
                updateCheck('d1', {
                    status: 'error',
                    detail: 'マイク入力が検出されませんでした',
                    fixHint: 'Windows のマイク権限・ミュート・別アプリ占有を確認してください',
                    action: { label: '設定を開く', onClick: openSettingsAction },
                });
            }
        }

        // D2: エンジン出力（テストトーン）
        // 通話・配信に乗る可能性があるため、トーン再生前に必ず確認を取る
        const toneConfirmed = await askProbeConfirm();
        if (abortRef.current) return;
        if (!toneConfirmed) {
            updateCheck('d2', {
                status: 'skipped',
                detail: 'テストトーンをスキップしました',
                fixHint: '通話中でないタイミングで再実行すると出力を実測確認できます',
            });
        } else {
        updateCheck('d2', { status: 'checking', detail: 'テストトーンを再生しています...' });
        try {
            await audioApi.playTestTone(1000, 1200, -20);
            const outPeak = await monitorLevels(1500, 'output');
            await audioApi.stopTestTone();
            if (abortRef.current) return;
            if (outPeak > 0.001) {
                updateCheck('d2', { status: 'ok', detail: `出力レベルを検出しました（ピーク ${(outPeak * 100).toFixed(1)}%）` });
            } else {
                updateCheck('d2', {
                    status: 'error',
                    detail: '出力が検出されませんでした',
                    fixHint: '出力デバイス設定とミュート状態を確認してください',
                    action: { label: '設定を開く', onClick: openSettingsAction },
                });
            }
        } catch {
            updateCheck('d2', { status: 'error', detail: 'テストトーンの再生に失敗しました', fixHint: 'エンジン再起動をお試しください' });
        }
        }

        if (abortRef.current) return;

        // D3: 出力先分類
        updateCheck('d3', { status: 'checking' });
        if (!outputName) {
            updateCheck('d3', {
                status: 'error',
                detail: '出力デバイスが未設定です',
                fixHint: '音声設定で出力先を選んでください',
                action: { label: '設定を開く', onClick: openSettingsAction },
            });
        } else {
            const virtual = isVirtualCableName(outputName);
            if (virtual) {
                updateCheck('d3', { status: 'ok', detail: `出力: ${outputName}（仮想ケーブル ✓）` });
            } else if (expectsVirtual) {
                updateCheck('d3', {
                    status: 'warning',
                    detail: `出力: ${outputName}（物理出力）。配信/通話用途では仮想ケーブル推奨`,
                    fixHint: '出力先を CABLE Input 等の仮想ケーブルに変更してください',
                    action: { label: '設定を開く', onClick: openSettingsAction },
                });
            } else {
                updateCheck('d3', { status: 'ok', detail: `出力: ${outputName}（ローカル試聴向け）` });
            }
        }

        // ルーティング診断取得（D5/D7 用）
        let routing: RoutingDiagnosticsReport | null = null;
        try {
            routing = await audioApi.getRoutingDiagnostics();
            routingRef.current = routing;
        } catch {
            routingRef.current = null;
        }

        // D4: ループバックプローブ
        updateCheck('d4', { status: 'checking' });
        const devices = await audioApi.getDevices(false).catch(() => null);
        const cableOutput = devices ? findCableReceiver(outputName, hostName, devices.inputs) : undefined;
        const receiver = cableOutput ? deviceDisplayName(cableOutput.name) : receiverDeviceHint(outputName);
        const manualHint = `手動確認: 受け側アプリで「${receiver}」を確認し、メーターと試聴で音の到達を確認してください`;
        const outputIsVirtual = isVirtualCableName(outputName);

        if (hostName.toUpperCase() === 'ASIO') {
            updateCheck('d4', {
                status: 'skipped',
                detail: 'ASIO 使用時のため自動プローブをスキップ',
                fixHint: manualHint,
            });
        } else if (!outputIsVirtual || !cableOutput) {
            updateCheck('d4', {
                status: 'skipped',
                detail: outputIsVirtual
                    ? '選択した出力と対になる入力を一意に特定できませんでした。自動確認は未実施です'
                    : '仮想ケーブル出力が選択されていないためスキップ',
                fixHint: manualHint,
            });
        } else {
            // D2 の時点でテストトーン再生に同意済みなら再確認しない
            const confirmed = toneConfirmed || (await askProbeConfirm());
            if (abortRef.current) return;
            if (!confirmed) {
                updateCheck('d4', { status: 'skipped', detail: 'ループバックプローブをスキップしました' });
            } else {
                updateCheck('d4', { status: 'checking', detail: '仮想ケーブル経由の到達を確認中...' });
                let probe: LoopbackProbeResult | null = null;
                try {
                    probe = await audioApi.probeLoopback(cableOutput.name, 1500, 1000);
                } catch {
                    probe = null;
                }
                if (abortRef.current) return;
                if (probe?.unavailable) {
                    updateCheck('d4', {
                        status: 'warning',
                        detail: probe.unavailable,
                        fixHint: manualHint,
                    });
                } else if (probe?.detected) {
                    updateCheck('d4', {
                        status: 'ok',
                        detail: `${receiver} でテストトーンを検出（${probe.levelDb.toFixed(1)} dBFS 付近）`,
                    });
                } else {
                    updateCheck('d4', {
                        status: 'error',
                        detail: `${receiver} でテストトーンを検出できませんでした`,
                        fixHint: `Auralyn の出力「${deviceDisplayName(outputName)}」と入力「${receiver}」の対応、ミュート状態を確認してください`,
                        action: { label: '設定を開く', onClick: openSettingsAction },
                    });
                }
            }
        }

        // D5: サンプルレート
        updateCheck('d5', { status: 'checking' });
        if (routing && routing.sampleRateMismatches.length > 0) {
            const m = routing.sampleRateMismatches[0];
            updateCheck('d5', {
                status: 'error',
                detail: m.message,
                fixHint: 'Windows のサウンド設定で仮想ケーブルとエンジンを同じレート（推奨 48000Hz）に統一',
                action: { label: '設定を開く', onClick: openSettingsAction },
            });
        } else if (routing?.engineSampleRateHz && routing.devices.some(device =>
            device.isVirtualCable && device.mixFormatSampleRateHz !== null
        )) {
            updateCheck('d5', {
                status: 'ok',
                detail: `取得できた仮想ケーブルのレートに不一致はありません（エンジン ${routing.engineSampleRateHz}Hz）`,
            });
        } else {
            updateCheck('d5', { status: 'warning', detail: '比較に必要なサンプルレート情報を取得できませんでした' });
        }

        // D6: 受け側チェックリスト
        updateCheck('d6', {
            status: 'skipped',
            detail: receiverChecklists(receiver)[selectedPurpose].map((line, i) => `${i + 1}. ${line}`).join('\n'),
            fixHint: selectedPurpose === 'discord' && onOpenDiscordGuide
                ? 'Discord ガイドも参照してください'
                : selectedPurpose === 'obs'
                    ? 'OBS ガイドも参照してください'
                    : undefined,
            action: selectedPurpose === 'discord' && onOpenDiscordGuide
                ? { label: 'Discord ガイド', onClick: () => { onClose(); onOpenDiscordGuide(); } }
                : selectedPurpose === 'obs'
                    ? { label: 'OBS ガイド', onClick: () => { onClose(); onOpenOBSGuide(); } }
                    : undefined,
        });

        // D7: 既定通信デバイス
        updateCheck('d7', { status: 'checking' });
        if (routing?.defaultCommsRenderIsVirtual) {
            updateCheck('d7', {
                status: 'warning',
                detail: `既定の通信デバイス（再生）が「${routing.defaultCommsRenderName ?? '仮想ケーブル'}」です。自分の耳には届きません`,
                fixHint: 'Windows サウンド設定 → 通信タブで、スピーカー/ヘッドホンを通信デバイスに設定',
            });
        } else if (routing?.defaultCommsRenderName) {
            updateCheck('d7', { status: 'ok', detail: '既定通信デバイスに問題は見つかりませんでした' });
        } else {
            updateCheck('d7', { status: 'warning', detail: '既定通信デバイスを確認できませんでした' });
        }

        setPhase('results');
        setIsRunning(false);
    }, [onClose, onOpenDiscordGuide, onOpenOBSGuide, openSettingsAction, updateCheck]);

    const handleStart = (p: Purpose) => {
        setPurpose(p);
        localStorage.setItem('vst_host_setup_goal', p === 'listen' ? 'local' : p);
        void runDiagnostics(p);
    };

    const handleCopyReport = async () => {
        let version = 'unknown';
        try {
            version = await getVersion();
        } catch { /* ignore */ }

        const lines: string[] = [
            '=== Auralyn 接続診断レポート ===',
            `アプリバージョン: ${version}`,
            `用途: ${purpose ?? '未選択'}`,
            `診断日時: ${new Date().toISOString()}`,
            '',
        ];

        if (routingRef.current) {
            lines.push('--- Windows デバイス ---');
            for (const d of routingRef.current.devices) {
                lines.push(
                    `[${d.direction}] ${d.name} | ${d.mixFormatSampleRateHz ?? '?'}Hz` +
                    `${d.isDefault ? ' (既定)' : ''}` +
                    `${d.isDefaultCommunications ? ' (通信既定)' : ''}` +
                    `${d.isVirtualCable ? ' [仮想ケーブル]' : ''}`,
                );
            }
            lines.push('');
        }

        lines.push('--- 診断結果 ---');
        for (const c of checks) {
            const icon = c.status === 'ok' ? '✅' : c.status === 'warning' ? '⚠️' : c.status === 'error' ? '❌' : c.status === 'skipped' ? '⏭' : '…';
            lines.push(`${icon} ${c.label}: ${c.detail ?? c.description}`);
            if (c.fixHint) lines.push(`   直し方: ${c.fixHint}`);
        }

        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            setCopyDone(true);
            setTimeout(() => setCopyDone(false), 2000);
        } catch {
            /* ignore */
        }
    };

    useEffect(() => {
        if (!isOpen) {
            abortRef.current = true;
            setPhase('purpose');
            setPurpose(null);
            setChecks([]);
            setIsRunning(false);
            setShowProbeConfirm(false);
        }
        // 条件レンダリングによるアンマウント時も診断を確実に中断し、トーンを停止する
        return () => {
            abortRef.current = true;
            probeConfirmRef.current?.(false);
            probeConfirmRef.current = null;
            audioApi.stopTestTone().catch(() => {});
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const statusIcon = (status: CheckStatus) => {
        switch (status) {
            case 'ok': return <MdCheckCircle className="w-5 h-5 text-emerald-500" />;
            case 'error': return <MdError className="w-5 h-5 text-destructive" />;
            case 'warning': return <MdWarning className="w-5 h-5 text-amber-500" />;
            case 'skipped': return <MdWarning className="w-5 h-5 text-muted-foreground" />;
            case 'checking': return <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />;
            default: return <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30" />;
        }
    };

    const errorCount = checks.filter(c => c.status === 'error').length;
    const warnCount = checks.filter(c => c.status === 'warning').length;

    return (
        <Modal title="接続診断ウィザード" onClose={onClose}>
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-lg max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
                <div className="modal-header-base shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-amber-500/10 rounded-lg">
                            <MdHelpOutline className="w-5 h-5 text-amber-500" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">接続診断ウィザード</h2>
                            <p className="text-xs text-muted-foreground">音声の状態と接続先を、確認できる範囲で調べます</p>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label="閉じる" className="p-2 rounded-lg hover:bg-muted text-muted-foreground">
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                {showProbeConfirm && (
                    <div className="px-6 py-4 bg-amber-500/10 border-b border-amber-500/20 text-sm space-y-3">
                        <p className="font-bold text-amber-700 dark:text-amber-300">
                            テストトーンを再生します
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            通話や配信に乗らないよう確認してください。テストトーンは −20dBFS 程度の短い音です。
                        </p>
                        <div className="flex gap-2">
                            <button
                                className="px-3 py-1.5 text-xs font-bold bg-primary text-primary-foreground rounded-md"
                                onClick={() => {
                                    setShowProbeConfirm(false);
                                    probeConfirmRef.current?.(true);
                                    probeConfirmRef.current = null;
                                }}
                            >
                                続行
                            </button>
                            <button
                                className="px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted rounded-md"
                                onClick={() => {
                                    setShowProbeConfirm(false);
                                    probeConfirmRef.current?.(false);
                                    probeConfirmRef.current = null;
                                }}
                            >
                                スキップ
                            </button>
                        </div>
                    </div>
                )}

                {phase === 'purpose' && (
                    <div className="p-6 space-y-3 overflow-y-auto">
                        <p className="text-sm text-muted-foreground mb-2">まず用途を選んでください。用途に合わせた項目をチェックします。</p>
                        {PURPOSE_OPTIONS.map(opt => (
                            <button
                                key={opt.id}
                                onClick={() => handleStart(opt.id)}
                                disabled={isRunning}
                                className="w-full text-left p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 transition-colors"
                            >
                                <div className="font-bold text-sm text-foreground">{opt.label}</div>
                                <div className="text-xs text-muted-foreground mt-1">{opt.hint}</div>
                            </button>
                        ))}
                    </div>
                )}

                {phase !== 'purpose' && !isRunning && checks.length > 0 && (
                    <div className={`px-6 py-3 text-sm font-bold flex items-center gap-2 shrink-0 ${
                        errorCount > 0 ? 'bg-destructive/10 text-destructive' :
                        warnCount > 0 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}>
                        {errorCount > 0 ? (
                            <><MdError className="w-4 h-4" /> {errorCount}件の問題が見つかりました</>
                        ) : warnCount > 0 ? (
                            <><MdWarning className="w-4 h-4" /> {warnCount}件の注意点があります</>
                        ) : (
                            <><MdCheckCircle className="w-4 h-4" /> 確認できた項目に問題はありませんでした</>
                        )}
                    </div>
                )}

                {phase !== 'purpose' && (
                    <div className="p-6 space-y-4 overflow-y-auto flex-1">
                        {checks.map(check => (
                            <div key={check.id} className="flex items-start gap-4">
                                <div className="mt-0.5 shrink-0">{statusIcon(check.status)}</div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-bold text-sm text-foreground">{check.label}</h3>
                                    <p className="text-[10px] text-muted-foreground">{check.description}</p>
                                    {check.detail && (
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed whitespace-pre-line">{check.detail}</p>
                                    )}
                                    {check.fixHint && (
                                        <p className="text-xs text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                                            直し方: {check.fixHint}
                                        </p>
                                    )}
                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {check.action && (
                                            <button
                                                onClick={check.action.onClick}
                                                className="px-3 py-1 text-xs font-bold text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors"
                                            >
                                                {check.action.label}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-muted/30 shrink-0">
                    <div className="flex items-center gap-2">
                        {phase !== 'purpose' && (
                            <button
                                onClick={() => { setPhase('purpose'); setChecks([]); }}
                                disabled={isRunning}
                                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                                <MdArrowBack className="w-4 h-4" /> 用途を変更
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {phase === 'results' && (
                            <button
                                onClick={() => void handleCopyReport()}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted rounded-md"
                            >
                                <MdContentCopy className="w-4 h-4" />
                                {copyDone ? 'コピーしました' : '診断結果をコピー'}
                            </button>
                        )}
                        {purpose && (
                            <button
                                onClick={() => void runDiagnostics(purpose)}
                                disabled={isRunning}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50"
                            >
                                <MdRefresh className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
                                再チェック
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};
