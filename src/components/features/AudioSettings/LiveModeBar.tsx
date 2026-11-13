import { Button } from '@/components/ui/button';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef } from 'react';
import { MdExpandMore, MdMic, MdMusicNote } from 'react-icons/md';
import { cn } from '@/lib/utils';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

// 切替の途中・失敗は「いまの状態」に残し、上の帯の切替から同じ id を aria-describedby で参照する。
function liveModeNoteIds(model: LiveModesModel, embedded: boolean, safetyOnly: boolean): string[] {
    const value = model.snapshot;
    if (!value) return model.error ? ['live-mode-error'] : [];
    const registered = Boolean(value.definitions.singing || value.definitions.talk);
    const pending = value.phase === 'queued' || value.phase === 'transitioning';
    const ids: string[] = [];
    if (value.transaction) ids.push('live-mode-transaction');
    if (registered && !safetyOnly && (pending || value.phase === 'partial' || !embedded && (!value.running || value.phase === 'stopped'))) ids.push('live-mode-phase');
    if (model.error || value.error) ids.push('live-mode-error');
    return ids;
}

// 歌／雑談の切替だけ。状態の説明は LiveModeBar に残す。
export function LiveModeSwitch({ model, embedded = true }: { model: LiveModesModel; embedded?: boolean }) {
    const t = useMessages();
    const value = model.snapshot;
    if (!value || !(value.definitions.singing || value.definitions.talk)) return null;
    const applied = value.phase === 'settled' ? value.applied : null;
    const selected = applied ?? (value.phase === 'custom' || value.phase === 'settled' ? 'custom' : null);
    const describedBy = liveModeNoteIds(model, embedded, false).join(' ') || undefined;
    return <SegmentedControl label={t('liveBar.mode')} describedBy={describedBy} value={selected}
        onValueChange={mode => { if (mode !== 'custom') void model.select(mode); }}
        options={[
            { value: 'singing' as const, label: <><MdMusicNote aria-hidden="true" className="h-4 w-4" />{t('liveBar.singing')}</>, disabled: model.busy || model.changesBlocked || !value.definitions.singing },
            { value: 'talk' as const, label: <><MdMic aria-hidden="true" className="h-4 w-4" />{t('liveBar.talk')}</>, disabled: model.busy || model.changesBlocked || !value.definitions.talk },
            { value: 'custom' as const, label: t('liveBar.custom'), readOnly: true, hint: t('liveBar.customHint') },
        ]} />;
}

