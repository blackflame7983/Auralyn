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

// かんたん表示のメインで、よく使う声の調整だけを直接操作する。
// 学習・会場・声を守る・歌向けなどの細かい調整は、設定の音づくりで行う。
export function VoiceQuickControls({ running, onOpenSoundSettings }: { running: boolean; onOpenSoundSettings?: () => void }) {
    const t = useMessages();
    const [stats, setStats] = useState<EngineRuntimeStats | null>(null);
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState<number | null>(null);
    const generation = useRef(0);

    const refresh = useCallback(async () => {
        const request = ++generation.current;
        try {
            const next = await audioApi.getEngineRuntimeStats();
            if (request === generation.current) setStats(next);
        } catch {
            if (request === generation.current) setStats(null);
        }
    }, []);

    useEffect(() => {
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
    }, [refresh, running]);

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

    const presetLabel = (value: BuiltInEffectsPreset) => value === 'broadcast' ? t('settings.AudioSettingsModal.098')
        : value === 'warm' ? t('settings.AudioSettingsModal.099') : value === 'bright' ? t('settings.AudioSettingsModal.100') : t('home.presetSinging');
    const segment = (selected: boolean) => cn('rounded-md border px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50',
        selected ? 'border-primary bg-primary/15 text-primary' : 'border-input bg-background text-muted-foreground hover:text-foreground');
    const disabled = !stats || busy;

    return (
        <div className="space-y-3">
            {!stats && <p role="status" className="text-xs text-muted-foreground">{t('home.voiceUnavailable')}</p>}
            <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{t('settings.AudioSettingsModal.105')}</span>
                        <Switch checked={noiseOn} disabled={disabled} onCheckedChange={active => void applyNoise({ active })} aria-label={t('settings.AudioSettingsModal.107')} />
                    </div>
                    {noiseMode === 'smart' || noiseMode === 'venue' ? (
                        <p className="text-xs text-muted-foreground">{t('home.noiseAdvancedMode', { mode: noiseMode === 'smart' ? t('master.nrLearn') : t('master.nrVenue') })}</p>
                    ) : (
                        <div role="group" aria-label={t('structure.noise.standard')} className="grid grid-cols-2 gap-2">
                            {(['low', 'high'] as NoiseControlMode[]).map(mode => (
                                <button key={mode} type="button" disabled={disabled || !noiseOn} aria-pressed={noiseOn && noiseMode === mode}
                                    onClick={() => void applyNoise({ mode })} className={segment(noiseOn && noiseMode === mode)}>
                                    {mode === 'low' ? t('master.nrLow') : t('master.nrHigh')}
                                </button>
                            ))}
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t('home.noiseScope')}</p>
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{t('settings.AudioSettingsModal.095')}</span>
                        <Switch checked={chainOn} disabled={disabled} onCheckedChange={active => void toggleChain(active)} aria-label={t('settings.AudioSettingsModal.097')} />
                    </div>
                    {preset === 'singing' ? (
                        <p className="text-xs text-muted-foreground">{t('home.chainSinging')}</p>
                    ) : (<>
                        <div role="group" aria-label={t('home.chainPreset')} className="grid grid-cols-3 gap-2">
                            {quickPresets.map(value => (
                                <button key={value} type="button" disabled={disabled} aria-pressed={chainOn && preset === value}
                                    onClick={() => void applyChain({ preset: value })} className={segment(chainOn && preset === value)}>
                                    {presetLabel(value)}
                                </button>
                            ))}
                        </div>
                        <label className="block space-y-1 text-xs">
                            <span className="flex justify-between text-muted-foreground">
                                <span>{t('settings.AudioSettingsModal.103')}</span>
                                <span className="font-mono text-foreground">{shownAmount}%</span>
                            </span>
                            <input type="range" min={0} max={100} step={5} value={shownAmount} disabled={disabled || !chainOn}
                                onChange={event => setAmount(Number(event.target.value))} onPointerUp={commitAmount} onKeyUp={commitAmount} onBlur={commitAmount}
                                aria-label={t('settings.AudioSettingsModal.104')} className="w-full accent-primary" />
                        </label>
                    </>)}
                </div>
            </div>
            {onOpenSoundSettings && (
                <button type="button" onClick={onOpenSoundSettings} className="text-xs font-semibold text-primary underline underline-offset-2 hover:opacity-80">
                    {t('home.moreSound')}
                </button>
            )}
        </div>
    );
}
