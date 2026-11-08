import { ChoiceCard } from '@/components/ui/ChoiceCard';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { useMessages } from '@/i18n/LocaleProvider';
import { useId, useState } from 'react';
import { ObsTimingCheck } from './ObsTimingCheck';

const checklist = [
    'guide.copy.142',
    'guide.copy.143',
    'guide.copy.144',
] as const;

// OBS接続や音声操作は行わず、利用者による最終録画の確認だけを案内する。
export function ObsMixCheck({ initialTimingOpen = false, onOpenObsSettings }: { initialTimingOpen?: boolean; onOpenObsSettings?: () => void }) {
    const t = useMessages();
    const id = useId();
    const [timingOpen, setTimingOpen] = useState(initialTimingOpen);
    const [mic, setMic] = useState('');
    const [music, setMusic] = useState('');
    const [mixed, setMixed] = useState(false);
    const [checks, setChecks] = useState<boolean[]>([false, false, false]);
    const [judgment, setJudgment] = useState('');
    const [noted, setNoted] = useState(false);
    const resetChecks = () => { setChecks([false, false, false]); setJudgment(''); setNoted(false); };
    const namesValid = Boolean(mic.trim() && (mixed || (music.trim() && mic.trim() !== music.trim())));
    const ready = namesValid && checks.every(Boolean);
    return <details open={initialTimingOpen || undefined} className="rounded-card border border-border p-3 text-ui-support space-y-3">
        <summary className="cursor-pointer font-bold">{t('guide.copy.145')}</summary>
        <p>{t('guide.copy.146')}</p>
        <fieldset className="space-y-2">
            <legend className="font-medium">{t('guide.copy.147')}</legend>
            <fieldset className="space-y-1">
                <legend>{t('guide.copy.148')}</legend>
                <ChoiceCard  name={`${id}-route`} checked={!mixed} onChange={() => { setMixed(false); resetChecks(); }}><span>{t('guide.copy.149')}</span></ChoiceCard>
                <ChoiceCard  name={`${id}-route`} checked={mixed} onChange={() => { setMixed(true); resetChecks(); }}><span>{t('guide.copy.150')}</span></ChoiceCard>
            </fieldset>
            <label htmlFor={`${id}-mic`} className="block">{mixed ? t('guide.copy.151') : t('guide.copy.152')}
                <Field label={null} id={`${id}-mic`}><Input id={`${id}-mic`} value={mic} maxLength={200} onChange={event => { setMic(event.target.value); resetChecks(); }} className="w-full" /></Field>
            </label>
            {!mixed && <label htmlFor={`${id}-music`} className="block">{t('guide.copy.153')}<Field label={null} id={`${id}-music`}><Input id={`${id}-music`} value={music} maxLength={200} onChange={event => { setMusic(event.target.value); resetChecks(); }} className="w-full" /></Field>
            </label>}
            {mixed && <p className="text-ui-support text-muted-foreground">{t('guide.copy.154')}</p>}
            <p className="text-ui-support text-muted-foreground">{t('guide.copy.155')}</p>
            {!namesValid && (mic || music) && <p className="text-ui-support">{mixed ? t('guide.copy.156') : t('guide.copy.157')}</p>}
        </fieldset>
        <fieldset disabled={!namesValid} className="space-y-2 disabled:opacity-60">
            <legend className="font-medium">{t('guide.copy.158')}</legend>
            {checklist.map((label, index) => <label key={label} className="flex items-start gap-2">
                <Field label={null}><Checkbox type="checkbox" checked={checks[index]} onChange={event => { setChecks(previous => previous.map((value, i) => i === index ? event.target.checked : value)); setJudgment(''); setNoted(false); }} className="mt-1 shrink-0" /></Field>
                <span>{t(label)}</span>
            </label>)}
        </fieldset>
        <div className="space-y-2">
            <h4 className="font-medium">{t('guide.copy.159')}</h4>
            <ol className="list-decimal pl-5 space-y-1">
                <li>{t('guide.copy.160')}</li>
                <li>{t('guide.copy.161')}</li>
                <li>{t('guide.copy.162')}</li>
            </ol>
            <p className="text-ui-support text-muted-foreground">{t('guide.copy.163')}</p>
            <label htmlFor={`${id}-judgment`} className="block">{t('guide.copy.164')}<Field label={null} id={`${id}-judgment`}><Select id={`${id}-judgment`} disabled={!ready} value={judgment} onChange={event => { setJudgment(event.target.value); setNoted(false); }} className="w-full">
                    <option value="">{t('guide.copy.165')}</option>
                    <option value="balanced">{t('guide.copy.166')}</option>
                    <option value="quiet">{t('guide.copy.167')}</option>
                    <option value="loud">{t('guide.copy.168')}</option>
                    <option value="duplicate">{t('guide.copy.169')}</option>
                    <option value="unknown">{t('guide.copy.170')}</option>
                </Select></Field>
            </label>
            <Button variant="outline" type="button" disabled={!ready || !judgment} onClick={() => setNoted(true)} >{t('guide.copy.171')}</Button>
            {noted && <p role="status">{judgment === 'unknown' ? t('guide.copy.172') : t('guide.copy.173')}</p>}
        </div>
        <p className="text-ui-support text-muted-foreground">{t('guide.copy.174')}</p>
        <p className="text-ui-support text-muted-foreground">{t('guide.copy.175')}</p>
        <button type="button" onClick={() => { setMic(''); setMusic(''); setMixed(false); resetChecks(); }} className="link-button">{t('guide.copy.176')}</button>
        <p className="text-ui-support text-muted-foreground">{t('guide.copy.177')}</p>
        <button type="button" onClick={() => setTimingOpen(open => !open)} className="link-button">{timingOpen ? t('guide.copy.178') : t('guide.copy.179')}</button>
        {timingOpen && <ObsTimingCheck onOpenObsSettings={onOpenObsSettings} mixed={mixed} contextKey={JSON.stringify([mic, music])} />}
    </details>;
}
