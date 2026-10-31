import { useDisplayPurpose, type DisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useAuroraDisplay } from '@/hooks/useAuroraDisplay';
import { useMessages } from '@/i18n/LocaleProvider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

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

// 遅延などの数値は配信中に毎回見るものではないので、ホームの表示モードではなく外観の設定1つで出し分ける。
// 保存先は以前の「かんたん／詳細」と同じキーで、詳細表示を使っていた人はそのまま数値が出る。
export function NumericDetailsSwitch() {
    const t = useMessages();
    const [isBeginnerMode, setIsBeginnerMode] = useBeginnerMode();
    return <div className="mb-3 space-y-1 text-sm">
        <div className="flex items-center gap-3">
            <Label htmlFor="numeric-details">{t('details.label')}</Label>
            <Switch id="numeric-details" checked={!isBeginnerMode} onCheckedChange={checked => setIsBeginnerMode(!checked)} aria-describedby="numeric-details-hint" />
        </div>
        <p id="numeric-details-hint" className="text-xs text-muted-foreground">{t('details.hint')}</p>
    </div>;
}

// 本番帯のオーロラは飾りなので、ホームには切替を置かず外観の設定でだけ出し分ける（DESIGN.md 5.1）。
export function AuroraDisplaySwitch() {
    const t = useMessages();
    const [shown, setShown] = useAuroraDisplay();
    return <div className="mb-3 space-y-1 text-sm">
        <div className="flex items-center gap-3">
            <Label htmlFor="aurora-display">{t('aurora.label')}</Label>
            <Switch id="aurora-display" checked={shown} onCheckedChange={setShown} aria-describedby="aurora-display-hint" />
        </div>
        <p id="aurora-display-hint" className="text-xs text-muted-foreground">{t('aurora.hint')}</p>
    </div>;
}
