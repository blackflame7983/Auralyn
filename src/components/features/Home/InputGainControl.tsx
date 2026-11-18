import { Button } from '@/components/ui/button';
import { useInputGain } from '@/hooks/useInputGain';
import { Slider } from '@/components/ui/slider';
import { useMessages } from '@/i18n/LocaleProvider';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';

// マイク音量は右の列の入力メーターの下に置く。スライダーと割合を常に見せる。
// 大型メーターやプロファイル適用とは 'input-gain-sync' で同期する。
export function InputGainControl({ disabled = false, fromApp = false }: { disabled?: boolean; fromApp?: boolean }) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const label = t(purpose === 'music' || fromApp ? 'home.inputGain' : 'header.inputGain');
    const { inputGain, failed, change } = useInputGain();

    return <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center justify-between gap-2 text-ui-support text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 font-mono tabular-nums">{inputGain}%</span>
        </div>
        <Slider aria-label={`${label} ${inputGain}%`} aria-valuetext={`${inputGain}%`} value={[inputGain]} max={200} step={1}
            disabled={disabled} onValueChange={change} onDoubleClick={() => change([100])} />
        {(inputGain !== 100 || failed) && <Button variant="outline" size="sm" type="button" disabled={inputGain === 100 && !failed} onClick={() => change([inputGain === 100 ? inputGain : 100])}>{t('header.inputGainHint')}</Button>}
        {failed && <div className="space-y-2">
            <p role="alert" className="text-ui-support text-warning">{t('home.inputGainFailed')}</p>
            <Button variant="outline" size="sm" type="button" onClick={() => change([inputGain])}>{t('common.retry')}</Button>
        </div>}
    </div>;
}
