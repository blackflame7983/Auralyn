import type { ReactNode } from 'react';
import { MdArrowForward, MdMic, MdMusicNote, MdVolumeOff } from 'react-icons/md';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { meterStatusLabel } from '@/hooks/useMeterLevels';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import type { PreparationUse } from '@/lib/preparation';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';
import { InputGainControl } from './InputGainControl';
import { deviceDisplayName } from '@/lib/audioRouting';

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// 本番中に見る3つ（声のレベル、送り先、歌・雑談）だけを最上段に置く（DESIGN.md 1.3、2.5）。
// 入力機器の名前は送り先の手前に1つだけ出し、押すと機器の設定を開く。確認の手順は準備状況に任せる。
export function LiveStrip({ model, running, liveControls, meterAction, onOpenDevices, inputName, outputName }: {
    model: PreparationModel; running: boolean; liveControls?: ReactNode; meterAction?: ReactNode; onOpenDevices?: () => void;
    /** 準備の観測で機器を取れない間に使う、AppShell が持つ機器名。 */
    inputName?: string; outputName?: string;
}) {
    const t = useMessages();
    const reading = useSharedMeter(running, 'input');
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage, receiver } = model.context;
    const muted = model.observation.availability === 'muted';
    const Icon = music ? MdMusicNote : MdMic;
    const input = model.observation.config?.input ?? inputName;
    const output = model.observation.config?.output ?? outputName;
    const devices = t('live.devices', { input: input ? deviceDisplayName(input) : t('flow.unknown'), output: output ? deviceDisplayName(output) : t('flow.unknown') });
    return <section aria-label={t('live.strip')} className="aurora-card aurora-edge aurora-glow-live mb-4 space-y-3 rounded-xl border border-border bg-card/70 px-4 py-4 min-[1100px]:px-5">
        <div className="flex items-center gap-3">
            <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <MeterVisual reading={reading} label={t(music ? 'wizard.musicLevel' : 'home.inputLevel')} orientation="horizontal" height={32} scale showValues />
            {/* 無音は「声が来ていない」本番事故の手がかりなので、dBFS 値だけにせず言葉でも示す。 */}
            {reading.state !== 'live' && <span className="w-24 shrink-0 text-xs text-muted-foreground">{t(meterStatusLabel(reading.state))}</span>}
            {/* マイク音量と音量チェックはメーターに関わる操作なので、上部に単独で置かずメーターの横に置く。 */}
            <InputGainControl />
            {meterAction}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {input && onOpenDevices && <button type="button" onClick={onOpenDevices} aria-label={devices} title={devices}
                className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md text-sm hover:text-foreground">
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-semibold">{deviceDisplayName(input)}</span>
            </button>}
            <p className="flex min-w-0 items-center gap-1.5 text-sm">
                <MdArrowForward aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">{t('live.destination')}</span>
                <span className="truncate font-semibold" title={receiver || undefined}>{usage ? t(destinations[usage]) : t('live.noDestination')}{usage && usage !== 'listening' && receiver ? ` · ${receiver}` : ''}</span>
            </p>
            {muted && <span role="status" className="inline-flex items-center gap-1 rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-xs font-bold text-warning">
                <MdVolumeOff aria-hidden="true" className="h-4 w-4" />{t('prep.muted')}
            </span>}
            {liveControls && <div className="min-w-0 flex-1">{liveControls}</div>}
        </div>
    </section>;
}
