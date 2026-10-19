import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
    confirmOutputGain,
    gainCommand,
    type GainRequest,
    type GainSnapshot,
} from '@/api/outputGain';
import { toast } from 'sonner';

const button = 'rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50';
const pct = (gain: number) => `${(gain * 100).toFixed(1)}%`;

export function AutoGainDialog({ onClose }: { onClose: () => void }) {
    const [state, setState] = useState<GainSnapshot | null>(null);
    const [target, setTarget] = useState(-20);
    const [devices, setDevices] = useState<GainSnapshot['devices']>([]);
    const [device, setDevice] = useState('');
    const [safeOutput, setSafeOutput] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [closedForVisibility, setClosedForVisibility] = useState(false);
    const epoch = useRef(0);
    const alive = useRef(true);
    const inFlight = useRef(false);
    const mutating = useRef(false);
    const closing = useRef(false);

    useEffect(() => {
        alive.current = true;
        let stopped = false;
        const poll = async () => {
            if (inFlight.current || stopped) return;
            inFlight.current = true;
            const version = epoch.current;
            try {
                const next = await gainCommand({ action: 'status' });
                if (!stopped && version === epoch.current) setState(next);
            } catch (e) {
                if (!stopped && version === epoch.current) {
                    setState(null);
                    setError(String(e));
                }
            } finally {
                inFlight.current = false;
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 250);
        const hide = () => {
            if (!document.hidden) return;
            ++epoch.current;
            setClosedForVisibility(true);
            void gainCommand({ action: 'cancel' })
                .then((next) => {
                    if (!stopped) setState(next);
                })
                .catch((e) => {
                    if (!stopped) setError(String(e));
                });
        };
        document.addEventListener('visibilitychange', hide);
        return () => {
            stopped = true;
            alive.current = false;
            ++epoch.current;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', hide);
            void gainCommand({ action: 'cancel' }).catch(() => {
                toast.error(
                    '録音・試聴の停止を確認できません。音量調整を開いて中止を再試行してください。',
                );
            });
        };
    }, []);

    const run = async (request: GainRequest) => {
        if (mutating.current || closing.current) return;
        mutating.current = true;
        const version = ++epoch.current;
        setBusy(true);
        setError(null);
        setClosedForVisibility(false);
        try {
            let next = await gainCommand(request);
            if (request.action === 'apply' || request.action === 'restore')
                next = await confirmOutputGain(next);
            if (alive.current && version === epoch.current) {
                setState(next);
                if (request.action === 'devices') setDevices(next.devices);
            }
        } catch (e) {
            if (alive.current && version === epoch.current) {
                setError(String(e));
                setState(null);
            }
        } finally {
            mutating.current = false;
            if (alive.current && !closing.current) setBusy(false);
        }
    };
    const close = async () => {
        if (closing.current) return;
        closing.current = true;
        ++epoch.current;
        setBusy(true);
        try {
            const next = await gainCommand({ action: 'cancel' });
            if (next.running && !next.settled) await confirmOutputGain(next);
            if (alive.current) onClose();
        } catch (e) {
            if (alive.current)
                setError(`停止を確認できません。閉じる操作を再試行してください。${String(e)}`);
        } finally {
            closing.current = false;
            if (alive.current) setBusy(false);
        }
    };
    const proposal = state?.proposal;
    const recording = state?.phase === 'recording';
    const pending = state?.phase === 'applying' || state?.phase === 'restoring';
    const canPreview = !!proposal && ['ready', 'applied', 'restored'].includes(state?.phase ?? '');

    return (
        <Dialog.Root
            open
            onOpenChange={(open) => {
                if (!open) void close();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[150] bg-black/70" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-[151] flex max-h-[90vh] w-[min(38rem,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background text-foreground shadow-xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                        <Dialog.Title className="font-semibold">
                            音量を合わせる・聞き比べ
                        </Dialog.Title>
                        <button className={button} onClick={() => void close()}>
                            閉じる
                        </button>
                    </div>
                    <div className="space-y-4 overflow-y-auto p-4">
                        <Dialog.Description className="text-sm text-muted-foreground">
                            普段の声を10秒録音し、固定の出力音量を提案します。録音はメモリ内だけで扱います。
                            VSTの加工前後ではなく、音量調整の前後を比べます。
                        </Dialog.Description>
                        <label className="flex flex-wrap items-center gap-2 text-sm">
                            声用の目標（仮の目安）
                            <select
                                aria-label="自動調整の目標"
                                value={target}
                                disabled={busy || recording || pending || !!proposal}
                                onChange={(e) => setTarget(Number(e.target.value))}
                                className="rounded border border-input bg-background p-2"
                            >
                                {[-26, -23, -20, -17, -14].map((v) => (
                                    <option key={v} value={v}>
                                        {v} LUFS
                                    </option>
                                ))}
                            </select>
                        </label>
                        <p className="text-xs text-muted-foreground">
                            サービス公式基準ではありません。声と背景音を識別せず、後の大声による音割れは防げません。
                            配信前に、普段の声で3秒以上話してください。ミュートや出力0%は解除してから録音してください。
                        </p>
                        <p role="status" className="text-sm text-amber-500">
                            {recording
                                ? `録音中 ${Math.round((state?.progress ?? 0) * 10)} / 10秒`
                                : pending
                                  ? '音量の反映を確認しています'
                                  : state?.phase === 'applied'
                                    ? '提案した音量を適用しました'
                                    : state?.phase === 'restored'
                                      ? '調整前の音量に戻しました'
                                      : closedForVisibility
                                        ? '画面を離れたため中止しました。録り直してください'
                                        : !state
                                          ? '状態を確認してください'
                                          : '目標を選び、録音してください'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <button
                                className={button}
                                disabled={
                                    busy ||
                                    pending ||
                                    recording ||
                                    !state?.running ||
                                    !state.settled
                                }
                                onClick={() =>
                                    void run({ action: 'begin', target, revision: state!.revision })
                                }
                            >
                                {proposal ? '録り直す' : '録音して提案する'}
                            </button>
                            <button
                                className={button}
                                disabled={busy || (!recording && !state?.playing)}
                                onClick={() => void run({ action: 'cancel' })}
                            >
                                録音・試聴を中止
                            </button>
                            <button
                                className={button}
                                disabled={busy}
                                onClick={() => void run({ action: 'status' })}
                            >
                                状態を再取得
                            </button>
                        </div>
                        {(error || state?.error) && (
                            <p role="alert" className="text-sm text-amber-500">
                                {error ?? state?.error}
                            </p>
                        )}
                        {proposal && (
                            <div className="space-y-3 rounded border border-border p-3">
                                <p className="font-semibold">
                                    出力音量 {pct(proposal.before)} → {pct(proposal.after)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    測定 {proposal.measured.toFixed(1)} → 推定{' '}
                                    {proposal.predicted.toFixed(1)} LUFS ／ 調整後のtrue peak推定{' '}
                                    {proposal.peak.toFixed(1)} dBTP
                                </p>
                                {proposal.limited && (
                                    <p className="text-sm text-amber-500">
                                        ピーク・増幅量・出力上限を守るため、目標まで上げていません。
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        className={button}
                                        disabled={
                                            busy ||
                                            pending ||
                                            state?.phase !== 'ready' ||
                                            !state.settled
                                        }
                                        onClick={() =>
                                            void run({
                                                action: 'apply',
                                                id: state!.id,
                                                revision: state!.revision,
                                            })
                                        }
                                    >
                                        この音量を使う
                                    </button>
                                    <button
                                        className={button}
                                        disabled={
                                            busy ||
                                            pending ||
                                            state?.phase !== 'applied' ||
                                            !state.settled
                                        }
                                        onClick={() =>
                                            void run({
                                                action: 'restore',
                                                id: state!.id,
                                                revision: state!.revision,
                                            })
                                        }
                                    >
                                        元に戻す
                                    </button>
                                </div>
                            </div>
                        )}
                        {canPreview && (
                            <div className="space-y-3 rounded border border-border p-3">
                                <p className="text-sm font-semibold">同じ録音で聞き比べる</p>
                                <p className="text-xs text-muted-foreground">
                                    通常出力とは別のヘッドホン等を選んでください。OBSがそのデバイスを取得していると試聴音も流れます。
                                    通常のマイク送出は続きます。再生音量に注意してください。
                                </p>
                                <button
                                    className={button}
                                    disabled={busy}
                                    onClick={() => void run({ action: 'devices' })}
                                >
                                    試聴先を取得・更新
                                </button>
                                <select
                                    aria-label="聞き比べの試聴先"
                                    value={device}
                                    disabled={busy || state?.playing}
                                    onChange={(e) => {
                                        setDevice(e.target.value);
                                        setSafeOutput(false);
                                    }}
                                    className="w-full rounded border border-input bg-background p-2 text-sm"
                                >
                                    <option value="">試聴先を選択</option>
                                    {devices.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                        </option>
                                    ))}
                                </select>
                                <label className="flex gap-2 text-xs">
                                    <input
                                        type="checkbox"
                                        checked={safeOutput}
                                        onChange={(e) => setSafeOutput(e.target.checked)}
                                    />
                                    選んだ出力がOBS・通話アプリへ取り込まれないことを確認しました
                                </label>
                                <div className="flex flex-wrap gap-2">
                                    {[false, true].map((after) => (
                                        <button
                                            key={String(after)}
                                            className={button}
                                            disabled={busy || pending || !device || !safeOutput}
                                            onClick={() =>
                                                void run({
                                                    action: 'preview',
                                                    id: state!.id,
                                                    after,
                                                    device,
                                                })
                                            }
                                        >
                                            {after ? '調整後を聴く' : '調整前を聴く'}
                                        </button>
                                    ))}
                                    <button
                                        className={button}
                                        disabled={busy || !state?.playing}
                                        onClick={() => void run({ action: 'stop_preview' })}
                                    >
                                        試聴を止める
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
