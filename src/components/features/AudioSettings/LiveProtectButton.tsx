import { MdLock } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { useLiveProtectionWatch } from '@/hooks/useLiveProtectionWatch';

/** 操作ロック。LiveModeBar と同じ model を使い、右の列にだけ置く。音声が動いていない間は、かけられないので押せない。ロック中の解除は常に残す。 */
export function LiveProtectButton({ model, audioReady, safetyOnly = false }: { model: LiveModesModel; audioReady: boolean; safetyOnly?: boolean }) {
    const t = useMessages();
    const { snapshot: value, busy } = model;
    useLiveProtectionWatch(model);
    if (!value) return null;
    // 守るのは機器変更とVST・構成の置換で、歌・雑談の登録に限らない。音楽鑑賞はロック中だけ出す。
    if (safetyOnly && !value.armed) return null;
    const blocked = busy || model.changesBlocked;
    const needsAudio = !audioReady && !value.armed;
    const describedBy = needsAudio ? 'live-protect-state live-protect-needs-audio' : 'live-protect-state';
    const title = needsAudio ? t('liveBar.protectNeedsAudio') : t(value.armed ? 'liveBar.unlockHint' : 'liveBar.protect');
    return <button type="button" disabled={needsAudio} aria-disabled={blocked || undefined} aria-pressed={value.armed} aria-label={t('liveBar.protect')} aria-describedby={describedBy}
        onClick={() => { if (!blocked && !needsAudio) void model.protect(!value.armed); }}
        title={title}
        className={cn('inline-flex min-h-6 min-w-6 w-full shrink-0 items-center justify-center gap-1.5 rounded-control border px-2 py-1 text-ui-support font-medium transition-colors aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50',
            value.armed ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground')}>
        <MdLock aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{t('liveBar.protect')}</span>
        <span id="live-protect-state" className={value.armed ? 'font-semibold' : 'sr-only'}>{t(value.armed ? 'liveBar.protectOn' : 'liveBar.protectOff')}</span>
        {needsAudio && <span id="live-protect-needs-audio" className="sr-only">{t('liveBar.protectNeedsAudio')}</span>}
    </button>;
}
