import { useContext, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { MdMusicNote } from 'react-icons/md';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { postMixApi, type PostMixSnapshot } from '@/api/postMix';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { GainControl, MixingError, useQueuedChange } from '@/components/features/AudioSettings/mixingUi';
import { LiveControlsHiddenContext } from './LiveControlsContext';

export function MixingLiveControl({ running, blocked, onSettings, errorsOnly = false }: { running: boolean; blocked: boolean; onSettings: () => void; errorsOnly?: boolean }) {
    const t = useMessages();
    const [mix, setMix] = useState<MixSnapshot | null>(null), [post, setPost] = useState<PostMixSnapshot | null>(null);
    const [desired, setDesired] = useState<{ gain: number; muted: boolean } | null>(null), [open, setOpen] = useState(false);
    const [readError, setReadError] = useState<string | null>(null), [commandError, setCommandError] = useState<string | null>(null);
    const error = commandError ?? readError;
    const witness = useRef<MixSnapshot | null>(null), busy = useRef(false), sequence = useRef(0), pending = useRef<{ gain: number; muted: boolean } | null>(null);
    useEffect(() => {
        let active = true, reading = false;
        const read = async () => {
            if (reading || busy.current || pending.current || blocked || document.hidden) return;
            reading = true; const ticket = sequence.current;
            try { const [m, p] = await Promise.all([mixingApi.request({ action: 'snapshot' }), postMixApi.request({ action: 'snapshot' })]);
                if (active && ticket === sequence.current && !pending.current) { setMix(m); setPost(p); witness.current = m; setReadError(m.error ?? p.error); }
            } catch (e) { if (active && ticket === sequence.current) setReadError(String(e)); } finally { reading = false; }
        };
        void read(); const timer = setInterval(() => void read(), 1000); window.addEventListener('mixing-settings-changed', read);
        return () => { active = false; clearInterval(timer); window.removeEventListener('mixing-settings-changed', read); sequence.current++; };
    }, [blocked, running]);
    const send = async (change: { gain: number; muted: boolean }) => {
        const current = witness.current;
        if (!current?.config || busy.current || blocked) return null;
        const levels = { ...current.config.levels, accompaniment: { ...current.config.levels.accompaniment, ...change } };
        busy.current = true; const ticket = ++sequence.current;
        try { const next = await mixingApi.request({ action: 'levels', expectedEpoch: current.epoch, expectedRevision: current.revision, levels });
            if (ticket !== sequence.current) return null;
            witness.current = next; setMix(next); setCommandError(next.error);
            if (next.error || pending.current === change) { pending.current = null; setDesired(null); }
            return next.error ? null : next;
        } catch (e) { if (ticket === sequence.current) { setCommandError(String(e)); pending.current = null; setDesired(null); } return null; }
        finally { busy.current = false; }
    };
    const queue = useQueuedChange<{ gain: number; muted: boolean }>(send);
    useEffect(() => { queue.cancel(); pending.current = null; setDesired(null); if (blocked) setOpen(false); }, [blocked, running]);
    // 欄ごと隠れたら、Portal の小窓も閉じる。基準のボタンが消えたまま操作できる小窓を残さない。
    const hidden = useContext(LiveControlsHiddenContext);
    useEffect(() => { if (hidden) setOpen(false); }, [hidden]);
    const change = (patch: Partial<{ gain: number; muted: boolean }>) => {
        const active = pending.current ?? witness.current?.config?.levels.accompaniment;
        if (!active) return;
        if (!busy.current) sequence.current++;
        const value = { ...active, ...patch }; pending.current = value; setDesired(value); setCommandError(null); queue.enqueue(value);
    };
    const problem = !!error || !!mix?.failed || !!mix?.accompaniment?.failed || !!post?.failed;
    if (errorsOnly) return problem ? <div role="alert" className="text-ui-support text-destructive-text">{t('mixingHome.failure')}</div> : null;
    if (!mix?.config && !mix?.savedConfig && !post?.enabled && !post?.savedPlugins.length && !post?.plugins.length) return null;
    // 音楽鑑賞の失敗通知（errorsOnly）は両方の失敗を見るが、ここでのオケの状態はオケ自体の失敗だけで決める。
    const accompanimentFailed = !!mix?.failed || !!mix?.accompaniment?.failed;
    const mixProblem = !!error || accompanimentFailed;
    const mixState = error ? 'mixingHome.unknown' : accompanimentFailed || !running || !mix?.config ? 'mixingHome.stopped' : mix.accompaniment?.waitingForAudio ? 'mixing.waiting' : 'mixingHome.active';
    const postState = !running || !post?.enabled || post.failed || post.ready !== true || post.attached !== true ? 'mixingHome.postStopped' : 'mixingHome.postActive';
    return <div className="flex flex-wrap items-center gap-2 text-ui-support" aria-label={t('mixingHome.open')}>
        {mix?.config && <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild><button type="button" disabled={blocked} aria-label={t('mixingHome.volume')} title={t('mixingHome.volume')} className="inline-flex items-center gap-1 rounded-control border border-input px-2 py-1"><MdMusicNote aria-hidden="true" />{Math.round((desired?.gain ?? mix.config.levels.accompaniment.gain) * 100)}%</button></Popover.Trigger>
            <Popover.Portal><Popover.Content side="bottom" sideOffset={8} className="z-50 w-72 max-w-[calc(90vw/var(--ui-zoom))] space-y-3 rounded-card border border-border bg-popover p-4 shadow-lg" aria-label={t('mixingHome.volume')}>
                <GainControl label={t('mixingUi.accompanimentVolume')} value={desired?.gain ?? mix.config.levels.accompaniment.gain} disabled={blocked} onChange={value => change({ gain: value })} />
                <Button className="press-feedback" variant="outline" aria-pressed={desired?.muted ?? mix.config.levels.accompaniment.muted} onClick={() => change({ muted: !(pending.current?.muted ?? witness.current?.config?.levels.accompaniment.muted) })}>{t('mixing.mute')}</Button>
                <MixingError draftRetained={false} error={error ? { operation: 'mixingUi.levels', raw: error } : null} />
            </Popover.Content></Popover.Portal></Popover.Root>}
        <span role={mixProblem ? 'alert' : 'status'}><Button variant="ghost" size="sm" type="button" disabled={blocked} onClick={onSettings} className={cn('h-auto whitespace-normal text-left', mixProblem ? 'text-destructive-text' : 'text-muted-foreground hover:text-foreground')}>
            {(mix?.config || mix?.savedConfig) && t(mixState)}{(mix?.config || mix?.savedConfig) && (post?.enabled || !!post?.savedPlugins.length || !!post?.plugins.length) && ' · '}{(post?.enabled || !!post?.savedPlugins.length || !!post?.plugins.length) && t(postState)}
        </Button></span>
    </div>;
}
