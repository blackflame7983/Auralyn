import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef } from 'react';
import { MdShield, MdExpandMore, MdMic, MdMusicNote } from 'react-icons/md';
import { cn } from '@/lib/utils';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

// 本番中に使う歌・雑談の切替と本番保護。未登録の間は登録欄への入口だけを出す。
// 未登録の間は起動時・設定を閉じたとき・前面への復帰時に状態を読み、定期確認はしない。
// embedded は本番帯の中に置くとき。枠と余白を本番帯に任せる。
export function LiveModeBar({ model, refreshKey, embedded = false, onRegister, onPrepareSinging, safetyOnly = false }: { model: LiveModesModel; refreshKey?: unknown; embedded?: boolean; onRegister?: () => void; onPrepareSinging?: () => void; safetyOnly?: boolean }) {
    const t = useMessages();
    const { snapshot: value, busy, error, refresh, activate } = model;
    const registered = Boolean(value?.definitions.singing || value?.definitions.talk);
    const actionsRef = useRef<HTMLElement>(null);
    const actionsDetails = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        // 親の状態管理が初期化されてから読む。StrictModeの再マウントで最初の応答だけが失効するのを避ける。
        const frame = requestAnimationFrame(() => { void refresh(); });
        return () => cancelAnimationFrame(frame);
    }, [refresh, refreshKey]);
    useEffect(() => {
        if (registered) return;
        // 背景で起動して最初の取得を見送った場合も、前面に戻ったときに入口を表示できるようにする。
        const visible = () => { if (!isAppHidden()) void refresh(false); };
        addAppVisibilityListener(visible);
        return () => removeAppVisibilityListener(visible);
    }, [registered, refresh]);
    useEffect(() => (registered || value?.transaction ? activate() : undefined), [registered, Boolean(value?.transaction), activate]);
    if (!value) return error ? <section aria-label={t('liveBar.label')} className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-ui-support text-warning">{error}</p>
        <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-md border border-border px-3 py-1.5 text-ui-support">{t('settings.LiveModeControls.236')}</button>
    </section> : null;
    if (safetyOnly && !value.armed && !value.transaction && !error && !value.error) return null;
    if (!registered && !onRegister && !value.transaction && !value.armed && !error && !value.error) return null;

    const name = (mode: 'singing' | 'talk') => mode === 'singing' ? t('settings.LiveModeControls.212') : t('settings.LiveModeControls.213');
    const applied = value.phase === 'settled' ? value.applied : null;
    const pending = value.phase === 'queued' || value.phase === 'transitioning';
    const selected = applied ?? (value.phase === 'custom' || value.phase === 'settled' ? 'custom' : null);
    // メニュー項目は閉じると消えるため、設定から戻る復帰先には常設の文字付きボタンを使う。
    const openFromMenu = (action: () => void) => {
        if (actionsDetails.current) actionsDetails.current.open = false;
        actionsRef.current?.focus({ preventScroll: true });
        action();
    };
    return (
        <section aria-label={t('liveBar.label')} data-mode-registered={registered} className={cn('flex flex-wrap items-center gap-3', !embedded && 'mb-3 rounded-xl border border-border bg-card gaming:bg-card/70 px-3 py-2')}>
            {registered && !safetyOnly && <SegmentedControl label={t('liveBar.mode')} value={selected}
                onValueChange={mode => { if (mode !== 'custom') void model.select(mode); }}
                options={[
                    { value: 'singing' as const, label: <><MdMusicNote aria-hidden="true" className="h-4 w-4" />{t('liveBar.singing')}</>, disabled: busy || model.changesBlocked || !value.definitions.singing },
                    { value: 'talk' as const, label: <><MdMic aria-hidden="true" className="h-4 w-4" />{t('liveBar.talk')}</>, disabled: busy || model.changesBlocked || !value.definitions.talk },
                    { value: 'custom' as const, label: t('liveBar.custom'), readOnly: true, hint: t('liveBar.customHint') },
                ]} />}
            {value.transaction && <div className="basis-full space-y-2" role="status">
                <p>{t(value.transaction.phase === 'recovery_required' || value.transaction.phase === 'failed' ? 'liveTransaction.failed' : value.transaction.phase === 'restoring' ? 'liveTransaction.recovering' : 'liveTransaction.switching')}</p>
                {value.transaction.error && <p className="break-words text-ui-support">{value.transaction.error}</p>}
                {value.transaction.recoveryAvailable && <button type="button" disabled={model.recoveryBusy || busy} onClick={() => void model.recover()} className="rounded-md border border-border px-3 py-1.5 text-ui-support">{t('liveTransaction.recover')}</button>}
            </div>}
            {registered && !safetyOnly && (pending || value.phase === 'partial' || !embedded && (!value.running || value.phase === 'stopped')) && <span role="status" className="text-ui-support text-muted-foreground">
                {pending ? t('liveBar.switching', { mode: value.target ? name(value.target) : '' })
                    : value.phase === 'partial' ? t('liveOutput.partial')
                    : !value.running || value.phase === 'stopped' ? t('liveBar.stopped')
                    : ''}
            </span>}
            {(registered || value.armed) && (!safetyOnly || value.armed) && <button type="button" disabled={busy || model.changesBlocked} aria-pressed={value.armed} aria-label={t('liveBar.protect')} aria-describedby="live-protect-state" onClick={() => void model.protect(!value.armed)}
                title={t(value.armed ? 'liveBar.unlockHint' : 'liveBar.protectHint')}
                className={cn('inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-ui-support font-medium transition-colors disabled:opacity-50', !embedded && 'ml-auto',
                    value.armed ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted-foreground hover:text-foreground')}>
                <MdShield aria-hidden="true" className="h-4 w-4" />
                {t('liveBar.protect')}
                <span id="live-protect-state" className="font-semibold">{t(value.armed ? 'liveBar.protectOn' : 'liveBar.protectOff')}</span>
            </button>}
            {/* 登録後も同じボタンを保ち、設定を閉じたときのフォーカス復帰先を失わない。 */}
            {!safetyOnly && (onRegister || onPrepareSinging) && <details ref={actionsDetails} className="group min-w-0 max-w-full" onKeyDown={event => {
                if (event.key === 'Escape' && actionsDetails.current?.open) {
                    event.preventDefault(); event.stopPropagation();
                    actionsDetails.current.open = false; actionsRef.current?.focus({ preventScroll: true });
                }
            }}>
                <summary ref={actionsRef} role="button" className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-2 text-ui-support text-muted-foreground hover:bg-muted hover:text-foreground">{t('liveBar.actions')}<MdExpandMore aria-hidden="true" className="h-4 w-4 group-open:rotate-180" /></summary>
                <div role="group" aria-label={t('liveBar.actions')} className="mt-1 flex max-w-full flex-wrap gap-2 rounded-md bg-background p-2">
                    {onRegister && <button type="button" onClick={() => openFromMenu(onRegister)} className="rounded-md px-3 py-2 text-ui-control hover:bg-muted">{t(registered ? 'liveBar.editRegistration' : 'liveBar.register')}</button>}
                    {onPrepareSinging && <button type="button" onClick={() => openFromMenu(onPrepareSinging)} className="rounded-md px-3 py-2 text-ui-control hover:bg-muted">{t('home.singingSetup')}</button>}
                </div>
            </details>}
            {(error || value.error) && <div className="basis-full space-y-2"><p role="alert" className="text-ui-support text-destructive-text">{error || t('liveNotices.operationFailed')}</p>
                <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-md border border-border px-3 py-1.5 text-ui-support">{t('settings.LiveModeControls.236')}</button>
            </div>}
        </section>
    );
}
