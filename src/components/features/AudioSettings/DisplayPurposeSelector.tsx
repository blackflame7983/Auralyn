import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useDisplayPurpose, type DisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useAuroraDisplay } from '@/hooks/useAuroraDisplay';
import { useMessages } from '@/i18n/LocaleProvider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/InfoPopover';

// 毎日切り替えるものではないので、ホームの本文ではなく設定の「表示」に置く。
// 表示だけを切り替え、音声設定・準備の送り先・送出には触れない。
export function DisplayPurposeSelector() {
    const t = useMessages();
    const [purpose, setPurpose] = useDisplayPurpose();
    return <div className="mb-3 flex flex-wrap items-center gap-2 text-ui-support">
        <Field label={t('purpose.label')} description={t('purpose.hint')}>
            <Select value={purpose} onChange={event => setPurpose(event.target.value as DisplayPurpose)}>
                <option value="voice">{t('purpose.voice')}</option><option value="music">{t('purpose.music')}</option>
            </Select>
        </Field>
        <InfoPopover label={t('purpose.label')}>{t('purpose.hint')}</InfoPopover>
    </div>;
}

// 遅延などの数値は配信中に毎回見るものではないので、ホームの表示モードではなく外観の設定1つで出し分ける。
// 保存先は以前の「かんたん／詳細」と同じキーで、詳細表示を使っていた人はそのまま数値が出る。
export function NumericDetailsSwitch() {
    const t = useMessages();
    const [isBeginnerMode, setIsBeginnerMode] = useBeginnerMode();
    return <div className="mb-3 space-y-1 text-ui-support">
        <div className="flex items-center gap-3">
            <Label className="text-ui-control" htmlFor="numeric-details">{t('details.label')}</Label>
            <Switch id="numeric-details" checked={!isBeginnerMode} onCheckedChange={checked => setIsBeginnerMode(!checked)} aria-describedby="numeric-details-hint" />
            <InfoPopover label={t('details.label')}>{t('details.hint')}</InfoPopover>
        </div>
        <span id="numeric-details-hint" className="sr-only">{t('details.hint')}</span>
    </div>;
}

// 本番帯のオーロラは飾りなので、ホームには切替を置かず外観の設定でだけ出し分ける（DESIGN.md 5.1）。
export function AuroraDisplaySwitch() {
    const t = useMessages();
    const [shown, setShown] = useAuroraDisplay();
    return <div className="mb-3 space-y-1 text-ui-support">
        <div className="flex items-center gap-3">
            <Label className="text-ui-control" htmlFor="aurora-display">{t('aurora.label')}</Label>
            <Switch id="aurora-display" checked={shown} onCheckedChange={setShown} aria-describedby="aurora-display-hint" />
            <InfoPopover label={t('aurora.label')}>{t('aurora.hint')}</InfoPopover>
        </div>
        <p id="aurora-display-hint" className="text-muted-foreground">{t('aurora.hint')}</p>
    </div>;
}
