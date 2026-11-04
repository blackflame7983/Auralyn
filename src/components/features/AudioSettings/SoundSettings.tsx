import { useEffect, useRef, useState, type RefObject } from 'react';
import { audioApi, type BuiltInEffectsPreset, type EngineRuntimeStats, type NoiseControlMode } from '../../../api/audio';
import { useMessages } from '@/i18n/LocaleProvider';
import { refreshRuntimeStatsChecked } from '@/hooks/useRuntimeStats';
import type { SingingDraft } from '@/hooks/useSingingDraft';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { toast } from 'sonner';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TabsContent } from '@/components/ui/tabs';
import { segmentButtonClass } from '@/components/ui/segment';
import { NoiseMeasurementPanel } from './NoiseMeasurementPanel';
import { PeakProtectionPanel } from './PeakProtectionPanel';
import { SingingControls } from './SingingControls';
import { LiveModeControls } from './LiveModeControls';

export function useSoundSettings(engineStats: EngineRuntimeStats | null, singingModel: SingingDraft, initialSection?: 'liveModes' | 'singing' | 'audioTuning') {
  const t = useMessages();
  const [preparingMode, setPreparingMode] = useState<'singing' | 'talk' | null>(initialSection === 'singing' ? 'singing' : null);
  const [singingOpen, setSingingOpen] = useState(initialSection === 'singing');
  const [peakOpen, setPeakOpen] = useState(false);
  const [noiseMode, setNoiseMode] = useState<NoiseControlMode>('smart');
  const [noiseMeasurementOpen, setNoiseMeasurementOpen] = useState(false);
  const [noiseAdvancedOpen, setNoiseAdvancedOpen] = useState(false);
  const [noiseStrength, setNoiseStrength] = useState(80);
  const [noiseVoiceGuard, setNoiseVoiceGuard] = useState(true);
  const [noiseActionBusy, setNoiseActionBusy] = useState(false);
  const noiseStrengthEditing = useRef(false);
  const [builtInEffectsEnabled, setBuiltInEffectsEnabled] = useState(false);
  const [builtInEffectsPreset, setBuiltInEffectsPreset] = useState<BuiltInEffectsPreset>('broadcast');
  const [builtInEffectsAmount, setBuiltInEffectsAmount] = useState(70);
  const builtInEffectsAmountEditing = useRef(false);

  useEffect(() => {
    if (!engineStats) return;
    const mode = engineStats.noiseReductionMode as NoiseControlMode;
    if (['low', 'high', 'smart', 'venue'].includes(mode)) {
      setNoiseMode(mode);
    }
    setNoiseVoiceGuard(engineStats.noiseVoiceGuard ?? true);
    setBuiltInEffectsEnabled(!!engineStats.builtInEffectsEnabled);
    if (!builtInEffectsAmountEditing.current && Number.isFinite(engineStats.builtInEffectsAmount)) {
      setBuiltInEffectsAmount(Math.round(engineStats.builtInEffectsAmount * 100));
    }
    if (['broadcast', 'warm', 'bright', 'singing'].includes(engineStats.builtInEffectsPreset)) {
      setBuiltInEffectsPreset(engineStats.builtInEffectsPreset as BuiltInEffectsPreset);
    }
    if (!noiseStrengthEditing.current && engineStats.noiseControlStrength > 0) {
      setNoiseStrength(Math.round(engineStats.noiseControlStrength * 100));
    }
  }, [engineStats]);

  // プロファイル適用時にノイズ/内蔵 FX のローカル state を同期
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        noiseControl?: { enabled: boolean; mode: string; strength: number; voiceGuard: boolean };
        builtinFx?: { preset: string; enabled: boolean; amount: number };
      } | undefined;
      if (!detail) return;
      if (detail.noiseControl) {
        const nc = detail.noiseControl;
        if (['low', 'high', 'smart', 'venue'].includes(nc.mode)) setNoiseMode(nc.mode as NoiseControlMode);
        setNoiseStrength(Math.round(nc.strength * 100));
        setNoiseVoiceGuard(nc.voiceGuard);
      }
      if (detail.builtinFx) {
        const fx = detail.builtinFx;
        setBuiltInEffectsEnabled(fx.enabled);
        if (['broadcast', 'warm', 'bright', 'singing'].includes(fx.preset)) setBuiltInEffectsPreset(fx.preset as BuiltInEffectsPreset);
        if (Number.isFinite(fx.amount)) setBuiltInEffectsAmount(Math.round(fx.amount * 100));
      }
    };
    window.addEventListener('profile-fx-applied', handler);
    return () => window.removeEventListener('profile-fx-applied', handler);
  }, []);

  const applyNoiseControlConfig = async (next?: Partial<{ active: boolean; mode: NoiseControlMode; strength: number; voiceGuard: boolean }>) => {
    const active = next?.active ?? !!engineStats?.noiseReductionEnabled;
    const mode = next?.mode ?? noiseMode;
    const strength = next?.strength ?? noiseStrength;
    const voiceGuard = next?.voiceGuard ?? noiseVoiceGuard;
    setNoiseActionBusy(true);
    try {
      await audioApi.setNoiseControlConfig({
        active,
        mode,
        strength: Math.max(25, Math.min(125, strength)) / 100,
        voiceGuard,
      });
      await refreshRuntimeStatsChecked();
      toast.success(active ? t('settings.AudioSettingsModal.002') : t('settings.AudioSettingsModal.003'));
    } catch (e) {
      console.error('Failed to apply noise control config', e);
      toast.error(t('settings.AudioSettingsModal.004'));
    } finally {
      setNoiseActionBusy(false);
    }
  };

  const commitNoiseStrength = (value: string) => {
    if (!noiseStrengthEditing.current) return;
    noiseStrengthEditing.current = false;
    void applyNoiseControlConfig({ strength: Number(value) });
  };

  const applyBuiltInEffects = async (next?: Partial<{ active: boolean; preset: BuiltInEffectsPreset; amount: number }>) => {
    if (singingModel.snapshot && !next?.preset && next?.amount === undefined) {
      await singingModel.setAppliedActive(next?.active ?? singingModel.snapshot.config.active);
      return;
    }
    const active = next?.active ?? singingModel.snapshot?.config.active ?? builtInEffectsEnabled;
    const preset = next?.preset ?? singingModel.snapshot?.config.preset ?? builtInEffectsPreset;
    const amount = next?.amount ?? (singingModel.snapshot ? singingModel.snapshot.config.amount * 100 : builtInEffectsAmount);
    try {
      await audioApi.setBuiltInEffects({
        active,
        preset,
        amount: Math.max(0, Math.min(100, amount)) / 100,
      });
      await refreshRuntimeStatsChecked();
      await singingModel.refresh();
      toast.success(active ? t('settings.AudioSettingsModal.008') : t('settings.AudioSettingsModal.009'));
    } catch (e) {
      console.error('Failed to apply built-in effects', e);
      toast.error(t('settings.AudioSettingsModal.010'));
    }
  };

  const commitBuiltInEffectsAmount = (value: string) => {
    if (!builtInEffectsAmountEditing.current) return;
    builtInEffectsAmountEditing.current = false;
    void applyBuiltInEffects({ amount: Number(value) });
  };

  return { noiseMode, setNoiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, preparingMode, setPreparingMode, singingOpen, setSingingOpen, peakOpen, setPeakOpen };
}

