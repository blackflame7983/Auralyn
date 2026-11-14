import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/switch';
import { presetApi, PROFILE_BACKUP_NAME } from '@/api/presets';
import { displayAudioHost } from '@/lib/audioDevices';
import { isRecoveryProfileName, profileDisplayName } from '@/lib/profileNames';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
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
    const { locale } = useLocale();
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
            // 切替前の自動退避は出さない。復旧の退避は元の名前のまま残し、表示で分ける。
            setNames(list.filter(name => name !== PROFILE_BACKUP_NAME));
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
    const savedNames = names?.filter(name => !isRecoveryProfileName(name)) ?? [];
    const recoveryNames = names?.filter(name => isRecoveryProfileName(name)) ?? [];
    const hasChoices = savedNames.length > 0 || recoveryNames.length > 0;
    return <section aria-label={t('music.playback')} aria-busy={switching} className="mb-4 space-y-3 rounded-card border border-border bg-card p-4">
        <h2 className="home-title">{t('music.playback')}</h2>
        <p className="break-words text-ui-support">{t('music.playbackValues', { host: host ? displayAudioHost(host) : t('master.unset'), rate })}</p>
        {listFailed && <p role="alert" className="text-ui-support text-destructive-text">{t('music.presetListFailed')}</p>}
        {names && !hasChoices && <div className="space-y-2">
            <p className="text-ui-support text-muted-foreground">{t('music.presetEmpty', { save: t('rack.manageProfiles') })}</p>
            {onOpenVst && <Button type="button" variant="outline" onClick={onOpenVst}>{t('music.presetOpen')}</Button>}
        </div>}
        {names && hasChoices && <Field label={t('music.presetLabel')}>
            <Select value={chosen} disabled={switching} onChange={event => { void apply(event.target.value); }}>
                <option value="">{t('music.presetChoose')}</option>
                {savedNames.map(name => <option key={name} value={name}>{name}</option>)}
                {recoveryNames.length > 0 && <optgroup label={t('profile.recoveryGroup')}>
                    {recoveryNames.map(name => <option key={name} value={name}>{profileDisplayName(name, locale)}</option>)}
                </optgroup>}
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
