import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useMessages } from '@/i18n/LocaleProvider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/InfoPopover';

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
