import { useDisplayPurpose, type DisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useMessages } from '@/i18n/LocaleProvider';

// 毎日切り替えるものではないので、ホームの本文ではなく設定の「表示」に置く。
// 表示だけを切り替え、音声設定・準備の送り先・送出には触れない。
export function DisplayPurposeSelector() {
    const t = useMessages();
    const [purpose, setPurpose] = useDisplayPurpose();
    return <div className="mb-3 space-y-1 text-sm">
        <label className="flex items-center gap-3">{t('purpose.label')}
            <select value={purpose} onChange={event => setPurpose(event.target.value as DisplayPurpose)} aria-describedby="display-purpose-hint"
                className="rounded border border-border bg-background px-2 py-1">
                <option value="voice">{t('purpose.voice')}</option><option value="music">{t('purpose.music')}</option>
            </select>
        </label>
        <p id="display-purpose-hint" className="text-xs text-muted-foreground">{t('purpose.hint')}</p>
    </div>;
}
