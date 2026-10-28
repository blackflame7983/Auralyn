import { useEffect, useRef } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';

export function MusicListeningCheck({ running, input, output, onSettings, onClose }: { running: boolean; input?: string; output?: string; onSettings: () => void; onClose: () => void }) {
    const t = useMessages();
    const heading = useRef<HTMLHeadingElement>(null);
    const inputLevel = useSharedMeter(running, 'input');
    const outputLevel = useSharedMeter(running, 'output');
    useEffect(() => { heading.current?.scrollIntoView?.({block: 'start'}); heading.current?.focus({preventScroll: true}); }, []);
    return <section aria-label={t('music.listenTitle')} className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 tabIndex={-1} ref={heading} className="text-sm font-bold">{t('music.listenTitle')}</h2>
        <p className="text-sm">{t('music.listenSteps')}</p>
        <dl className="text-sm break-words"><dt>{t('home.input')}</dt><dd>{input ?? t('master.unset')}</dd><dt>{t('home.output')}</dt><dd>{output ?? t('master.unset')}</dd></dl>
        <MeterVisual reading={inputLevel} label={t('wizard.musicLevel')} orientation="horizontal" height={12} />
        <MeterVisual reading={outputLevel} label={t('meter.output')} orientation="horizontal" height={12} />
        <p className="text-xs text-muted-foreground">{t('music.listenScope')}</p>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={onSettings} className="rounded border border-border p-2 text-sm">{t('music.listenSettings')}</button><button type="button" onClick={onClose} className="rounded border border-border p-2 text-sm">{t('common.close')}</button></div>
    </section>;
}
