import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { message as formatMessage, type MessageKey } from '@/i18n/messages';
import { useLocale } from '@/i18n/LocaleProvider';
import { useMessages } from '@/i18n/LocaleProvider';
import { Modal } from '../../ui/modal';
import { deviceDisplayName, findCableReceiver, receiverDeviceNotice } from '../../../lib/audioRouting';
import { checkRouteSampleRatesDisplay } from '../../../lib/routingSampleRates';
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
    label: SettingsNotice;
    description: SettingsNotice;
    status: CheckStatus;
    detail?: SettingsNotice;
    lines?: SettingsNotice[];
    fixHint?: SettingsNotice;
    action?: { label: SettingsNotice; onClick: () => void };
}

const PURPOSE_OPTIONS: { id: Purpose; label: MessageKey; hint: MessageKey }[] = [
    { id: 'discord', label: 'guide.copy.301', hint: 'guide.copy.302' },
    { id: 'obs', label: 'guide.copy.303', hint: 'guide.copy.304' },
    { id: 'other', label: 'guide.copy.305', hint: 'guide.copy.306' },
    { id: 'listen', label: 'guide.copy.307', hint: 'guide.copy.308' },
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

const receiverChecklists = (receiver: SettingsNotice): Record<Purpose, SettingsNotice[]> => ({
    discord: [
        notice('guide.copy.309', { arg0: receiver }),
        notice('guide.copy.310'),
        notice('guide.copy.311'),
        notice('guide.copy.312'),
        notice('guide.copy.313'),
    ],
    obs: [
        notice('guide.copy.314'),
        notice('guide.copy.315', { arg0: receiver }),
        notice('guide.copy.316'),
        notice('guide.copy.317'),
    ],
    other: [
        notice('guide.copy.318', { arg0: receiver }),
        notice('guide.copy.319'),
        notice('guide.copy.320'),
        notice('guide.copy.321'),
    ],
    listen: [
        notice('guide.copy.322'),
        notice('guide.copy.323'),
        notice('guide.copy.324'),
    ],
});

export const TroubleshootModal: React.FC<TroubleshootModalProps> = ({
    isOpen,
    onClose,
    onOpenSettings,
    onOpenOBSGuide,
    onOpenDiscordGuide,
}) => {
    const t = useMessages();
    const { locale } = useLocale();
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
        { id: 'd1', label: notice('guide.copy.325'), description: notice('guide.copy.326'), status: 'pending' },
        { id: 'd2', label: notice('guide.copy.327'), description: notice('guide.copy.328'), status: 'pending' },
        { id: 'd3', label: notice('guide.copy.329'), description: notice('guide.copy.330'), status: 'pending' },
        { id: 'd4', label: notice('guide.copy.331'), description: notice('guide.copy.332'), status: 'pending' },
        { id: 'd5', label: notice('guide.copy.333'), description: notice('guide.copy.334'), status: 'pending' },
        { id: 'd6', label: notice('guide.copy.335'), description: notice('guide.copy.336'), status: 'pending' },
        { id: 'd7', label: notice('guide.copy.337'), description: notice('guide.copy.338'), status: 'pending' },
    ];

    const runDiagnostics = useCallback(async (selectedPurpose: Purpose) => {
        abortRef.current = false;
        setIsRunning(true);
        setPhase('running');
        setChecks(buildInitialChecks());

        const expectsVirtual = selectedPurpose === 'discord' || selectedPurpose === 'obs' || selectedPurpose === 'other';

        const stopBeforeMeasurement = (detail: SettingsNotice) => {
            updateCheck('d1', {
                status: 'error', detail,
                fixHint: notice('guide.copy.339'),
                action: { label: notice('guide.copy.340'), onClick: openSettingsAction },
            });
            ['d2', 'd3', 'd4', 'd5', 'd6', 'd7'].forEach(id =>
                updateCheck(id, { status: 'skipped', detail: notice('guide.copy.341') })
            );
            setPhase('results');
            setIsRunning(false);
        };

        // エンジン起動確認
        let state;
        try {
            state = await audioApi.getAudioState();
        } catch {
            stopBeforeMeasurement(notice('guide.copy.342'));
            return;
        }

        // 常駐プロセスの存在だけでは、音声設定やストリームの開始を確認できない。
        if (!state?.is_running || !state.config?.host) {
            stopBeforeMeasurement(state?.config?.host ? notice('guide.copy.343') : notice('guide.copy.344'));
            return;
        }
        try {
            const stream = await audioApi.getAudioStreamState();
            if (!stream.running || stream.streamFailed) {
                stopBeforeMeasurement(notice('guide.copy.345'));
                return;
            }
        } catch {
            stopBeforeMeasurement(notice('guide.copy.346'));
            return;
        }

        const outputName = state.config?.output ?? '';
        const hostName = state.config?.host ?? '';

        // D1: マイク入力
        updateCheck('d1', { status: 'checking', detail: notice('guide.copy.347') });
        const inputPeak1 = await monitorLevels(3000, 'input');
        if (abortRef.current) return;

        if (inputPeak1 > 0.005) {
            updateCheck('d1', { status: 'ok', detail: notice('guide.copy.348', { arg0: (inputPeak1 * 100).toFixed(1) }) });
        } else {
            updateCheck('d1', {
                status: 'warning',
                detail: notice('guide.copy.349'),
            });
            const inputPeak2 = await monitorLevels(3000, 'input');
            if (inputPeak2 > 0.005) {
                updateCheck('d1', { status: 'ok', detail: notice('guide.copy.350', { arg0: (inputPeak2 * 100).toFixed(1) }) });
            } else {
                updateCheck('d1', {
                    status: 'error',
                    detail: notice('guide.copy.351'),
                    fixHint: notice('guide.copy.352'),
                    action: { label: notice('guide.copy.353'), onClick: openSettingsAction },
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
                detail: notice('guide.copy.354'),
                fixHint: notice('guide.copy.355'),
            });
        } else {
        updateCheck('d2', { status: 'checking', detail: notice('guide.copy.356') });
        try {
            await audioApi.playTestTone(1000, 1200, -20);
            const outPeak = await monitorLevels(1500, 'output');
            await audioApi.stopTestTone();
            if (abortRef.current) return;
            if (outPeak > 0.001) {
                updateCheck('d2', { status: 'ok', detail: notice('guide.copy.357', { arg0: (outPeak * 100).toFixed(1) }) });
            } else {
                updateCheck('d2', {
                    status: 'error',
                    detail: notice('guide.copy.358'),
                    fixHint: notice('guide.copy.359'),
                    action: { label: notice('guide.copy.360'), onClick: openSettingsAction },
                });
            }
        } catch {
            updateCheck('d2', { status: 'error', detail: notice('guide.copy.361'), fixHint: notice('guide.copy.362') });
        }
        }

        if (abortRef.current) return;

        // D3: 出力先分類
        updateCheck('d3', { status: 'checking' });
        if (!outputName) {
            updateCheck('d3', {
                status: 'error',
                detail: notice('guide.copy.363'),
                fixHint: notice('guide.copy.364'),
                action: { label: notice('guide.copy.365'), onClick: openSettingsAction },
            });
        } else {
            const virtual = isVirtualCableName(outputName);
            if (virtual) {
                updateCheck('d3', { status: 'ok', detail: notice('guide.copy.366', { arg0: outputName }) });
            } else if (expectsVirtual) {
                updateCheck('d3', {
                    status: 'warning',
                    detail: notice('guide.copy.367', { arg0: outputName }),
                    fixHint: notice('guide.copy.368'),
                    action: { label: notice('guide.copy.369'), onClick: openSettingsAction },
                });
            } else {
                updateCheck('d3', { status: 'ok', detail: notice('guide.copy.370', { arg0: outputName }) });
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
        const receiver = cableOutput ? deviceDisplayName(cableOutput.name) : receiverDeviceNotice(outputName);
        const manualHint = notice('guide.copy.371', { arg0: receiver });
        const outputIsVirtual = isVirtualCableName(outputName);

        if (hostName.toUpperCase() === 'ASIO') {
            updateCheck('d4', {
                status: 'skipped',
                detail: notice('guide.copy.372'),
                fixHint: manualHint,
            });
        } else if (!outputIsVirtual || !cableOutput) {
            updateCheck('d4', {
                status: 'skipped',
                detail: outputIsVirtual
                    ? notice('guide.copy.373')
                    : notice('guide.copy.374'),
                fixHint: manualHint,
            });
        } else {
            // D2 の時点でテストトーン再生に同意済みなら再確認しない
            const confirmed = toneConfirmed || (await askProbeConfirm());
            if (abortRef.current) return;
            if (!confirmed) {
                updateCheck('d4', { status: 'skipped', detail: notice('guide.copy.375') });
            } else {
                updateCheck('d4', { status: 'checking', detail: notice('guide.copy.376') });
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
                        detail: notice('guide.copy.377', { arg0: receiver, arg1: probe.levelDb.toFixed(1) }),
                    });
                } else {
                    updateCheck('d4', {
                        status: 'error',
                        detail: notice('guide.copy.378', { arg0: receiver }),
                        fixHint: notice('guide.copy.379', { arg0: deviceDisplayName(outputName), arg1: receiver }),
                        action: { label: notice('guide.copy.380'), onClick: openSettingsAction },
                    });
                }
            }
        }

        // D5: サンプルレート
        updateCheck('d5', checkRouteSampleRatesDisplay(hostName, outputName, routing));

        // D6: 受け側チェックリスト
        updateCheck('d6', {
            status: 'skipped',
            lines: receiverChecklists(receiver)[selectedPurpose],
            fixHint: selectedPurpose === 'discord' && onOpenDiscordGuide
                ? notice('guide.copy.381')
                : selectedPurpose === 'obs'
                    ? notice('guide.copy.382')
                    : undefined,
            action: selectedPurpose === 'discord' && onOpenDiscordGuide
                ? { label: notice('guide.copy.383'), onClick: () => { onClose(); onOpenDiscordGuide(); } }
                : selectedPurpose === 'obs'
                    ? { label: notice('guide.copy.384'), onClick: () => { onClose(); onOpenOBSGuide(); } }
                    : undefined,
        });

        // D7: 既定通信デバイス
        updateCheck('d7', { status: 'checking' });
        if (routing?.defaultCommsRenderIsVirtual) {
            updateCheck('d7', {
                status: 'warning',
                detail: notice('guide.copy.385', { arg0: routing.defaultCommsRenderName ?? notice('guide.copy.386') }),
                fixHint: notice('guide.copy.387'),
            });
        } else if (routing?.defaultCommsRenderName) {
            updateCheck('d7', { status: 'ok', detail: notice('guide.copy.388') });
        } else {
            updateCheck('d7', { status: 'warning', detail: notice('guide.copy.389') });
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
        // Copy uses the language selected at the explicit click, including after awaits.
        const reportT: typeof t = (key, args) => formatMessage(locale, key, args);
        const reportChecks = checks;
        const reportRouting = routingRef.current;
        const reportPurpose = purpose;
        let version = 'unknown';
        try {
            version = await getVersion();
        } catch { /* ignore */ }

        const lines: string[] = [
            reportT('guide.copy.390'),
            reportT('guide.copy.391', { arg0: version }),
            reportT('guide.copy.392', { arg0: reportPurpose ? reportT(PURPOSE_OPTIONS.find(option => option.id === reportPurpose)!.label) : reportT('guide.copy.393') }),
            reportT('guide.copy.394', { arg0: new Date().toISOString() }),
            '',
        ];

        if (reportRouting) {
            lines.push(reportT('guide.copy.395'));
            for (const d of reportRouting.devices) {
                lines.push(
                    `[${d.direction}] ${d.name} | ${d.mixFormatSampleRateHz ?? '?'}Hz` +
                    reportT('guide.copy.396', { arg0: d.isDefault ? reportT('guide.copy.397') : '' }) +
                    reportT('guide.copy.398', { arg0: d.isDefaultCommunications ? reportT('guide.copy.399') : '' }) +
                    reportT('guide.copy.400', { arg0: d.isVirtualCable ? reportT('guide.copy.401') : '' }),
                );
            }
            lines.push('');
        }

        lines.push(reportT('guide.copy.402'));
        for (const c of reportChecks) {
            const icon = c.status === 'ok' ? '✅' : c.status === 'warning' ? '⚠️' : c.status === 'error' ? '❌' : c.status === 'skipped' ? '⏭' : '…';
            lines.push(`${icon} ${renderNotice(reportT, c.label)}: ${c.lines ? c.lines.map((line, i) => `${i + 1}. ${renderNotice(reportT, line)}`).join('\n') : typeof c.detail === 'string' ? `${reportT('guide.rawDetail')}: ${c.detail}` : renderNotice(reportT, c.detail ?? c.description)}`);
            if (c.fixHint) lines.push(reportT('guide.copy.403', { arg0: renderNotice(reportT, c.fixHint) }));
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
        <Modal title={t('guide.copy.404')} onClose={onClose}>
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-lg max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
                <div className="modal-header-base shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-amber-500/10 rounded-lg">
                            <MdHelpOutline className="w-5 h-5 text-amber-500" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-foreground">{t('guide.copy.405')}</h2>
                            <p className="text-xs text-muted-foreground">{t('guide.copy.406')}</p>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label={t('guide.copy.407')} className="p-2 rounded-lg hover:bg-muted text-muted-foreground">
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                {showProbeConfirm && (
                    <div className="px-6 py-4 bg-amber-500/10 border-b border-amber-500/20 text-sm space-y-3">
                        <p className="font-bold text-amber-700 dark:text-amber-300">
                            {t('guide.copy.408')}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            {t('guide.copy.409')}</p>
                        <div className="flex gap-2">
                            <button
                                className="px-3 py-1.5 text-xs font-bold bg-primary text-primary-foreground rounded-md"
                                onClick={() => {
                                    setShowProbeConfirm(false);
                                    probeConfirmRef.current?.(true);
                                    probeConfirmRef.current = null;
                                }}
                            >
                                {t('guide.copy.410')}</button>
                            <button
                                className="px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted rounded-md"
                                onClick={() => {
                                    setShowProbeConfirm(false);
                                    probeConfirmRef.current?.(false);
                                    probeConfirmRef.current = null;
                                }}
                            >
                                {t('guide.copy.411')}</button>
                        </div>
                    </div>
                )}

                {phase === 'purpose' && (
                    <div className="p-6 space-y-3 overflow-y-auto">
                        <p className="text-sm text-muted-foreground mb-2">{t('guide.copy.412')}</p>
                        {PURPOSE_OPTIONS.map(opt => (
                            <button
                                key={opt.id}
                                onClick={() => handleStart(opt.id)}
                                disabled={isRunning}
                                className="w-full text-left p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 transition-colors"
                            >
                                <div className="font-bold text-sm text-foreground">{t(opt.label)}</div>
                                <div className="text-xs text-muted-foreground mt-1">{t(opt.hint)}</div>
                            </button>
                        ))}
                    </div>
                )}

                {phase !== 'purpose' && !isRunning && checks.length > 0 && (
                    <div className={`px-6 py-3 text-sm font-bold flex items-center gap-2 shrink-0 ${
                        errorCount > 0 ? 'bg-destructive/10 text-red-800 dark:text-red-300' :
                        warnCount > 0 ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}>
                        {errorCount > 0 ? (
                            <><MdError className="w-4 h-4" /> {errorCount}{t('guide.copy.413')}</>
                        ) : warnCount > 0 ? (
                            <><MdWarning className="w-4 h-4" /> {warnCount}{t('guide.copy.414')}</>
                        ) : (
                            <><MdCheckCircle className="w-4 h-4" /> {t('guide.copy.415')}</>
                        )}
                    </div>
                )}

                {phase !== 'purpose' && (
                    <div className="p-6 space-y-4 overflow-y-auto flex-1">
                        {checks.map(check => (
                            <div key={check.id} className="flex items-start gap-4">
                                <div className="mt-0.5 shrink-0">{statusIcon(check.status)}</div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-bold text-sm text-foreground">{renderNotice(t, check.label)}</h3>
                                    <p className="text-[10px] text-muted-foreground">{renderNotice(t, check.description)}</p>
                                    {check.lines && <p className="text-xs text-muted-foreground mt-1 leading-relaxed whitespace-pre-line">{check.lines.map((line, i) => `${i + 1}. ${renderNotice(t, line)}`).join('\n')}</p>}
                                    {check.detail && (
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed whitespace-pre-line">{typeof check.detail === 'string' ? <>{t('guide.rawDetail')}: {check.detail}</> : renderNotice(t, check.detail)}</p>
                                    )}
                                    {check.fixHint && (
                                        <p className="text-xs text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                                            {t('guide.diagnostic.fixHint', { hint: renderNotice(t, check.fixHint) })}
                                        </p>
                                    )}
                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {check.action && (
                                            <button
                                                onClick={check.action.onClick}
                                                className="px-3 py-1 text-xs font-bold text-primary bg-primary/10 border border-primary/20 rounded-md hover:bg-primary/20 transition-colors"
                                            >
                                                {renderNotice(t, check.action.label)}
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
                                <MdArrowBack className="w-4 h-4" /> {t('guide.copy.417')}</button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {phase === 'results' && (
                            <button
                                onClick={() => void handleCopyReport()}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted rounded-md"
                            >
                                <MdContentCopy className="w-4 h-4" />
                                {copyDone ? t('guide.copy.418') : t('guide.copy.419')}
                            </button>
                        )}
                        {purpose && (
                            <button
                                onClick={() => void runDiagnostics(purpose)}
                                disabled={isRunning}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50"
                            >
                                <MdRefresh className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
                                {t('guide.copy.420')}</button>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};
