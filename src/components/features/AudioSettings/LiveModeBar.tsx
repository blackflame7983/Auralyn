import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect } from 'react';
import { MdShield, MdAdd, MdTune } from 'react-icons/md';
import { cn } from '@/lib/utils';
import type { LiveModesModel } from '@/hooks/useLiveModes';

// 本番中に使う歌・雑談の切替と本番保護。未登録の間は登録欄への入口だけを出す。
// 未登録の間は起動時・設定を閉じたとき・前面への復帰時に状態を読み、定期確認はしない。
// embedded は本番帯の中に置くとき。枠と余白を本番帯に任せる。
export function LiveModeBar({ model, refreshKey, embedded = false, onRegister }: { model: LiveModesModel; refreshKey?: unknown; embedded?: boolean; onRegister?: () => void }) {
    const t = useMessages();
    const { snapshot: value, busy, error, refresh, activate } = model;
    const registered = Boolean(value?.definitions.singing || value?.definitions.talk);
    useEffect(() => {
        // 親の状態管理が初期化されてから読む。StrictModeの再マウントで最初の応答だけが失効するのを避ける。
        const frame = requestAnimationFrame(() => { void refresh(); });
        return () => cancelAnimationFrame(frame);
    }, [refresh, refreshKey]);
    useEffect(() => {
        if (registered) return;
        // 背景で起動して最初の取得を見送った場合も、前面に戻ったときに入口を表示できるようにする。
        const visible = () => { if (!document.hidden) void refresh(false); };
        document.addEventListener('visibilitychange', visible);
        return () => document.removeEventListener('visibilitychange', visible);
    }, [registered, refresh]);
    useEffect(() => (registered ? activate() : undefined), [registered, activate]);
    if (!value || (!registered && !onRegister)) return null;

    const name = (mode: 'singing' | 'talk') => mode === 'singing' ? t('settings.LiveModeControls.212') : t('settings.LiveModeControls.213');
    const applied = value.phase === 'settled' ? value.applied : null;
    const pending = value.phase === 'queued' || value.phase === 'transitioning';
    return (
        <section aria-label={t('liveBar.label')} className={cn('flex flex-wrap items-center gap-3', !embedded && 'mb-3 rounded-xl border border-border bg-card/70 px-3 py-2')}>
            {registered && !embedded && <span className="text-sm font-semibold">{t('liveBar.label')}</span>}
            {registered && <div role="group" aria-label={t('liveBar.mode')} className="flex gap-1">
                {(['singing', 'talk'] as const).map(mode => (
                    <button key={mode} type="button" disabled={busy || !value.definitions[mode]} aria-pressed={applied === mode}
                        onClick={() => void model.select(mode)}
                        className={cn('rounded-md border px-3 py-1.5 text-sm font-bold transition-colors disabled:opacity-50',
                            applied === mode ? 'border-selection bg-selection/15 text-selection' : 'border-input bg-background text-muted-foreground hover:text-foreground')}>
                        {name(mode)}
                    </button>
                ))}
            </div>}
            {registered && <span role="status" className="text-xs text-muted-foreground">
                {pending ? t('liveBar.switching', { mode: value.target ? name(value.target) : '' })
                    : value.phase === 'partial' ? t('liveOutput.partial')
                    : !value.running || value.phase === 'stopped' ? t('liveBar.stopped')
                    : applied ? '' : t('liveBar.custom')}
            </span>}
            {registered && <button type="button" disabled={busy} aria-pressed={value.armed} aria-label={t('liveBar.protect')} aria-describedby={value.armed ? 'live-protect-state' : undefined} onClick={() => void model.protect(!value.armed)}
                title={t('liveBar.protectHint')}
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50', !embedded && 'ml-auto',
                    value.armed ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted-foreground hover:text-foreground')}>
                <MdShield aria-hidden="true" className="h-4 w-4" />
                {t('liveBar.protect')}
                {value.armed && <span id="live-protect-state" className="font-medium">{t('liveBar.protecting')}</span>}
            </button>}
            {/* 登録後も同じボタンを保ち、設定を閉じたときのフォーカス復帰先を失わない。 */}
            {onRegister && <button type="button" onClick={onRegister} aria-label={t(registered ? 'liveBar.editRegistration' : 'liveBar.register')} title={registered ? t('liveBar.editRegistration') : undefined}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                {registered ? <MdTune aria-hidden="true" className="h-4 w-4" /> : <><MdAdd aria-hidden="true" className="h-4 w-4" />{t('liveBar.register')}</>}
            </button>}
            {error && <p role="alert" className="basis-full text-xs text-destructive-text">{error}</p>}
        </section>
    );
}
