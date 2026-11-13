import { MdLock } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import type { LiveModesModel } from '@/hooks/useLiveModes';

/** 操作ロック。LiveModeBar と同じ model を使い、右の列にだけ置く。 */
export function LiveProtectButton({ model, safetyOnly = false }: { model: LiveModesModel; safetyOnly?: boolean }) {
    const t = useMessages();
    const { snapshot: value, busy } = model;
    if (!value) return null;
    const registered = Boolean(value.definitions.singing || value.definitions.talk);
    // 音楽鑑賞はロック中だけ出す（safetyOnly）。解除中の鍵はホームに残さない。
    if (!(registered || value.armed) || (safetyOnly && !value.armed)) return null;
    const blocked = busy || model.changesBlocked;
    return <button type="button" aria-disabled={blocked || undefined} aria-pressed={value.armed} aria-label={t('liveBar.protect')} aria-describedby="live-protect-state"
        onClick={() => { if (!blocked) void model.protect(!value.armed); }}
        title={t(value.armed ? 'liveBar.unlockHint' : 'liveBar.protect')}
        className={cn('inline-flex min-h-6 min-w-6 w-full shrink-0 items-center justify-center gap-1.5 rounded-control border px-2 py-1 text-ui-support font-medium transition-colors aria-disabled:opacity-50',
            value.armed ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted-foreground hover:text-foreground')}>
        <MdLock aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{t('liveBar.protect')}</span>
        <span id="live-protect-state" className={value.armed ? 'font-semibold' : 'sr-only'}>{t(value.armed ? 'liveBar.protectOn' : 'liveBar.protectOff')}</span>
    </button>;
}
