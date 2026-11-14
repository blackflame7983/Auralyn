import { Modal } from '@/components/ui/modal';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/button';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
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
            if (!isAppHidden()) return;
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
        addAppVisibilityListener(hide);
        return () => {
            stopped = true;
            alive.current = false;
            ++epoch.current;
            clearInterval(timer);
            removeAppVisibilityListener(hide);
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
        <Modal title={t('autoGain.title')} titleInContent onClose={() => void close()} descriptionId="auto-gain-description">
            <div className="modal-overlay-base z-[150]" onClick={event => { if (event.target === event.currentTarget) void close(); }}>
                <div className="modal-surface-base flex max-h-[calc(90vh/var(--ui-zoom))] w-[min(38rem,calc(95vw/var(--ui-zoom)))] flex-col">
                    <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                        <Dialog.Title className="font-semibold">
                            {t('autoGain.title')}</Dialog.Title>
                        <Button variant="outline"  onClick={() => void close()}>
                            {t('common.close')}</Button>
                    </div>
                    <div className="space-y-4 overflow-y-auto p-4">
                        <Dialog.Description id="auto-gain-description" className="text-ui-support text-muted-foreground">
                            {t('autoGain.purpose')}</Dialog.Description>
                        <label className="flex flex-wrap items-center gap-2 text-ui-support">
                            {t('autoGain.targetLabel')}<Field label={null}><Select
                                aria-label={t('autoGain.targetLabel')}
                                value={target}
                                disabled={busy || recording || pending || !!proposal}
                                onChange={(e) => setTarget(Number(e.target.value))}

                            >
                                {[-26, -23, -20, -17, -14].map((v) => (
                                    <option key={v} value={v}>
                                        {v} LUFS
                                    </option>
                                ))}
                            </Select></Field>
                        </label>
                        <p className="text-ui-support text-muted-foreground">
                            {t('autoGain.limitations')}</p>
                        <p role="status" className="text-ui-support text-warning">
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
                            <Button variant="outline"

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
                            </Button>
                            <Button variant="outline"

                                disabled={busy || (!recording && !state?.playing)}
                                onClick={() => void run({ action: 'cancel' })}
                            >
                                {t('autoGain.cancelRecording')}</Button>
                            <Button variant="outline"

                                disabled={busy}
                                onClick={() => void run({ action: 'status' })}
                            >
                                {t('autoGain.refreshState')}</Button>
                        </div>
                        {(error || state?.error) && (
                            <div role="alert" className="text-ui-support text-warning">
                                <p>{error && typeof error !== 'string' && error.key !== 'clientErrors.rawDetail' ? renderNotice(t, error) : t('autoGain.stateFailed')}</p>
                                {translatedDetail && <p>{translatedDetail}</p>}
                                {rawError && <details><summary>{t('common.rawDetail')}</summary><p className="break-words">{rawError}</p></details>}
                            </div>
                        )}
                        {proposal && (
                            <div className="space-y-3 rounded-control border border-border p-3">
                                <p className="font-semibold">
                                    {t('autoGain.change', { before: pct(proposal.before), after: pct(proposal.after) })}
                                </p>
                                <details className="text-ui-support text-muted-foreground"><summary className="cursor-pointer">{t('structure.measurements')}</summary><p className="text-ui-support text-muted-foreground">
                                    {t('autoGain.estimate', { measured: proposal.measured.toFixed(1), predicted: proposal.predicted.toFixed(1), peak: proposal.peak.toFixed(1) })}
                                </p></details>
                                {proposal.limited && (
                                    <p className="text-ui-support text-warning">
                                        {t('autoGain.limitedGain')}</p>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <Button variant="outline"

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
                                        {t('autoGain.apply')}</Button>
                                    {state?.historyId == null && <Button variant="outline"

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
                                        {t('autoGain.undo')}</Button>}
                                </div>
                            </div>
                        )}
                        {state?.historyId != null && <div className="flex flex-wrap gap-2">
                            <Button variant="outline" type="button"  disabled={busy || !state.undoAvailable || !state.historyEpoch} onClick={() => void run({action: 'undo_history', id: state.historyId!, revision: state.revision, epoch: state.historyEpoch!})}>{t('history.undo')}</Button>
                            <Button variant="outline" type="button"  disabled={busy || !state.redoAvailable || !state.historyEpoch} onClick={() => void run({action: 'redo_history', id: state.historyId!, revision: state.revision, epoch: state.historyEpoch!})}>{t('history.redo')}</Button>
                        </div>}
                        {canPreview && (
                            <div className="space-y-3 rounded-control border border-border p-3">
                                <p className="text-ui-support font-semibold">{t('autoGain.compareTitle')}</p>
                                <p className="text-ui-support text-muted-foreground">
                                    {t('autoGain.previewSafety')}</p>
                                <Button variant="outline"

                                    disabled={busy}
                                    onClick={() => void run({ action: 'devices' })}
                                >
                                    {t('autoGain.refreshOutputs')}</Button>
                                <Field label={null}><Select
                                    aria-label={t('autoGain.previewOutput')}
                                    value={device}
                                    disabled={busy || state?.playing}
                                    onChange={(e) => {
                                        setDevice(e.target.value);
                                        setSafeOutput(false);
                                    }}
                                    className="w-full"
                                >
                                    <option value="">{t('autoGain.chooseOutput')}</option>
                                    {devices.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                        </option>
                                    ))}
                                </Select></Field>
                                <label className="flex gap-2 text-ui-support">
                                    <Field label={null}><Checkbox
                                        type="checkbox"
                                        checked={safeOutput}
                                        onChange={(e) => setSafeOutput(e.target.checked)}
                                    /></Field>
                                    {t('autoGain.previewConfirmed')}</label>
                                <div className="flex flex-wrap gap-2">
                                    {[false, true].map((after) => (
                                        <Button variant="outline"
                                            key={String(after)}

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
                                        </Button>
                                    ))}
                                    <Button variant="outline"

                                        disabled={busy || !state?.playing}
                                        onClick={() => void run({ action: 'stop_preview' })}
                                    >
                                        {t('autoGain.stopPreview')}</Button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Modal>
    );
}
