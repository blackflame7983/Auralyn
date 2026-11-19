import type { Ref } from 'react';
import { MdExpandMore } from 'react-icons/md';
import { Button } from '@/components/ui/button';
import { ChoiceCard } from '@/components/ui/ChoiceCard';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { destinationChoices } from '@/lib/destinationChoices';
import { cn } from '@/lib/utils';
import { useMessages } from '@/i18n/LocaleProvider';
import { isPreparationUse, type PreparationUse } from '@/lib/preparation';

// 選択の確定は onActivate が持つ。矢印で移った先のラジオを、未選択のまま保つ。
const keepUnset = () => undefined;

interface ChangeProps {
    usage: PreparationUse | '';
    /** 送り先を変えると、受け側の名前と確認の記録が外れる（usePreparation の changeContext）。 */
    onChange: (usage: PreparationUse) => void;
}

/** 送り先の行の「変更」。押すと4つの送り先を選ぶ小さなメニューを開く。選び直しでは何も変えない。 */
export function DestinationMenu({ usage, onChange, triggerRef }: ChangeProps & { triggerRef?: Ref<HTMLButtonElement> }) {
    const t = useMessages();
    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button ref={triggerRef} type="button" variant="outline" size="sm" aria-label={t('prep.changeDestinationLabel')} className="h-7 gap-1 px-2">
                {t('prep.changeDestination')}<MdExpandMore aria-hidden="true" className="h-4 w-4" />
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="whitespace-normal text-ui-support font-normal text-muted-foreground">{t('prep.destinationNote')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={usage} onValueChange={value => { if (isPreparationUse(value) && value !== usage) onChange(value); }}>
                {destinationChoices.map(({ value, label, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{t(label)}
                </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
        </DropdownMenuContent>
    </DropdownMenu>;
}

/** 送り先が未選択のときだけ、4択をパネルの中にそのまま開いて出す。中身は標準のラジオボタンで、矢印キーと読み上げを保つ。
 *  矢印キーは焦点を動かすだけで、クリック・Enter・Space で決める（「変更」のメニューと同じ）。 */
export function DestinationPicker({ usage, onChange, pickerRef, name, highlighted }: ChangeProps & { pickerRef: Ref<HTMLDivElement>; name: string; highlighted: boolean }) {
    const t = useMessages();
    const labelId = `${name}-label`;
    return <div className="space-y-1 text-ui-support">
        <p id={labelId}>{t('prep.destinationPrompt')}</p>
        <div ref={pickerRef} role="radiogroup" aria-labelledby={labelId} className={cn('grid gap-2 sm:grid-cols-2', highlighted && 'rounded-card ring-1 ring-primary/60 p-1')}>
            {destinationChoices.map(({ value, label, icon: Icon }) => <ChoiceCard key={value} name={name} value={value} checked={usage === value}
                onChange={keepUnset} onActivate={() => onChange(value)}>
                <span className="flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4 shrink-0" /><span>{t(label)}</span></span>
            </ChoiceCard>)}
        </div>
    </div>;
}
