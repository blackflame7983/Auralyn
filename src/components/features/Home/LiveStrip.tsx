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

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// 本番中に見る3つ（声のレベル、送り先、歌・雑談）だけを最上段に置く（DESIGN.md 1.3、2.5）。
// 機器名や確認の手順は準備状況に任せ、ここでは繰り返さない。
export function LiveStrip({ model, running, liveControls, meterAction }: { model: PreparationModel; running: boolean; liveControls?: ReactNode; meterAction?: ReactNode }) {
    const t = useMessages();
    const reading = useSharedMeter(running, 'input');
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage, receiver } = model.context;
    const muted = model.observation.availability === 'muted';
    const Icon = music ? MdMusicNote : MdMic;
    return <section aria-label={t('live.strip')} className="aurora-card aurora-edge aurora-glow-live mb-3 space-y-2 rounded-xl border border-border bg-card/70 p-3 min-[1280px]:col-span-2">
        <div className="flex items-center gap-3">
            <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <MeterVisual reading={reading} label={t(music ? 'wizard.musicLevel' : 'home.inputLevel')} orientation="horizontal" height={24} scale showValues />
            {/* 無音は「声が来ていない」本番事故の手がかりなので、dBFS 値だけにせず言葉でも示す。 */}
            {reading.state !== 'live' && <span className="w-24 shrink-0 text-xs text-muted-foreground">{t(meterStatusLabel(reading.state))}</span>}
            {/* マイク音量と音量チェックはメーターに関わる操作なので、上部に単独で置かずメーターの横に置く。 */}
            <InputGainControl />
            {meterAction}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
