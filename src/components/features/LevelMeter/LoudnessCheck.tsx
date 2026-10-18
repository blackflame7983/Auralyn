import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../../api/audio';
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
    enabled = true,
    onVoiceCheck,
}: {
    running: boolean;
    enabled?: boolean;
    onVoiceCheck: () => void;
}) {
    const [visible, setVisible] = useState(() => !document.hidden);
    const available = enabled && visible;
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
    const [error, setError] = useState('');
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
                                    '測定状態を確認できませんでした。停止を再試行してください。',
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
        if (!running) invalidate();
    }, [running]);
    useEffect(() => {
        if (available || (id.current === null && !pending.current && !suppressReading.current))
            return;
        const operation = ++generation.current;
        pending.current = true;
        suppressReading.current = true;
        setActive(true);
        setBusy(true);
        setError('');
        clear();
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
                setError('測定状態を確認できませんでした。停止を再試行してください。');
            })
            .finally(() => {
                if (generation.current !== operation) return;
                pending.current = false;
                setBusy(false);
            });
    }, [available]);
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
            setError('測定状態を確認できませんでした。停止を再試行してください。');
        } finally {
            if (generation.current === operation) {
                pending.current = false;
                setBusy(false);
            }
        }
    };
    const message = !running
        ? '音声は停止中です'
        : stopUnconfirmed
          ? '測定の停止を確認できません'
          : busy && active
            ? '測定を停止しています'
            : !available && !active
              ? '音量チェックは休止中です'
              : !active
                ? '測定は停止中です'
                : stale
                  ? '音声データを確認できません'
                  : reading && !reading.supported
                    ? 'このサンプルレートでは測定できません'
                    : verdict
                      ? verdictLabel[verdict]
                      : reading?.silent
                        ? '音が小さいか、無音です'
                        : '測定中です。普段の声で3秒以上話してください';
    const good = verdict === 'good' && active && !stale;
    return (
        <section
            aria-label="出力の音量チェック"
            className="mb-4 rounded-xl border border-border bg-card p-4 space-y-2"
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold">出力の音量チェック</h2>
                    <p
                        role="status"
                        className={`text-lg font-bold ${good ? 'text-emerald-500' : 'text-amber-500'}`}
                    >
                        {message}
                    </p>
                </div>
                <button
                    onClick={() => void toggle()}
                    disabled={!running || busy || (!available && !active)}
                    className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
                >
                    {busy
                        ? '切替中…'
                        : stopUnconfirmed
                          ? '停止を再試行'
                          : active
                            ? '測定を止める'
                            : '測定する'}
                </button>
            </div>
            <p className="text-xs text-muted-foreground">
                Auralynの最終出力だけの目安です。ゲーム音を含む配信全体は判定しません。テスト音・試聴音も測定に含みます。
            </p>
            {active && reading && (
                <p className="text-xs text-muted-foreground font-mono">
                    短時間（3秒） {reading.short_term_lufs?.toFixed(1) ?? '—'} LUFS ／ true peak推定{' '}
                    {reading.true_peak_dbtp?.toFixed(1) ?? '—'} dBTP
                </p>
            )}
            {error && (
                <p role="alert" className="text-sm text-amber-500">
                    {error}
                </p>
            )}
            <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">目安と測定について</summary>
                <div className="mt-2 space-y-2">
                    <label className="flex flex-wrap items-center gap-2">
                        声用の目標（仮の目安）
                        <select
                            aria-label="音量の目標"
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
                        初期値は−20 LUFS、目安の幅は±3
                        LUです。YouTubeなどの公式基準ではありません。true peak推定が−1
                        dBTPを超える場合は、3秒未満でも「大きすぎ」と表示します。それ以外は音がある区間が不足すると判定しません。
                    </p>
                    <p>
                        44.1〜192
                        kHz、ステレオ出力のK-weightingと4倍補間による参考値です。認証済みメーターではありません。自動で音量を変えません。
                    </p>
                    <button className="underline underline-offset-2" onClick={onVoiceCheck}>
                        ボイスチェックで聴いて確認する
                    </button>
                </div>
            </details>
        </section>
    );
}
