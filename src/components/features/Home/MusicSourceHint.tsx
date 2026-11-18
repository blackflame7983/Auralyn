import { useSustained } from '@/hooks/useSustained';
import { useMessages } from '@/i18n/LocaleProvider';
import { cablePlaybackName } from '@/lib/audioRouting';
import { useInputMeterState } from '../LevelMeter/MeterContext';

/** 再生元から音が届いていない状態が、この時間続いたときだけ案内を出す。曲の合間の無音では出さない。 */
export const SOURCE_HINT_AFTER_MS = 5000;

/**
 * 音楽鑑賞で、再生元（仮想ケーブルなどの機器）から音が届かないときの一行の案内。
 * 再生アプリの出力先を、再生元と対になる側へ向けるよう伝える。届いているとき・停止中は出さない。
 * アプリの音声を再生元にしているときは、アプリから直接受けるので出さない。
 * 再生元がアプリの音声かどうか判定できない（null）間も、出し過ぎないよう出さない。
 */
export function MusicSourceHint({ running, source, fromApp }: { running: boolean; source?: string | null; fromApp: boolean | null }) {
    const t = useMessages();
    const state = useInputMeterState(running);
    const quiet = running && fromApp === false && (state === 'waiting' || state === 'stale' || state === 'silent');
    const shown = useSustained(quiet, SOURCE_HINT_AFTER_MS);
    if (!shown) return null;
    const playback = cablePlaybackName(source);
    return <p data-music-source-hint="" className="mt-1 text-ui-support text-muted-foreground">
        {playback ? t('music.sourceHint', { name: playback }) : t('music.sourceHintGeneric')}
    </p>;
}
