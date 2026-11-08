import { useMessages } from '@/i18n/LocaleProvider';
import { useRef, useState } from 'react';
import { refreshRuntimeStats, useRuntimeStats } from '@/hooks/useRuntimeStats';
import { toast } from 'sonner';
import { SliderField } from '@/components/ui/SliderField';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { audioApi, type BuiltInEffectsPreset, type NoiseControlMode } from '@/api/audio';
import { builtinApi } from '@/api/builtinEffects';

const quickPresets: BuiltInEffectsPreset[] = ['broadcast', 'warm', 'bright'];

// チェーン列のノイズ低減・内蔵ボイスチェーンの段で、よく使う声の調整だけを直接操作する。
// 学習・会場・声を守る・歌向けなどの細かい調整は、設定の音づくりで行う。
// enabled が false の間（音声未準備・音楽鑑賞）は状態を取りに行かない。
export function useVoiceQuick(_running: boolean, enabled = true) {
    const t = useMessages();
    const stats = useRuntimeStats(enabled);
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState<number | null>(null);
    const active = useRef(enabled);
    active.current = enabled;
    const refresh = async () => { if (active.current) await refreshRuntimeStats(true); };

    const run = async (action: () => Promise<unknown>, success: string) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
            await refresh();
            // 音づくりタブや歌向けの下書きへ、外部で値が変わったことを知らせる。
            window.dispatchEvent(new CustomEvent('profile-fx-applied', { detail: { runtimeStatsRefreshed: active.current } }));
            toast.success(success);
        } catch (error) {
            console.error('Failed to apply quick voice setting', error);
            toast.error(t('home.applyFailed'));
        } finally {
            setBusy(false);
        }
    };

    const noiseMode = (stats?.noiseReductionMode?.toLowerCase() ?? 'low') as NoiseControlMode;
    const noiseOn = !!stats?.noiseReductionEnabled;
    const applyNoise = (next: { active?: boolean; mode?: NoiseControlMode }) => stats && run(() => audioApi.setNoiseControlConfig({
        active: next.active ?? noiseOn,
        mode: next.mode ?? noiseMode,
        strength: stats.noiseControlStrength > 0 ? stats.noiseControlStrength : 0.8,
        voiceGuard: stats.noiseVoiceGuard ?? true,
    }), (next.active ?? noiseOn) ? t('settings.AudioSettingsModal.002') : t('settings.AudioSettingsModal.003'));

    const chainOn = !!stats?.builtInEffectsEnabled;
    const preset = (stats?.builtInEffectsPreset ?? 'broadcast') as BuiltInEffectsPreset;
    const shownAmount = amount ?? Math.round((stats?.builtInEffectsAmount ?? 0.7) * 100);
    // ON/OFFは適用済みの設定（歌向けの値・残響）を保持したまま切り替える。
    const toggleChain = (active: boolean) => run(async () => {
        const current = await builtinApi.request({ action: 'snapshot' });
        await builtinApi.request({ action: 'apply', epoch: current.epoch, expectedRevision: current.revision, config: { ...current.config, active } });
    }, active ? t('settings.AudioSettingsModal.008') : t('settings.AudioSettingsModal.009'));
    const applyChain = (next: { preset?: BuiltInEffectsPreset; amount?: number }) => run(() => audioApi.setBuiltInEffects({
        active: true,
        preset: next.preset ?? preset,
        amount: Math.max(0, Math.min(100, next.amount ?? shownAmount)) / 100,
    }), t('settings.AudioSettingsModal.008'));
    const commitAmount = (value: number) => { setAmount(null); void applyChain({ amount: value }); };

    return { stats, disabled: !stats || busy, noiseOn, noiseMode, applyNoise, chainOn, preset, shownAmount, setAmount, commitAmount, toggleChain, applyChain };
}
export type VoiceQuick = ReturnType<typeof useVoiceQuick>;

// 段の見出し行の右端に置くスイッチ。
export function NoiseSwitch({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    return <span className="flex items-center gap-1">
        <Switch checked={q.noiseOn} disabled={q.disabled} onCheckedChange={active => void q.applyNoise({ active })} aria-label={t('settings.AudioSettingsModal.107')} />
    </span>;
}

export function NoiseQuick({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    if (q.noiseMode === 'smart' || q.noiseMode === 'venue') {
        return <p className="text-ui-support text-muted-foreground">{t('home.noiseAdvancedMode', { mode: q.noiseMode === 'smart' ? t('master.nrLearn') : t('master.nrVenue') })}</p>;
    }
    return <SegmentedControl label={t('structure.noise.standard')}
        options={(['low', 'high'] as NoiseControlMode[]).map(mode => ({ value: mode, label: mode === 'low' ? t('master.nrLow') : t('master.nrHigh'), disabled: q.disabled }))}
        value={q.noiseMode} onValueChange={mode => void q.applyNoise({ mode })} />;
}

export function BuiltinSwitch({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    return <Switch checked={q.chainOn} disabled={q.disabled} onCheckedChange={active => void q.toggleChain(active)} aria-label={t('settings.AudioSettingsModal.097')} />;
}

export function BuiltinQuick({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    if (q.preset === 'singing') return <p className="text-ui-support text-muted-foreground">{t('home.chainSinging')}</p>;
    const presetLabel = (value: BuiltInEffectsPreset) => value === 'broadcast' ? t('settings.AudioSettingsModal.098')
        : value === 'warm' ? t('settings.AudioSettingsModal.099') : t('settings.AudioSettingsModal.100');
    // 5%刻みの操作に十分な長さを保ち、広い窓でもスライダーだけを伸ばし続けない。
    return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl label={t('home.chainPreset')}
            options={quickPresets.map(value => ({ value, label: presetLabel(value), disabled: q.disabled,
                hint: t(value === 'warm' ? 'home.preset.warmHint' : value === 'bright' ? 'home.preset.brightHint' : 'home.preset.broadcastHint') }))}
            value={q.chainOn ? q.preset : null} onValueChange={preset => void q.applyChain({ preset })} />
        <div className="min-w-[10rem] max-w-[15rem] flex-1">
            <SliderField label={t('settings.AudioSettingsModal.104')} min={0} max={100} step={5} value={q.shownAmount}
                disabled={q.disabled || !q.chainOn} formatValue={value => `${value}%`}
                onValueChange={q.setAmount} onValueCommit={q.commitAmount} />
        </div>
    </div>;
}
