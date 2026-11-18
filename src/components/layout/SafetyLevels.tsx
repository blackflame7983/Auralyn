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

/** 右の列の出力。一言、ミュート、機器名、ピークの dBFS。横メーターは置かない（#724）。音量スライダーは続けて置く。 */
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
    const verdictText = !muted && verdict ? (verdict === 'high' ? t('home.levelHigh') : verdict === 'low' ? t('home.levelLow') : t('home.levelOk')) : null;
    return <div className="flex shrink-0 flex-col gap-1.5">
        {/* ミュートの札は見出しの行の右に出し、判定の代わりにする。音が出ないので判定は出さない。
            ミュートでないときは札の行を残さない（#580）。狭い列では札を折り返し、文字は省略しない。 */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="shrink-0 text-ui-control font-medium">{t('meter.output')}</h3>
            {muted ? <span className="ml-auto inline-flex min-w-0 max-w-full items-center">
                <button type="button" onClick={event => onCheckOutput?.(event.currentTarget)}
                    title={t('prep.muteRelease')} className="inline-flex max-w-full items-start gap-1 whitespace-normal rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-left text-ui-support font-bold text-warning">
                    <MdVolumeOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span className="[overflow-wrap:anywhere]">{t('prep.muted')}</span>
                </button>
            </span> : verdictText && <span className="inline-flex h-5 min-w-0 flex-1 items-center justify-end">
                <span data-output-verdict={verdict} className="inline-flex min-w-0 items-center gap-1 text-ui-support font-medium">
                    <span aria-hidden="true" className={cn('h-2 w-4 shrink-0 rounded-full', verdict === 'high' ? 'bg-meter-warning' : verdict === 'low' ? 'bg-muted-foreground' : 'bg-success')} />
                    <span className="truncate">{verdictText}</span>
                </span>
            </span>}
        </div>
        <DeviceName name={name} />
        {/* 停止中のピークは数字にせず、横線だけにする。停止であることは読み上げに残す（#602）。大きさのバーはいまの状態に1本（#724）。 */}
        <p className="flex items-baseline justify-end gap-1.5 whitespace-nowrap text-ui-support text-muted-foreground">
            <span aria-hidden="true">{t('home.peakLabel')}</span>
            <span className="sr-only">{t(reading.state === 'stopped' ? 'home.outputPeakStopped' : 'home.outputPeak')}{' '}</span>
            <span className="font-mono tabular-nums">{reading.state === 'stopped' ? '—' : `${formatPeakDbfs(peakHold)} dBFS`}</span>
        </p>
    </div>;
}
