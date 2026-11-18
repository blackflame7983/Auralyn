import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { isRecoveryProfileName, profileDisplayName } from '@/lib/profileNames';
import { useSavedPresetNames } from '@/hooks/useSavedPresetNames';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';

// 音楽鑑賞のホームに、保存した VST の構成の切り替えだけを置く。
// 構成が1件も無いときはカードを出さない。VST の入口は上のカードの「追加」に残す。
export function MusicHomeDesk({ onLoadPreset }: {
    onLoadPreset?: (name: string) => Promise<boolean>;
}) {
    const t = useMessages();
    const { locale } = useLocale();
    const { names, failed: listFailed } = useSavedPresetNames();
    const [chosen, setChosen] = useState('');
    const [switching, setSwitching] = useState(false);
    const [failed, setFailed] = useState(false);
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
    const savedNames = names?.filter(name => !isRecoveryProfileName(name)) ?? [];
    const recoveryNames = names?.filter(name => isRecoveryProfileName(name)) ?? [];
    const hasChoices = savedNames.length > 0 || recoveryNames.length > 0;
    if (!listFailed && !hasChoices) return null;
    return <section aria-label={t('music.playback')} aria-busy={switching} className="music-desk mb-4 flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <h2 className="home-title">{t('music.playback')}</h2>
        {listFailed && <p role="alert" className="text-ui-support text-destructive-text">{t('music.presetListFailed')}</p>}
        {hasChoices && <Field label={t('music.presetLabel')}>
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
    </section>;
}
