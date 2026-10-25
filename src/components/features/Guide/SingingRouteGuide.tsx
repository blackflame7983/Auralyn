import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useMessages } from '@/i18n/LocaleProvider';
import { readAudioPreferences } from '@/lib/audioPreferences';

// 確認は機器の能力検出ではなく、利用者がその接続で行った手動確認として保存する。
const checks = ['headphones', 'return', 'accompaniment', 'direct', 'obs'] as const;
export function SingingRouteGuide({ hardware }: { hardware: boolean | null }) {
    const t = useMessages();
    const config = readAudioPreferences();
    const fingerprint = JSON.stringify([config?.host, config?.inputId, config?.outputId, config?.inputChannels, config?.sampleRate, config?.bufferSize, hardware]);
    const [saved, setSaved] = useState('');
    const [checked, setChecked] = useState<Record<string, boolean>>({});
    const [symptom, setSymptom] = useState('none');
    const identified = hardware !== null && !!config?.inputId && !!config.outputId;
    const current = saved === fingerprint;
    const requiredChecks = hardware ? checks : checks.filter(key => key !== 'return');
    useEffect(() => {
        const invalidate = () => { setSaved(''); setChecked({}); };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error', 'audio-conditions-changed'].map(event => listen(event, invalidate));
        void Promise.all(subscriptions).catch(() => {});
        return () => { subscriptions.forEach(request => void request.then(stop => stop()).catch(() => {})); };
    }, []);
    return <section aria-label={t('singingRoute.title')} className="space-y-3 border border-border rounded p-3">
        <h3 className="font-semibold">{t('singingRoute.title')}</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>{t('singingRoute.input')}</dt><dd>{config?.input || t('singingRoute.unknown')}</dd>
            <dt>{t('singingRoute.monitor')}</dt><dd>{hardware ? config?.output || t('singingRoute.unknown') : t('singingRoute.alternative')}</dd>
            <dt>{t('singingRoute.broadcast')}</dt><dd>{hardware ? t('singingRoute.loopback') : t('guide.copy.034')}</dd>
        </dl>
        <p className="text-sm">{t('singingRoute.scope')}</p>
        <p className="text-sm">{t(hardware ? 'singingRoute.hardware' : 'singingRoute.software')}</p>
        <fieldset className="space-y-2"><legend className="font-medium">{t('singingRoute.manual')}</legend>
            {requiredChecks.map(key => <label key={key} className="flex gap-2 text-sm"><input type="checkbox" checked={!!checked[fingerprint + key]} onChange={event => setChecked(value => ({ ...value, [fingerprint + key]: event.target.checked }))} />{t(`singingRoute.check.${key}`)}</label>)}
        </fieldset>
        <label className="block text-sm">{t('singingRoute.symptom')}
            <select className="block w-full bg-background border border-border rounded p-2" value={symptom} onChange={event => setSymptom(event.target.value)}>
                {['none', 'silent', 'music', 'double', 'late', 'obs'].map(key => <option key={key} value={key}>{t(`singingRoute.symptom.${key}` as 'singingRoute.symptom.none')}</option>)}
            </select>
        </label>
        {symptom !== 'none' && <p role="status" className="text-sm">{t(`singingRoute.help.${symptom}` as 'singingRoute.help.silent')}</p>}
        <button className="border border-border rounded px-3 py-2 disabled:opacity-50" disabled={!identified || !requiredChecks.every(key => checked[fingerprint + key])} onClick={() => {
            try { localStorage.setItem('auralyn_singing_route', JSON.stringify({ schemaVersion: 1, fingerprint, checkedAt: Date.now(), kind: hardware ? 'hardwareLoopback' : 'obsAlternative', config })); setSaved(fingerprint); } catch { setSaved(''); }
        }}>{t('singingRoute.save')}</button>
        <p role="status" className="text-xs">{t(current ? 'singingRoute.saved' : 'singingRoute.unverified')}</p>
    </section>;
}