interface SoundSettingsProps {
  model: ReturnType<typeof useSoundSettings>;
  engineStats: EngineRuntimeStats | null;
  singingModel: SingingDraft;
  liveModel: LiveModesModel;
  isBeginnerMode: boolean;
  settingsBody: RefObject<HTMLDivElement | null>;
  soundStart: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onOpenVoiceCheck?: () => void;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
  onOpenMixing: () => void;
}
export function SoundSettings({ model, engineStats, singingModel, liveModel, isBeginnerMode, settingsBody, soundStart, onClose, onOpenVoiceCheck, onPreviewSinging, onSaveSingingProfile, onOpenMixing }: SoundSettingsProps) {
  const t = useMessages();
  const { noiseMode, setNoiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, preparingMode, setPreparingMode, singingOpen, setSingingOpen, peakOpen, setPeakOpen } = model;
  return (
          <TabsContent value="sound" className="space-y-4">
            <div className="flex items-center gap-1 text-xs text-muted-foreground"><InfoPopover label={t('settings.soundHelp')}>{t('settings.AudioSettingsModal.092')}</InfoPopover><span aria-hidden="true">{t('settings.soundHelpShort')}</span></div>
            {!engineStats && <p role="status" className="text-sm text-muted-foreground">{t('settings.AudioSettingsModal.094')}</p>}
            <fieldset disabled={!engineStats || noiseActionBusy} className="min-w-0 space-y-4">
                {/* Noise reduction */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 ref={soundStart} tabIndex={-1} className="text-sm font-bold text-foreground">{t('settings.AudioSettingsModal.105')}</h3>
                      <InfoPopover label={t('info.noise')}>
                    <div className="space-y-1.5">
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.108')}</span> {t('settings.AudioSettingsModal.109')}</p>
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.110')}</span> {t('settings.AudioSettingsModal.111')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('settings.AudioSettingsModal.112')}{onOpenVoiceCheck ? (
                          <>
                            {' '}
                            <button
                              type="button"
                              onClick={() => {
                                onClose();
                                onOpenVoiceCheck();
                              }}
                              className="underline underline-offset-2 hover:text-foreground font-medium"
                            >
                              {t('settings.AudioSettingsModal.113')}</button>
                          </>
                        ) : (
                          t('settings.AudioSettingsModal.114')
                        )}
                      </p>
                    </div>
                      </InfoPopover>
                    </div>
                    <Switch
                      checked={!!engineStats?.noiseReductionEnabled}
                      onCheckedChange={(checked) => applyNoiseControlConfig({ active: checked })}
                      aria-label={t('settings.AudioSettingsModal.107')}
                    />
                  </div>

                  {!engineStats?.noiseReductionEnabled && <p className="text-xs text-muted-foreground">{t('settings.noiseOffHint')}</p>}
                  <div className="min-w-0 space-y-4">
                  <fieldset className="max-w-[22rem] space-y-2"><legend className="sr-only">{t('structure.noise.standard')}</legend>
                    <div className="inline-flex gap-1.5">
                      {([
                        ['low', t('master.nrLow')],
                        ['high', t('master.nrHigh')]
                      ] as Array<[NoiseControlMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={noiseMode === mode}
                        onClick={() => {
                          setNoiseMode(mode);
                          setNoiseMeasurementOpen(mode === 'smart' || mode === 'venue');
                          applyNoiseControlConfig({ mode });
                        }}
                        className={segmentButtonClass(noiseMode === mode)}
                      >
                        {label}
                      </button>
                      ))}
                    </div>
                  </fieldset>
                  {(noiseMode === 'low' || noiseMode === 'high') && <p className="text-xs text-muted-foreground">{t(noiseMode === 'low' ? 'settings.AudioSettingsModal.117' : 'settings.AudioSettingsModal.118')}</p>}
                  <details open={noiseAdvancedOpen} onToggle={event => setNoiseAdvancedOpen(event.currentTarget.open)} className="border-t border-border pt-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      {t('settings.noiseDetails')}
                      {(noiseMode === 'smart' || noiseMode === 'venue') && <span className="ml-3 text-xs font-normal text-muted-foreground">{t(noiseMode === 'smart' ? 'master.nrLearn' : 'master.nrVenue')}</span>}
                    </summary>
                    {noiseAdvancedOpen && <div className="space-y-4 pt-4">
                  <fieldset className="max-w-[22rem] space-y-2"><legend className="text-xs font-medium">{t('structure.noise.adaptive')}</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        ['smart', t('master.nrLearn')],
                        ['venue', t('master.nrVenue')]
                      ] as Array<[NoiseControlMode, string]>).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={noiseMode === mode}
                        onClick={() => {
                          setNoiseMode(mode);
                          setNoiseMeasurementOpen(mode === 'smart' || mode === 'venue');
                          applyNoiseControlConfig({ mode });
                        }}
                        className={`px-3 py-2 rounded-md border text-xs font-bold transition-colors ${
                          noiseMode === mode
                            ? engineStats?.noiseReductionEnabled ? 'border-selection bg-selection/15 text-selection' : 'border-muted-foreground/50 bg-muted text-foreground'
                            : 'border-input bg-background text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label}
                      </button>
                      ))}
                    </div>
                  </fieldset>
                  {(noiseMode === 'smart' || noiseMode === 'venue') && <p className="max-w-prose text-xs text-muted-foreground leading-relaxed">{t(noiseMode === 'smart' ? 'settings.AudioSettingsModal.115' : 'settings.AudioSettingsModal.116')}</p>}

                  {/* 強さはふだん弱／強の2択だけにし、数値の強さは外観の「数値の詳細を表示」で出す。 */}
                  {!isBeginnerMode && <div className="max-w-[22rem] space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{t('settings.AudioSettingsModal.119')}</span>
                      <span className="font-mono text-foreground">{noiseStrength}%</span>
                    </div>
                    <input
                      type="range"
                      min={25}
                      max={125}
                      step={5}
                      value={noiseStrength}
                      onChange={(e) => {
                        noiseStrengthEditing.current = true;
                        setNoiseStrength(Number(e.target.value));
                      }}
                      onPointerUp={(e) => commitNoiseStrength(e.currentTarget.value)}
                      onKeyUp={(e) => commitNoiseStrength(e.currentTarget.value)}
                      onBlur={(e) => commitNoiseStrength(e.currentTarget.value)}
                      className="w-full accent-primary"
                      aria-label={t('settings.AudioSettingsModal.120')}
                    />
                  </div>}

                  <details open={noiseMeasurementOpen} onToggle={event => setNoiseMeasurementOpen(event.currentTarget.open)} className="rounded-md border border-border p-3 text-sm">
                    <summary className="font-semibold">{t('measurement.title')}</summary>
                    {/* 閉じると測定欄を外し、その欄が開始した測定だけを既存の後片付けで取り消す。 */}
                    {noiseMeasurementOpen && <NoiseMeasurementPanel embedded />}
                  </details>

                  <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2">
                    <div>
                      <Label className="text-xs font-bold text-foreground">{t('settings.AudioSettingsModal.127')}</Label>
                      <InfoPopover label={t('info.voiceGuard')}>{t('settings.AudioSettingsModal.128')}</InfoPopover>
                    </div>
                    <Switch
                      checked={noiseVoiceGuard}
                      className={engineStats?.noiseReductionEnabled ? undefined : 'data-[state=checked]:bg-muted data-[state=checked]:border-muted-foreground/50 [&_[data-state=checked]]:bg-muted-foreground'}
                      onCheckedChange={(checked) => {
                        setNoiseVoiceGuard(checked);
                        applyNoiseControlConfig({ voiceGuard: checked });
                      }}
                      aria-label={t('settings.AudioSettingsModal.129')}
                    />
                  </div>
                    </div>}
                  </details>
                  </div>
                </div>

                {/* Built-in Effects */}
                <div className="p-4 bg-muted/20 rounded-xl border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 className="text-sm font-bold text-foreground">{t('settings.AudioSettingsModal.095')}</h3>
                      <InfoPopover label={t('settings.builtinHelp')}>{t('settings.AudioSettingsModal.096')}</InfoPopover>
                    </div>
                    <Switch
                      disabled={!singingModel.snapshot || singingModel.busy}
                      checked={singingModel.snapshot?.config.active ?? builtInEffectsEnabled}
                      onCheckedChange={(checked) => {
                        applyBuiltInEffects({ active: checked });
                      }}
                      aria-label={t('settings.AudioSettingsModal.097')}
                    />
                  </div>

                  {singingModel.snapshot && !singingModel.snapshot.config.active && <p className="text-xs text-muted-foreground">{t('settings.fxOffHint')}</p>}
                  <fieldset disabled={!singingModel.snapshot?.config.active || singingModel.busy} className="space-y-4 disabled:opacity-50">
                  <div className="inline-flex max-w-full flex-wrap gap-1.5">
                    {([
                      ['broadcast', t('settings.AudioSettingsModal.098')],
                      ['warm', t('settings.AudioSettingsModal.099')],
                      ['bright', t('settings.AudioSettingsModal.100')],
                    ] as Array<[BuiltInEffectsPreset, string]>).map(([preset, label]) => (
                      <button
                        key={preset}
                        type="button" aria-pressed={(singingModel.snapshot?.config.preset ?? builtInEffectsPreset) === preset}
                        disabled={!singingModel.snapshot || singingModel.busy}
                        onClick={() => {
                          applyBuiltInEffects({ active: true, preset });
                        }}
                        className={segmentButtonClass((singingModel.snapshot?.config.preset ?? builtInEffectsPreset) === preset)}
                      >
                        {label}</button>
                    ))}
                  </div>

                  <div className="w-full max-w-[22rem] space-y-2">
                    {singingModel.snapshot?.config.preset === 'singing' && <p className="text-xs">{t('settings.AudioSettingsModal.102')}</p>}
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="text-muted-foreground">{t('settings.AudioSettingsModal.103')}</span>
                      <span className="order-last w-10 shrink-0 text-right font-mono tabular-nums text-foreground">{builtInEffectsAmount}%</span>
                    <input
                      type="range"
                      disabled={singingModel.snapshot?.config.preset === 'singing' || !singingModel.snapshot || singingModel.busy}
                      min={0}
                      max={100}
                      step={5}
                      value={builtInEffectsAmount}
                      onChange={(e) => {
                        builtInEffectsAmountEditing.current = true;
                        setBuiltInEffectsAmount(Number(e.target.value));
                      }}
                      onPointerUp={(e) => commitBuiltInEffectsAmount(e.currentTarget.value)}
                      onKeyUp={(e) => commitBuiltInEffectsAmount(e.currentTarget.value)}
                      onBlur={(e) => commitBuiltInEffectsAmount(e.currentTarget.value)}
                      className="min-w-0 flex-1 accent-primary"
                      aria-label={t('settings.AudioSettingsModal.104')}
                    />
                    </div>
                  </div>
                  </fieldset>
                </div>

            </fieldset>
            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="h-10 px-4 rounded-md border border-input text-sm hover:bg-muted">{t('settings.AudioSettingsModal.093')}</button>}
            <button type="button" onClick={onOpenMixing} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">{t('mixingHome.open')}</button>
            <LiveModeControls model={liveModel} onAdjust={mode => {
              setPreparingMode(mode);
              const target = mode === 'singing' ? settingsBody.current?.querySelector<HTMLDetailsElement>('#singing-settings') : soundStart.current;
              if (target instanceof HTMLDetailsElement) target.open = true;
              target?.scrollIntoView?.({ block: 'start' });
              (target instanceof HTMLDetailsElement ? target.querySelector('summary') : target)?.focus({ preventScroll: true });
            }} />
            <details id="singing-settings" open={singingOpen} onToggle={event => setSingingOpen(event.currentTarget.open)} className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('structure.singing')}</summary>
              <SingingControls showHeading={false} model={singingModel} onPreview={onPreviewSinging} onSaveProfile={onSaveSingingProfile} />
              {preparingMode === 'singing' && <button type="button" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted" onClick={() => {
                const target = settingsBody.current?.querySelector<HTMLElement>('#live-mode-settings');
                if (target) { target.scrollIntoView?.({ block: 'start' }); target.focus({ preventScroll: true }); }
              }}>{t('settings.mode.return')}</button>}
            </details>
            {/* 出力の安全装置は上級設定。数値の詳細を出さない間は閉じた欄に置く。 */}
            {isBeginnerMode ? <details open={peakOpen} onToggle={event => setPeakOpen(event.currentTarget.open)} className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-semibold">{t('peak.title')}</summary>
              <PeakProtectionPanel />
            </details> : <PeakProtectionPanel />}
          </TabsContent>

  );
}
