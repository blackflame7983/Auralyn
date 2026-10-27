import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useMessages } from '@/i18n/LocaleProvider';
import { readAudioPreferences } from '@/lib/audioPreferences';

// 確認は機器の能力検出ではなく、利用者がその接続で行った手動確認として保存する。
const checks = ['headphones', 'return', 'accompaniment', 'direct', 'obs'] as const;
const directChecks = ['directVoice', 'directNoDouble', 'directObsTiming'] as const;
export type SingingRoute = 'processed' | 'direct';

export function SingingRouteChoice({ value, onChange }: { value: SingingRoute; onChange: (value: SingingRoute) => void }) {
    const t = useMessages();
    return <fieldset className="space-y-2"><legend className="font-semibold">{t('singingRoute.choose')}</legend>
        {(['processed', 'direct'] as const).map(option => <label key={option} className="flex items-start gap-2 text-sm">
            <input type="radio" name="singing-monitor-route" checked={value === option} onChange={() => onChange(option)} />
            <span>{t(option === 'direct' ? 'singingRoute.optionDirect' : 'singingRoute.optionProcessed')}</span>
        </label>)}
        <p className="text-xs text-muted-foreground">{t('singingRoute.choiceHint')}</p>
    </fieldset>;
}

export function SingingRouteGuide({ hardware, route: controlledRoute, onRouteChange, onOpenTiming }: { hardware: boolean | null; route?: SingingRoute; onRouteChange?: (route: SingingRoute) => void; onOpenTiming?: () => void }) {
    const t = useMessages();
    const [localRoute, setLocalRoute] = useState<SingingRoute>('processed');
    const route = controlledRoute ?? localRoute;
    const chooseRoute = (value: SingingRoute) => { setLocalRoute(value); onRouteChange?.(value); setSymptom('none'); };
    const config = readAudioPreferences();
    const legacyFingerprint = JSON.stringify([config?.host, config?.inputId, config?.outputId, config?.inputChannels, config?.sampleRate, config?.bufferSize, hardware]);
    const fingerprint = route === 'direct' ? JSON.stringify(['direct', config?.host, config?.inputId, config?.outputId, config?.inputChannels, config?.sampleRate, config?.bufferSize]) : legacyFingerprint;
    const [saved, setSaved] = useState<Partial<Record<SingingRoute, string>>>({});
    const [checked, setChecked] = useState<Record<string, boolean>>({});
    const [symptom, setSymptom] = useState('none');
    const identified = (route === 'direct' || hardware !== null) && !!config?.inputId && !!config.outputId;
    const current = saved[route] === fingerprint;
    const requiredChecks = route === 'direct' ? directChecks : hardware ? checks : checks.filter(key => key !== 'return');
    // 経路や接続が変わったら、前の確認を再び選択しても自動では復活させない。
    useEffect(() => { setSaved({}); setChecked({}); }, [fingerprint]);
    useEffect(() => {
        const invalidate = () => { setSaved({}); setChecked({}); };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error', 'audio-conditions-changed'].map(event => listen(event, invalidate));
        void Promise.all(subscriptions).catch(() => {});
        return () => { subscriptions.forEach(request => void request.then(stop => stop()).catch(() => {})); };
    }, []);
    return <section aria-label={t('singingRoute.title')} className="space-y-3 border border-border rounded p-3">
        <h3 className="font-semibold">{t('singingRoute.title')}</h3>
        <SingingRouteChoice value={route} onChange={chooseRoute} />
        <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>{t('singingRoute.input')}</dt><dd>{config?.input || t('singingRoute.unknown')}</dd>
            <dt>{t('singingRoute.monitor')}</dt><dd>{route === 'direct' ? t('singingRoute.directMonitorDevice') : hardware ? config?.output || t('singingRoute.unknown') : t('singingRoute.alternative')}</dd>
            <dt>{t('singingRoute.broadcast')}</dt><dd>{route === 'direct' ? config?.output || t('singingRoute.unknown') : hardware ? t('singingRoute.loopback') : t('guide.copy.034')}</dd>
        </dl>
        <p className="text-sm">{t('singingRoute.scope')}</p>
        <p className="text-sm">{t(route === 'direct' ? 'singingRoute.directInstructions' : hardware ? 'singingRoute.hardware' : 'singingRoute.software')}</p>
        {route === 'direct' && <p className="text-sm">{t('singingRoute.directLatency')}</p>}
        <fieldset className="space-y-2"><legend className="font-medium">{t('singingRoute.manual')}</legend>
            {requiredChecks.map(key => <label key={key} className="flex gap-2 text-sm"><input type="checkbox" checked={!!checked[fingerprint + key]} onChange={event => setChecked(value => ({ ...value, [fingerprint + key]: event.target.checked }))} />{t(`singingRoute.check.${key}`)}</label>)}
        </fieldset>
        <label className="block text-sm">{t('singingRoute.symptom')}
            <select className="block w-full bg-background border border-border rounded p-2" value={symptom} onChange={event => setSymptom(event.target.value)}>
                {['none', 'silent', 'music', 'double', 'late', 'obs'].map(key => <option key={key} value={key}>{t(`singingRoute.symptom.${key}` as 'singingRoute.symptom.none')}</option>)}
            </select>
        </label>
        {symptom !== 'none' && <p role="status" className="text-sm">{t(route === 'direct' ? `singingRoute.directHelp.${symptom}` as 'singingRoute.directHelp.silent' : `singingRoute.help.${symptom}` as 'singingRoute.help.silent')}</p>}
        {route === 'direct' && onOpenTiming && <button type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={onOpenTiming}>{t('singingRoute.openTiming')}</button>}
        <button className="border border-border rounded px-3 py-2 disabled:opacity-50" disabled={!identified || !requiredChecks.every(key => checked[fingerprint + key])} onClick={() => {
            try { localStorage.setItem(route === 'direct' ? 'auralyn_singing_route_direct' : 'auralyn_singing_route', JSON.stringify({ schemaVersion: 1, fingerprint, checkedAt: Date.now(), kind: route === 'direct' ? 'directMonitor' : hardware ? 'hardwareLoopback' : 'obsAlternative', config })); setSaved(value => ({ ...value, [route]: fingerprint })); } catch { setSaved(value => ({ ...value, [route]: '' })); }
        }}>{t('singingRoute.save')}</button>
        <p role="status" className="text-xs">{t(current ? 'singingRoute.saved' : 'singingRoute.unverified')}</p>
    </section>;
}
