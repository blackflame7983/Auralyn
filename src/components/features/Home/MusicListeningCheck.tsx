import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useEffect, useRef } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';

export function MusicListeningCheck({ running, input, output, vstBypassed, onCompareVst, onSettings, onClose }: {
    running: boolean;
    input?: string;
    output?: string;
    /** 右の列の「VSTを外して比較」と同じ状態。新しい購読は足さない。 */
    vstBypassed: boolean;
    onCompareVst: () => void;
    onSettings: () => void;
    onClose: () => void;
}) {
    const t = useMessages();
    const heading = useRef<HTMLHeadingElement>(null);
    const inputLevel = useSharedMeter(running, 'input');
    const outputLevel = useSharedMeter(running, 'output');
    useEffect(() => { heading.current?.scrollIntoView?.({block: 'start'}); heading.current?.focus({preventScroll: true}); }, []);
    return <section aria-label={t('music.listenTitle')} className="rounded-card border border-border bg-card p-4 space-y-3">
        <h2 tabIndex={-1} ref={heading} className="home-title">{t('music.listenTitle')}</h2>
        <p className="text-ui-support">{t('music.listenSteps')}</p>
        <dl className="text-ui-support break-words"><dt>{t('home.input')}</dt><dd>{input ?? t('master.unset')}</dd><dt>{t('home.output')}</dt><dd>{output ?? t('master.unset')}</dd></dl>
        <MeterVisual reading={inputLevel} label={t('wizard.musicLevel')} orientation="horizontal" height={12} />
        <MeterVisual reading={outputLevel} label={t('meter.output')} orientation="horizontal" height={12} />
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
                <p className="text-ui-control font-semibold">{t('music.compareVst')}</p>
                <p className="text-ui-support text-muted-foreground">{vstBypassed ? t('header.compareEndHint') : t('header.compareStartHint')}</p>
            </div>
            <Switch checked={vstBypassed} onCheckedChange={() => onCompareVst()} aria-label={t('music.compareVst')} />
        </div>
        <p className="text-ui-support text-muted-foreground">{t('music.listenScope')}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="default" type="button" onClick={onSettings} className="home-action">{t('music.listenSettings')}</Button><Button variant="outline" size="default" type="button" onClick={onClose} className="home-action">{t('common.close')}</Button></div>
    </section>;
}
