import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { useDisplayPurpose, type DisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useMessages } from '@/i18n/LocaleProvider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/InfoPopover';

// 接続のページの先頭に置く。表示だけを保存し、入力の用途は自動では変えない。
export function DisplayPurposeSelector({ onChanged }: { onChanged?: (purpose: DisplayPurpose) => void }) {
    const t = useMessages();
    const [purpose, setPurpose] = useDisplayPurpose();
    return <div className="mb-3 flex flex-wrap items-center gap-2 text-ui-support">
        <Field label={t('purpose.label')} description={t('purpose.hint')}>
            <Select value={purpose} onChange={event => {
                const next = event.target.value as DisplayPurpose;
                setPurpose(next);
                onChanged?.(next);
            }}>
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
