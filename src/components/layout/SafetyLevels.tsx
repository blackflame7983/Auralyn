import { MdVolumeOff } from 'react-icons/md';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';
import { cn } from '@/lib/utils';
import { formatPeakDbfs, outputVerdict } from '@/lib/outputVerdict';
import { InputGainControl } from '../features/Home/InputGainControl';
import { useSharedMeter } from '../features/LevelMeter/MeterContext';
import { MeterVisual } from '../features/LevelMeter/MeterVisual';

function DeviceName({ name }: { name?: string }) {
    if (!name) return null;
    const text = deviceDisplayName(name);
    return <p className="truncate text-ui-support text-muted-foreground" title={text}>{text}</p>;
}

/** メーター購読を子に閉じ、マイク音量の再描画をレベル更新から分ける。 */
function InputMeter({ running, music }: { running: boolean; music: boolean }) {
    const t = useMessages();
    const [simple] = useBeginnerMode();
    const reading = useSharedMeter(running, 'input');
    return <MeterVisual reading={reading} label={t(music ? 'music.source' : 'home.inputLevel')} orientation="horizontal" height={16} fill="aurora" showValues statusOverlay numbers={!simple} />;
}

/** 右の列の入力。見出し、機器名、横メーター、マイク音量。 */
export function SafetyInput({ running, music, name }: { running: boolean; music: boolean; name?: string }) {
    const t = useMessages();
    return <div className="flex shrink-0 flex-col gap-1.5">
        <h3 className="text-ui-control font-medium">{t(music ? 'music.source' : 'unsetFlow.mic')}</h3>
        <DeviceName name={name} />
        <InputMeter running={running} music={music} />
        <InputGainControl />
    </div>;
}

/** 右の列の出力。一言、ミュート、機器名、横メーター、ピークの dBFS。音量スライダーは続けて置く。 */
export function SafetyOutput({ running, name, muted, onCheckOutput }: {
    running: boolean;
    name?: string;
    muted: boolean;
    onCheckOutput?: (anchor: HTMLButtonElement) => void;
}) {
    const t = useMessages();
    const reading = useSharedMeter(running, 'output');
    const peakHold = Math.max(...reading.peak);
    const verdict = outputVerdict({ state: reading.state, smoothed: Math.max(...reading.levels), peakHold });
    const verdictText = verdict === 'high' ? t('home.levelHigh') : verdict === 'low' ? t('home.levelLow') : verdict === 'ok' ? t('home.levelOk') : null;
    return <div className="flex shrink-0 flex-col gap-1.5">
        {/* 札は列の幅で折り返す。非表示のときも同じ高さを取り、メーターの位置を動かさない。 */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="shrink-0 text-ui-control font-medium">{t('meter.output')}</h3>
            <span className="inline-flex h-5 min-w-0 flex-1 items-center justify-end">
                {verdictText && <span data-output-verdict={verdict} className="inline-flex min-w-0 items-center gap-1 text-ui-support font-medium">
                    <span aria-hidden="true" className={cn('h-2 w-4 shrink-0 rounded-full', verdict === 'high' ? 'bg-meter-warning' : verdict === 'low' ? 'bg-muted-foreground' : 'bg-success')} />
                    <span className="truncate">{verdictText}</span>
                </span>}
            </span>
            <span role="status" aria-hidden={!muted} className={cn('inline-flex w-full items-center', muted ? '' : 'invisible')}>
                <button type="button" onClick={event => onCheckOutput?.(event.currentTarget)} tabIndex={muted ? 0 : -1}
                    title={t('prep.checkOutput')} className="inline-flex max-w-full items-start gap-1 whitespace-normal rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-left text-ui-support font-bold text-warning">
                    <MdVolumeOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span className="[overflow-wrap:anywhere]">{t('prep.muted')}</span>
                </button>
            </span>
        </div>
        <DeviceName name={name} />
        <MeterVisual reading={reading} label={t('meter.output')} orientation="horizontal" height={16} fill="aurora" showValues statusOverlay numbers={false} />
        <p className="text-right font-mono text-ui-support tabular-nums text-muted-foreground" aria-label={t('home.outputPeak')}>{formatPeakDbfs(peakHold)} dBFS</p>
    </div>;
}
