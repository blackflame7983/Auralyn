import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../../api/audio';
import { AutoGainDialog } from './AutoGainDialog';
import {
    classifyLoudness,
    DEFAULT_TARGET,
    LoudnessReading,
    Verdict,
    verdictLabel,
} from './loudnessVerdict';

let nextMeasurement = Date.now();
// ライフサイクルによる停止と、新しい開始のIPC適用順をそろえる。
let measurementCommands = Promise.resolve();
function requestMeasurement(id: number | null) {
    const request = measurementCommands.then(() => audioApi.setLoudnessMeasurement(id));
    measurementCommands = request.catch(() => {});
    return request;
}

export function LoudnessCheck({
    running,
    stateKnown = true,
    enabled = true,
    onVoiceCheck,
}: {
    running: boolean;
    stateKnown?: boolean;
    enabled?: boolean;
    onVoiceCheck: () => void;
}) {
    const t = useMessages();
    const [autoGainOpen, setAutoGainOpen] = useState(false);
    const [visible, setVisible] = useState(() => !document.hidden);
    const available = enabled && visible;
    useEffect(() => { if (!available || !running) setAutoGainOpen(false); }, [available, running]);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const [active, setActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [target, setTarget] = useState(DEFAULT_TARGET);
    const [reading, setReading] = useState<LoudnessReading | null>(null);
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    const [error, setError] = useState<SettingsNotice>('');
    const [stale, setStale] = useState(false);
    const [stopUnconfirmed, setStopUnconfirmed] = useState(false);
    const id = useRef<number | null>(null);
    const generation = useRef(0);
    const pending = useRef(false);
    const suppressReading = useRef(false);
    const lastEvent = useRef(0);
    const current = useRef<Verdict | null>(null);
    const candidate = useRef<{ verdict: Verdict | null; since: number }>({
        verdict: null,
        since: 0,
    });
    const targetRef = useRef(target);
    targetRef.current = target;

    const clear = () => {
        current.current = null;
        candidate.current = { verdict: null, since: 0 };
        setReading(null);
        setVerdict(null);
        setStale(false);
    };
    const invalidate = () => {
        generation.current += 1;
        id.current = null;
        pending.current = false;
        suppressReading.current = false;
        setBusy(false);
        setActive(false);
        setStopUnconfirmed(false);
        setError('');
        clear();
    };
    useEffect(() => {
        let disposed = false;
        const subscriptions = [
            listen<LoudnessReading>('audio-loudness', ({ payload }) => {
                if (
                    disposed ||
                    suppressReading.current ||
                    id.current === null ||
                    payload.id !== id.current
                )
                    return;
                lastEvent.current = performance.now();
                setStale(false);
                setReading(payload);
                const next = classifyLoudness(payload, targetRef.current, current.current);
                const now = performance.now();
                if (next === null) {
                    current.current = null;
                    candidate.current = { verdict: null, since: now };
                    setVerdict(null);
                    return;
                }
                if (candidate.current.verdict !== next)
                    candidate.current = { verdict: next, since: now };
                // 過大ピークは即時、それ以外は同じ判定が800ms続いたときに切り替える。
                if (
                    (payload.true_peak_dbtp ?? -Infinity) > -1 ||
                    now - candidate.current.since >= 800
                ) {
                    current.current = next;
                    setVerdict(next);
                }
            }),
            ...['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error'].map(
                (event) =>
                    listen(event, () => {
                        if (disposed) return;
                        // 入力エラーは出力や測定の停止を保証しない。
                        const confirmStop =
                            event === 'audio-stream-error' &&
                            (id.current !== null || pending.current || suppressReading.current);
                        invalidate();
                        if (!confirmStop) {
                            // 停止・デバイス再起動後に古い測定を継続しない。
                            void requestMeasurement(null).catch(() => {});
                            return;
                        }
                        const operation = generation.current;
                        pending.current = true;
                        suppressReading.current = true;
                        setActive(true);
                        setBusy(true);
                        void requestMeasurement(null)
                            .then(() => {
                                if (generation.current !== operation) return;
                                suppressReading.current = false;
                                setActive(false);
                            })
                            .catch(() => {
                                if (generation.current !== operation) return;
                                setStopUnconfirmed(true);
                                setError(
                                    notice('meterBrowser.copy.037'),
                                );
                            })
                            .finally(() => {
                                if (generation.current !== operation) return;
                                pending.current = false;
                                setBusy(false);
                            });
                    }),
            ),
        ];
        return () => {
            disposed = true;
            generation.current += 1;
            id.current = null;
            for (const subscription of subscriptions)
                void subscription.then((unlisten) => unlisten()).catch(() => {});
            void requestMeasurement(null).catch(() => {});
        };
    }, []);

    useEffect(() => {
        if (available && running) return;
        clear();
        // 取得失敗もrunning=falseになる。停止済みとは扱わず、測定の停止応答を確認する。
        // 既に停止待機中・停止未確認の場合は、その処理と再試行の導線を維持する。
        if (suppressReading.current || (id.current === null && !pending.current))
            return;
        const operation = ++generation.current;
        pending.current = true;
        suppressReading.current = true;
        setActive(true);
        setBusy(true);
        setError('');
        void requestMeasurement(null)
            .then(() => {
                if (generation.current !== operation) return;
                id.current = null;
                suppressReading.current = false;
                setActive(false);
                setStopUnconfirmed(false);
            })
            .catch(() => {
                if (generation.current !== operation) return;
                setStopUnconfirmed(true);
                setError(notice('meterBrowser.copy.038'));
            })
            .finally(() => {
                if (generation.current !== operation) return;
                pending.current = false;
                setBusy(false);
            });
    }, [available, running]);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => {
            if (performance.now() - lastEvent.current > 1500) {
                current.current = null;
                candidate.current = { verdict: null, since: 0 };
                setVerdict(null);
                setReading(null);
                setStale(true);
            }
        }, 500);
        return () => clearInterval(timer);
    }, [active]);

    const toggle = async () => {
        if (pending.current) return;
        pending.current = true;
        const operation = ++generation.current;
        setBusy(true);
        setError('');
        clear();
        const next = active ? null : ++nextMeasurement;
        suppressReading.current = next === null;
        // 停止が失敗したときは、元の測定IDと停止再試行の導線を保持する。
        if (next !== null) id.current = next;
        lastEvent.current = performance.now();
        try {
            await requestMeasurement(next);
            // 起動・停止イベントが先に届いた場合の古い応答を採用しない。
            if (generation.current !== operation) return;
            id.current = next;
            setActive(next !== null);
            setStopUnconfirmed(false);
        } catch {
            if (generation.current !== operation) return;
            // 開始応答を失った場合も測定開始済みの可能性があるため、停止で確認する。
            suppressReading.current = true;
            setActive(true);
            setStopUnconfirmed(true);
            setError(notice('meterBrowser.copy.039'));
        } finally {
            if (generation.current === operation) {
                pending.current = false;
                setBusy(false);
            }
        }
    };
    const message = stopUnconfirmed
        ? t('meterBrowser.copy.040')
        : busy && active
          ? t('meterBrowser.copy.041')
          : !running
            ? stateKnown
              ? t('meterBrowser.copy.042')
              : t('meterBrowser.copy.043')
            : !available && !active
              ? t('meterBrowser.copy.044')
              : !active
                ? t('meterBrowser.copy.045')
                : stale
                  ? t('meterBrowser.copy.046')
                  : reading && !reading.supported
                    ? t('meterBrowser.copy.047')
                    : verdict
                      ? t(verdictLabel[verdict])
                      : reading?.silent
                        ? t('meterBrowser.copy.048')
                        : t('meterBrowser.copy.049');
    const good = verdict === 'good' && active && !stale;
    // アンマウントせず停止を確認し、停止失敗時の再試行だけは隠さない。
    if (!enabled && !active && !busy && !stopUnconfirmed) return null;

    return (
        <section
            aria-label={t('meterBrowser.copy.050')}
            className="mb-4 rounded-xl border border-border bg-card p-4 space-y-2"
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold">{t('meterBrowser.copy.051')}</h2>
                    <p
                        role="status"
                        className={`text-lg font-bold ${good ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'}`}
                    >
                        {message}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                <button
                    onClick={() => void toggle()}
                    disabled={busy || (!active && (!running || !available))}
                    className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
                >
                    {busy
                        ? t('meterBrowser.copy.052')
                        : stopUnconfirmed
                          ? t('meterBrowser.copy.053')
                          : active
                            ? t('meterBrowser.copy.054')
                            : t('meterBrowser.copy.055')}
                </button>
                <button className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
                    disabled={!running || !available || busy} onClick={() => setAutoGainOpen(true)}>{t('meterBrowser.copy.056')}</button>
                </div>
            </div>
            <p className="text-xs text-muted-foreground">
                {t('meterBrowser.copy.057')}</p>
            {autoGainOpen && available && running && <AutoGainDialog onClose={() => setAutoGainOpen(false)} />}
            {active && reading && (
                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('structure.measurements')}</summary><p className="text-xs text-muted-foreground font-mono">
                    {t('meterBrowser.loudness.reading', { lufs: reading.short_term_lufs?.toFixed(1) ?? '—', peak: reading.true_peak_dbtp?.toFixed(1) ?? '—' })}
                </p></details>
            )}
            {error && (
                <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
                    {renderNotice(t, error)}
                </p>
            )}
            <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('meterBrowser.copy.060')}</summary>
                <div className="mt-2 space-y-2">
                    <p>{t('meterBrowser.copy.061')}</p>
                    <label className="flex flex-wrap items-center gap-2">
                        {t('meterBrowser.copy.062')}<select
                            aria-label={t('meterBrowser.copy.063')}
                            value={target}
                            onChange={(e) => {
                                setTarget(Number(e.target.value));
                                clear();
                            }}
                            className="rounded border border-input bg-background p-1"
                        >
                            {[-26, -23, -20, -17, -14].map((v) => (
                                <option key={v} value={v}>
                                    {v} LUFS
                                </option>
                            ))}
                        </select>
                    </label>
                    <p>
                        {t('meterBrowser.copy.064')}</p>
                    <p>
                        {t('meterBrowser.copy.065')}</p>
                    <button className="underline underline-offset-2" onClick={onVoiceCheck}>
                        {t('meterBrowser.copy.066')}</button>
                </div>
            </details>
        </section>
    );
}
