import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/switch';
import { presetApi } from '@/api/presets';
import { displayAudioHost } from '@/lib/audioDevices';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';

// 音楽鑑賞のホームに、保存済みの VST 構成と聴き比べと再生の状態を置く。
// 一覧は開いたときに1回だけ読む。購読やタイマーは足さない。
export function MusicHomeDesk({ host, sampleRate, vstBypassed, onCompare, onLoadPreset, onOpenVst }: {
    host?: string;
    sampleRate?: number;
    /** 右の列の「VSTを外して比較」と同じ状態。 */
    vstBypassed: boolean;
    onCompare: () => void;
    onLoadPreset?: (name: string) => Promise<boolean>;
    onOpenVst?: () => void;
}) {
    const t = useMessages();
    const [names, setNames] = useState<string[] | null>(null);
    const [listFailed, setListFailed] = useState(false);
    const [chosen, setChosen] = useState('');
    const [switching, setSwitching] = useState(false);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        void presetApi.list().then(list => {
            if (!active) return;
            if (!Array.isArray(list)) { setListFailed(true); return; }
            setNames(list);
        }).catch(() => { if (active) setListFailed(true); });
        return () => { active = false; };
    }, []);
    const apply = async (name: string) => {
        if (!name || switching) return;
        setChosen(name);
        setSwitching(true);
        setFailed(false);
        try {
            const ok = await (onLoadPreset ?? (async () => false))(name);
            if (!ok) setFailed(true);
        } catch {
            setFailed(true);
        } finally {
            setSwitching(false);
        }
    };
    const rate = sampleRate && Number.isFinite(sampleRate) && sampleRate > 0 ? `${sampleRate / 1000} kHz` : t('master.unset');
    return <section aria-label={t('music.playback')} aria-busy={switching} className="mb-4 space-y-3 rounded-card border border-border bg-card p-4">
        <h2 className="text-ui-heading font-semibold">{t('music.playback')}</h2>
        <p className="break-words text-ui-support">{t('music.playbackValues', { host: host ? displayAudioHost(host) : t('master.unset'), rate })}</p>
        {listFailed && <p role="alert" className="text-ui-support text-destructive-text">{t('music.presetListFailed')}</p>}
        {names && names.length === 0 && <div className="space-y-2">
            <p className="text-ui-support text-muted-foreground">{t('music.presetEmpty', { save: t('rack.manageProfiles') })}</p>
            {onOpenVst && <Button type="button" variant="outline" onClick={onOpenVst}>{t('music.presetOpen')}</Button>}
        </div>}
        {names && names.length > 0 && <Field label={t('music.presetLabel')}>
            <Select value={chosen} disabled={switching} onChange={event => { void apply(event.target.value); }}>
                <option value="">{t('music.presetChoose')}</option>
                {names.map(name => <option key={name} value={name}>{name}</option>)}
            </Select>
        </Field>}
        {switching && <p role="status" className="text-ui-support">{t('music.presetSwitching')}</p>}
        {failed && <p role="alert" className="text-ui-support text-destructive-text">{t('pluginNotices.loadPresetFailed')}</p>}
        <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-ui-control font-semibold">{t('music.compareVst')}</p>
            <Switch checked={vstBypassed} disabled={switching} onCheckedChange={() => onCompare()} aria-label={t('music.compareVst')} />
        </div>
    </section>;
}
