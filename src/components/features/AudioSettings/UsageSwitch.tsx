import { useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useMessages } from '@/i18n/LocaleProvider';
import { publishDisplayPurpose } from '@/hooks/useAlignInputPurpose';
import { useReturnFocusWhenReady } from '@/hooks/useFocusRequest';
import type { DisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { InputPurpose } from '@/lib/inputSource';
import { readUsageDevices, type UsageDeviceRecord } from '@/lib/usageDevices';
import { setupGoalForUsage, UsageSwitchError, type UsageSetupGoal } from '@/lib/usageSwitch';

function routeOf(record: UsageDeviceRecord) {
    const input = record.inputSource.kind === 'process_loopback' ? record.inputSource.config.appName : record.input || record.inputId || '';
    return { input, output: record.output };
}

export function UsageSwitch({ display, inputPurpose, running, locked, blockedReason, onApply, onApplied, onOpenSetup }: {
    display: DisplayPurpose;
    inputPurpose: InputPurpose;
    running: boolean;
    locked: boolean;
    /** 操作ロック以外で、いまは切り替えられない理由。押せない間、ボタンの近くに出す。 */
    blockedReason?: string;
    onApply: (record: UsageDeviceRecord) => Promise<void>;
    /** 切り替えが済み、確認の小窓を閉じたあとに呼ぶ。次に焦点を移す先があるときに使う。 */
    onApplied?: (record: UsageDeviceRecord) => void;
    onOpenSetup: (goal: UsageSetupGoal) => void;
}) {
    const t = useMessages();
    const opener = useRef<HTMLButtonElement>(null);
    const lockId = useId();
    const blockedId = useId();
    const descriptionId = useId();
    const [pending, setPending] = useState<UsageDeviceRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ reason: string; restored: boolean } | null>(null);
    const target: DisplayPurpose = display === 'voice' ? 'music' : 'voice';
    const name = t(display === 'music' ? 'purpose.music' : 'purpose.voice');
    const detail = t(display === 'music' ? 'purpose.musicDetail' : 'purpose.voiceDetail');
    const unavailable = locked || busy || !!blockedReason;
    // 確定後は選択の読み直しでボタンが一時的に押せなくなる。押せるようになってから、焦点がどこにも無いときだけ戻す。
    const [refocus, setRefocus] = useState(false);
    // 小窓が閉じて焦点が戻ったあとに、次の案内へ渡す。
    const afterClose = useRef<(() => void) | null>(null);
    useReturnFocusWhenReady(opener, refocus, !unavailable, () => setRefocus(false));
    const returnToOpener = () => queueMicrotask(() => opener.current?.focus());
    const open = () => {
        if (unavailable) return;
        const record = readUsageDevices()[target];
        if (!record) {
            onOpenSetup(setupGoalForUsage(target));
            return;
        }
        setError(null);
        setPending(record);
    };
    const close = () => {
        if (busy) return;
        setPending(null);
        setError(null);
        returnToOpener();
    };
    const confirm = async () => {
        if (!pending || busy) return;
        setBusy(true);
        setError(null);
        try {
            await onApply(pending);
            setPending(null);
            if (onApplied && pending.inputSource.kind === 'process_loopback') afterClose.current = () => onApplied(pending);
            else setRefocus(true);
        } catch (cause) {
            setError({ reason: cause instanceof Error ? cause.message : String(cause), restored: !(cause instanceof UsageSwitchError) || cause.restored });
        } finally {
            setBusy(false);
        }
    };
    const route = pending ? routeOf(pending) : null;
    const appAudio = pending?.inputSource.kind === 'process_loopback';
    const targetName = t(target === 'music' ? 'purpose.music' : 'purpose.voice');
    return <div className="space-y-2">
        {display !== inputPurpose && <div className="flex flex-wrap items-center gap-2">
            <p>{t('purpose.mismatch')}</p>
            <Button type="button" variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => publishDisplayPurpose(display)}>{t('purpose.align')}</Button>
        </div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 text-ui-control">{t('purpose.current', { name, detail })}</p>
            <Button ref={opener} type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={unavailable}
                aria-describedby={locked ? lockId : blockedReason ? blockedId : undefined} onClick={open}>{t('purpose.switch')}</Button>
        </div>
        {locked && <p id={lockId} className="text-ui-support text-muted-foreground">{t('peak.liveLocked')}</p>}
        {!locked && blockedReason && <p id={blockedId} className="text-ui-support text-muted-foreground">{blockedReason}</p>}
        {pending && route && <Modal title={t('purpose.switchTitle')} titleInContent role="alertdialog" descriptionId={descriptionId} onClose={close} dismissible={!busy}
            onClosed={() => { const next = afterClose.current; afterClose.current = null; next?.(); }}>
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90">
                <div className="modal-surface-base w-full max-w-md space-y-4 p-6">
                    <Dialog.Title asChild>
                        <h3 className="text-ui-heading font-bold leading-tight">{t('purpose.switchTitle')}</h3>
                    </Dialog.Title>
                    <div id={descriptionId} className="space-y-2 text-ui-support text-muted-foreground">
                        <p>{t('purpose.switchHome', { name: targetName })}</p>
                        <p>{t(target === 'music' ? 'purpose.switchVoiceOff' : 'purpose.switchVoiceOn')}</p>
                        {appAudio
                            ? <p>{t('purpose.switchApp', { app: route.input, name: targetName })}</p>
                            : <p>{t('purpose.switchDevices', { input: route.input, output: route.output, name: targetName })}</p>}
                        {running && !appAudio && <p>{t('purpose.switchRestart')}</p>}
                        {error && <p role="alert" className="text-destructive-text">{t(error.restored ? 'purpose.switchError' : 'purpose.switchRestoreFailed', { reason: error.reason })}</p>}
                    </div>
                    <div className="flex justify-end gap-3">
                        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
                        <Button type="button" size="sm" disabled={busy} onClick={() => void confirm()}>{t('purpose.switch')}</Button>
                    </div>
                </div>
            </div>
        </Modal>}
    </div>;
}