// 本番中に使う歌・雑談の切替と本番保護。未登録の間は登録欄への入口だけを出す。
// 未登録の間は起動時・設定を閉じたとき・前面への復帰時に状態を読み、定期確認はしない。
// embedded は本番帯の中に置くとき。枠と余白を本番帯に任せる。
export function LiveModeBar({ model, refreshKey, embedded = false, onRegister, onPrepareSinging, safetyOnly = false, hideSwitch = false }: { model: LiveModesModel; refreshKey?: unknown; embedded?: boolean; onRegister?: () => void; onPrepareSinging?: () => void; safetyOnly?: boolean; hideSwitch?: boolean }) {
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
        <p role="alert" id="live-mode-error" className="text-ui-support text-warning">{error}</p>
        <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void refresh()} className={cn(embedded && 'home-action')}>{t('settings.LiveModeControls.236')}</Button>
    </section> : null;
    // 鍵は右の列。音楽鑑賞でロックだけのときは、ここには出さない。
    if (safetyOnly && !value.transaction && !error && !value.error) return null;
    if (!registered && !onRegister && !value.transaction && !value.armed && !error && !value.error) return null;

    const name = (mode: 'singing' | 'talk') => mode === 'singing' ? t('settings.LiveModeControls.212') : t('settings.LiveModeControls.213');
    const pending = value.phase === 'queued' || value.phase === 'transitioning';
    // メニュー項目は閉じると消えるため、設定から戻る復帰先には常設の文字付きボタンを使う。
    const openFromMenu = (action: () => void) => {
        if (actionsDetails.current) actionsDetails.current.open = false;
        actionsRef.current?.focus({ preventScroll: true });
        action();
    };
    return (
        <section aria-label={t('liveBar.label')} data-mode-registered={registered} className={cn('flex flex-wrap items-center gap-3', !embedded && 'mb-3 rounded-card border border-border bg-card gaming:bg-card/70 px-3 py-2')}>
            {registered && !safetyOnly && !hideSwitch && <LiveModeSwitch model={model} embedded={embedded} />}
            {/* 失敗文は説明の1行の上に重ね、区画の高さを変えない（#298）。 */}
            {embedded && !safetyOnly && <div className="relative min-h-10 w-full">
                <div className="flex min-h-10 w-full min-w-0 flex-wrap items-center gap-2">
                    {value.transaction && <div id="live-mode-transaction" className="flex min-w-0 flex-wrap items-center gap-2" role="status">
                        <p>{t(value.transaction.phase === 'recovery_required' || value.transaction.phase === 'failed' ? 'liveTransaction.failed' : value.transaction.phase === 'restoring' ? 'liveTransaction.recovering' : 'liveTransaction.switching')}</p>
                        {value.transaction.error && <p className="min-w-0 break-words text-ui-support">{value.transaction.error}</p>}
                        {value.transaction.recoveryAvailable && <button type="button" disabled={model.recoveryBusy || busy} onClick={() => void model.recover()} className="rounded-control border border-border px-3 py-1.5 text-ui-support">{t('liveTransaction.recover')}</button>}
                    </div>}
                    {registered && (pending || value.phase === 'partial') && <span role="status" id="live-mode-phase" className="text-ui-support text-muted-foreground">
                        {pending ? t('liveBar.switching', { mode: value.target ? name(value.target) : '' }) : t('liveOutput.partial')}
                    </span>}
                </div>
                {(error || value.error) && <div className="absolute inset-x-0 top-0 z-10 flex min-h-10 flex-wrap items-center gap-2 bg-card">
                    <p role="alert" id="live-mode-error" className="text-ui-support text-destructive-text">{error || t('liveNotices.operationFailed')}</p>
                    <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void refresh()} className="home-action">{t('settings.LiveModeControls.236')}</Button>
                </div>}
            </div>}
            {!embedded && value.transaction && <div id="live-mode-transaction" className="basis-full space-y-2" role="status">
                <p>{t(value.transaction.phase === 'recovery_required' || value.transaction.phase === 'failed' ? 'liveTransaction.failed' : value.transaction.phase === 'restoring' ? 'liveTransaction.recovering' : 'liveTransaction.switching')}</p>
                {value.transaction.error && <p className="break-words text-ui-support">{value.transaction.error}</p>}
                {value.transaction.recoveryAvailable && <button type="button" disabled={model.recoveryBusy || busy} onClick={() => void model.recover()} className="rounded-control border border-border px-3 py-1.5 text-ui-support">{t('liveTransaction.recover')}</button>}
            </div>}
            {!embedded && registered && !safetyOnly && (pending || value.phase === 'partial' || !value.running || value.phase === 'stopped') && <span role="status" id="live-mode-phase" className="text-ui-support text-muted-foreground">
                {pending ? t('liveBar.switching', { mode: value.target ? name(value.target) : '' })
                    : value.phase === 'partial' ? t('liveOutput.partial')
                    : t('liveBar.stopped')}
            </span>}
            {/* 登録後も同じボタンを保ち、設定を閉じたときのフォーカス復帰先を失わない。 */}
            {!safetyOnly && (onRegister || onPrepareSinging) && <details ref={actionsDetails} className="group min-w-0 max-w-full" onKeyDown={event => {
                if (event.key === 'Escape' && actionsDetails.current?.open) {
                    event.preventDefault(); event.stopPropagation();
                    actionsDetails.current.open = false; actionsRef.current?.focus({ preventScroll: true });
                }
            }}>
                <summary ref={actionsRef} role="button" className="inline-flex cursor-pointer list-none items-center gap-1 rounded-control px-2 py-2 text-ui-support text-muted-foreground hover:bg-muted hover:text-foreground">{t('liveBar.actions')}<MdExpandMore aria-hidden="true" className="h-4 w-4 group-open:rotate-180" /></summary>
                <div role="group" aria-label={t('liveBar.actions')} className="mt-1 flex max-w-full flex-wrap gap-2 rounded-control bg-background p-2">
                    {onRegister && <Button variant="ghost" size="sm" type="button" onClick={() => openFromMenu(onRegister)} >{t(registered ? 'liveBar.editRegistration' : 'liveBar.register')}</Button>}
                    {onPrepareSinging && <Button variant="ghost" size="sm" type="button" onClick={() => openFromMenu(onPrepareSinging)} >{t('home.singingSetup')}</Button>}
                </div>
            </details>}
            {!embedded && (error || value.error) && <div className="basis-full space-y-2"><p role="alert" id="live-mode-error" className="text-ui-support text-destructive-text">{error || t('liveNotices.operationFailed')}</p>
                <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void refresh()}>{t('settings.LiveModeControls.236')}</Button>
            </div>}
        </section>
    );
}
