import { InfoPopover } from '@/components/ui/InfoPopover';
import { useMessages } from '@/i18n/LocaleProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { audioApi, type BuiltInEffectsPreset, type EngineRuntimeStats, type NoiseControlMode } from '@/api/audio';
import { builtinApi } from '@/api/builtinEffects';

const STATS_INTERVAL_MS = 2000;
const quickPresets: BuiltInEffectsPreset[] = ['broadcast', 'warm', 'bright'];

// チェーン列のノイズ低減・内蔵ボイスチェーンの段で、よく使う声の調整だけを直接操作する。
// 学習・会場・声を守る・歌向けなどの細かい調整は、設定の音づくりで行う。
// enabled が false の間（音声未準備・音楽鑑賞）は状態を取りに行かない。
export function useVoiceQuick(running: boolean, enabled = true) {
    const t = useMessages();
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState<number | null>(null);
    const generation = useRef(0);
    // 無効にした後に終わった操作の再取得で、古い状態を残さない。
    const active = useRef(enabled);
    active.current = enabled;

    const refresh = useCallback(async () => {
        if (!active.current) return;
        const request = ++generation.current;
        try {
            const next = await audioApi.getEngineRuntimeStats();
            if (request === generation.current && active.current) setStats(next);
        } catch {
            if (request === generation.current && active.current) setStats(null);
        }
    }, []);

    useEffect(() => {
        if (!enabled) { generation.current++; setStats(null); return; }
        void refresh();
        const timer = setInterval(() => { if (!document.hidden) void refresh(); }, STATS_INTERVAL_MS);
        const onExternal = () => void refresh();
        window.addEventListener('profile-fx-applied', onExternal);
        const subscriptions = ['audio-started', 'audio-stopped'].map(event => listen(event, onExternal));
        return () => {
            generation.current++;
            clearInterval(timer);
            window.removeEventListener('profile-fx-applied', onExternal);
            subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {}));
        };
    }, [refresh, running, enabled]);

    const run = async (action: () => Promise<unknown>, success: string) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
            await refresh();
            // 音づくりタブや歌向けの下書きへ、外部で値が変わったことを知らせる。
            window.dispatchEvent(new CustomEvent('profile-fx-applied'));
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
    const commitAmount = () => { if (amount !== null) { const value = amount; setAmount(null); void applyChain({ amount: value }); } };

    return { stats, disabled: !stats || busy, noiseOn, noiseMode, applyNoise, chainOn, preset, shownAmount, setAmount, commitAmount, toggleChain, applyChain };
}
export type VoiceQuick = ReturnType<typeof useVoiceQuick>;

const segment = (selected: boolean) => cn('whitespace-nowrap rounded-md border px-2 py-2 text-[13px] font-bold transition-colors disabled:opacity-50',
    selected ? 'border-selection bg-selection/15 text-selection' : 'border-input bg-background text-muted-foreground hover:text-foreground');

// 段の見出し行の右端に置くスイッチ。
export function NoiseSwitch({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    return <span className="flex items-center gap-1">
        <InfoPopover label={t('info.noise')}>{t('home.noiseScope')}</InfoPopover>
        <Switch checked={q.noiseOn} disabled={q.disabled} onCheckedChange={active => void q.applyNoise({ active })} aria-label={t('settings.AudioSettingsModal.107')} />
    </span>;
}

export function NoiseQuick({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    if (q.noiseMode === 'smart' || q.noiseMode === 'venue') {
        return <p className="text-xs text-muted-foreground">{t('home.noiseAdvancedMode', { mode: q.noiseMode === 'smart' ? t('master.nrLearn') : t('master.nrVenue') })}</p>;
    }
    return <div role="group" aria-label={t('structure.noise.standard')} className="grid grid-cols-2 gap-1.5">
        {(['low', 'high'] as NoiseControlMode[]).map(mode => (
            <button key={mode} type="button" disabled={q.disabled || !q.noiseOn} aria-pressed={q.noiseOn && q.noiseMode === mode}
                onClick={() => void q.applyNoise({ mode })} className={segment(q.noiseOn && q.noiseMode === mode)}>
                {mode === 'low' ? t('master.nrLow') : t('master.nrHigh')}
            </button>
        ))}
    </div>;
}

export function BuiltinSwitch({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    return <Switch checked={q.chainOn} disabled={q.disabled} onCheckedChange={active => void q.toggleChain(active)} aria-label={t('settings.AudioSettingsModal.097')} />;
}

export function BuiltinQuick({ q }: { q: VoiceQuick }) {
    const t = useMessages();
    if (q.preset === 'singing') return <p className="text-xs text-muted-foreground">{t('home.chainSinging')}</p>;
    const presetLabel = (value: BuiltInEffectsPreset) => value === 'broadcast' ? t('settings.AudioSettingsModal.098')
        : value === 'warm' ? t('settings.AudioSettingsModal.099') : t('settings.AudioSettingsModal.100');
    return <div className="space-y-2">
        <div role="group" aria-label={t('home.chainPreset')} className="flex flex-wrap gap-1.5">
            {quickPresets.map(value => (
                <button key={value} type="button" disabled={q.disabled} aria-pressed={q.chainOn && q.preset === value}
                    onClick={() => void q.applyChain({ preset: value })} className={cn(segment(q.chainOn && q.preset === value), 'flex-1 whitespace-nowrap')}>
                    {presetLabel(value)}
                </button>
            ))}
        </div>
        <label className="block space-y-1.5 text-[13px]">
            <span className="flex justify-between gap-2 text-muted-foreground">
                <span className="whitespace-nowrap">{t('settings.AudioSettingsModal.103')}</span>
                <span className="font-mono text-foreground">{q.shownAmount}%</span>
            </span>
            <input type="range" min={0} max={100} step={5} value={q.shownAmount} disabled={q.disabled || !q.chainOn}
                onChange={event => q.setAmount(Number(event.target.value))} onPointerUp={q.commitAmount} onKeyUp={q.commitAmount} onBlur={q.commitAmount}
                aria-label={t('settings.AudioSettingsModal.104')} className="w-full accent-primary" />
        </label>
    </div>;
}
