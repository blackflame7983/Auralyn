import { clientErrorNotice } from '@/lib/clientError';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
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
    const t = useMessages();
    const [state, setState] = useState<GainSnapshot | null>(null);
    const [target, setTarget] = useState(-20);
    const [devices, setDevices] = useState<GainSnapshot['devices']>([]);
    const [device, setDevice] = useState('');
    const [safeOutput, setSafeOutput] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<SettingsNotice | null>(null);
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
                    setError(clientErrorNotice(e));
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
                    if (!stopped) setError(clientErrorNotice(e));
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
                    t('autoGain.stopUnconfirmedNotice'),
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
            if (request.action === 'apply' || request.action === 'restore' || request.action === 'undo_history' || request.action === 'redo_history')
                next = await confirmOutputGain(next);
            if (alive.current && version === epoch.current) {
                setState(next);
                if (request.action === 'devices') setDevices(next.devices);
            }
        } catch (e) {
            if (alive.current && version === epoch.current) {
                setError(clientErrorNotice(e));
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
                setError(notice('autoGain.closeUnconfirmed', { arg0: clientErrorNotice(e) }));
        } finally {
            closing.current = false;
            if (alive.current) setBusy(false);
        }
    };
    const proposal = state?.proposal;
    const recording = state?.phase === 'recording';
    const pending = state?.phase === 'applying' || state?.phase === 'restoring';
    const canPreview = !!proposal && ['ready', 'applied', 'restored'].includes(state?.phase ?? '');
    const errorDetail = typeof error === 'object' ? error?.args?.arg0 : undefined;
    const rawNotice = typeof errorDetail === 'object' ? errorDetail : typeof error === 'object' ? error : undefined;
    const rawError = typeof error === 'string' ? error : rawNotice?.key === 'clientErrors.rawDetail' && typeof rawNotice.args?.detail === 'string' ? rawNotice.args.detail : state?.error;
    const translatedDetail = errorDetail && typeof errorDetail === 'object' && errorDetail.key !== 'clientErrors.rawDetail' ? renderNotice(t, errorDetail) : null;

    return (
        <Dialog.Root
            open
            onOpenChange={(open) => {
                if (!open) void close();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[150] bg-overlay/70" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-[151] flex max-h-[90vh] w-[min(38rem,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background text-foreground shadow-xl">
                    <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                        <Dialog.Title className="font-semibold">
                            {t('autoGain.title')}</Dialog.Title>
                        <button className={button} onClick={() => void close()}>
                            {t('common.close')}</button>
                    </div>
                    <div className="space-y-4 overflow-y-auto p-4">
                        <Dialog.Description className="text-sm text-muted-foreground">
                            {t('autoGain.purpose')}</Dialog.Description>
                        <label className="flex flex-wrap items-center gap-2 text-sm">
                            {t('autoGain.targetLabel')}<select
                                aria-label={t('autoGain.targetLabel')}
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
                            {t('autoGain.limitations')}</p>
                        <p role="status" className="text-sm text-warning">
                            {recording
                                ? t('autoGain.recordingProgress', { arg0: Math.round((state?.progress ?? 0) * 10) })
                                : pending
                                  ? t('autoGain.confirmingGain')
                                  : state?.phase === 'applied'
                                    ? t('autoGain.applied')
                                    : state?.phase === 'restored'
                                      ? t('autoGain.restored')
                                      : closedForVisibility
                                        ? t('autoGain.interrupted')
                                        : !state
                                          ? t('autoGain.checkState')
                                          : state.phase === 'ready' && proposal
                                            ? state.settled
                                                ? t('autoGain.readyHint')
                                                : t('autoGain.confirmingGain')
                                          : t('autoGain.recordHint')}
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
                                {proposal ? t('autoGain.recordAgain') : t('autoGain.record')}
                            </button>
                            <button
                                className={button}
                                disabled={busy || (!recording && !state?.playing)}
                                onClick={() => void run({ action: 'cancel' })}
                            >
                                {t('autoGain.cancelRecording')}</button>
                            <button
                                className={button}
                                disabled={busy}
                                onClick={() => void run({ action: 'status' })}
                            >
                                {t('autoGain.refreshState')}</button>
                        </div>
                        {(error || state?.error) && (
                            <div role="alert" className="text-sm text-warning">
                                <p>{error && typeof error !== 'string' && error.key !== 'clientErrors.rawDetail' ? renderNotice(t, error) : t('autoGain.stateFailed')}</p>
                                {translatedDetail && <p>{translatedDetail}</p>}
                                {rawError && <details><summary>{t('common.rawDetail')}</summary><p className="break-words">{rawError}</p></details>}
                            </div>
                        )}
                        {proposal && (
                            <div className="space-y-3 rounded border border-border p-3">
                                <p className="font-semibold">
                                    {t('autoGain.change', { before: pct(proposal.before), after: pct(proposal.after) })}
                                </p>
                                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('structure.measurements')}</summary><p className="text-xs text-muted-foreground">
                                    {t('autoGain.estimate', { measured: proposal.measured.toFixed(1), predicted: proposal.predicted.toFixed(1), peak: proposal.peak.toFixed(1) })}
                                </p></details>
                                {proposal.limited && (
                                    <p className="text-sm text-warning">
                                        {t('autoGain.limitedGain')}</p>
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
                                        {t('autoGain.apply')}</button>
                                    {state?.historyId == null && <button
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
                                        {t('autoGain.undo')}</button>}
                                </div>
                            </div>
                        )}
                        {state?.historyId != null && <div className="flex flex-wrap gap-2">
                            <button type="button" className={button} disabled={busy || !state.undoAvailable || !state.historyEpoch} onClick={() => void run({action: 'undo_history', id: state.historyId!, revision: state.revision, epoch: state.historyEpoch!})}>{t('history.undo')}</button>
                            <button type="button" className={button} disabled={busy || !state.redoAvailable || !state.historyEpoch} onClick={() => void run({action: 'redo_history', id: state.historyId!, revision: state.revision, epoch: state.historyEpoch!})}>{t('history.redo')}</button>
                        </div>}
                        {canPreview && (
                            <div className="space-y-3 rounded border border-border p-3">
                                <p className="text-sm font-semibold">{t('autoGain.compareTitle')}</p>
                                <p className="text-xs text-muted-foreground">
                                    {t('autoGain.previewSafety')}</p>
                                <button
                                    className={button}
                                    disabled={busy}
                                    onClick={() => void run({ action: 'devices' })}
                                >
                                    {t('autoGain.refreshOutputs')}</button>
                                <select
                                    aria-label={t('autoGain.previewOutput')}
                                    value={device}
                                    disabled={busy || state?.playing}
                                    onChange={(e) => {
                                        setDevice(e.target.value);
                                        setSafeOutput(false);
                                    }}
                                    className="w-full rounded border border-input bg-background p-2 text-sm"
                                >
                                    <option value="">{t('autoGain.chooseOutput')}</option>
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
                                    {t('autoGain.previewConfirmed')}</label>
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
                                            {after ? t('autoGain.listenAdjusted') : t('autoGain.listenOriginal')}
                                        </button>
                                    ))}
                                    <button
                                        className={button}
                                        disabled={busy || !state?.playing}
                                        onClick={() => void run({ action: 'stop_preview' })}
                                    >
                                        {t('autoGain.stopPreview')}</button>
                                </div>
                            </div>
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
