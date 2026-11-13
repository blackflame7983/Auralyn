import { Button } from '@/components/ui/button';
import { SliderField } from '@/components/ui/SliderField';
import { Disclosure } from '@/components/ui/Disclosure';
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
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { NoiseMeasurementPanel } from './NoiseMeasurementPanel';
import { PeakProtectionPanel } from './PeakProtectionPanel';
import { BroadcastTruePeakPanel } from './BroadcastTruePeakPanel';
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
  const [deesserAmount, setDeesserAmount] = useState(50);
  const deesserEditing = useRef(false);

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

  useEffect(() => {
    const amount = singingModel.snapshot?.config.deesser?.amount;
    if (!deesserEditing.current && amount !== undefined && Number.isFinite(amount)) {
      setDeesserAmount(Math.round(Math.min(1, Math.max(0, amount)) * 100));
    }
  }, [singingModel.snapshot]);

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

  const applyDeesser = async (enabled: boolean, amount = deesserAmount) => {
    const value = enabled ? { amount: Math.max(0, Math.min(100, amount)) / 100 } : null;
    const accepted = await singingModel.setDeesser(value);
    if (accepted) toast.success(t('settings.deesserUpdated'));
    else if (singingModel.snapshot) toast.error(t('settings.deesserUpdateFailed'));
  };

  const commitDeesserAmount = (value: number) => {
    deesserEditing.current = false;
    void applyDeesser(true, value);
  };

  return { noiseMode, setNoiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, deesserAmount, setDeesserAmount, deesserEditing, applyDeesser, commitDeesserAmount, preparingMode, setPreparingMode, singingOpen, setSingingOpen, peakOpen, setPeakOpen };
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
  streamMixAvailable?: boolean;
}
export function SoundSettings({ model, engineStats, singingModel, liveModel, isBeginnerMode, settingsBody, soundStart, onOpenVoiceCheck, onPreviewSinging, onSaveSingingProfile, onOpenMixing, streamMixAvailable = true }: SoundSettingsProps) {
  const t = useMessages();
  const { noiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, deesserAmount, setDeesserAmount, deesserEditing, applyDeesser, commitDeesserAmount, preparingMode, setPreparingMode, singingOpen, setSingingOpen, peakOpen, setPeakOpen } = model;
  return (
          <TabsContent value="sound" className="space-y-4">
            {!engineStats && <p role="status" className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.094')}</p>}
            <fieldset disabled={!engineStats || noiseActionBusy} className="min-w-0 space-y-4">
                {/* Noise reduction */}
                <div className="p-4 bg-muted/20 rounded-card border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 ref={soundStart} tabIndex={-1} className="text-foreground text-ui-heading font-semibold">{t('settings.AudioSettingsModal.105')}</h3>
                      <InfoPopover label={t('info.noise')}>
                    <div className="space-y-1.5">
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.108')}</span> {t('settings.AudioSettingsModal.109')}</p>
                      <p>
                        <span className="font-bold">{t('settings.AudioSettingsModal.110')}</span> {t('settings.AudioSettingsModal.111')}</p>
                      <p className="text-ui-support text-muted-foreground">
                        {t('settings.AudioSettingsModal.112')}{onOpenVoiceCheck ? (
                          <>
                            {' '}
                            <Button
                              type="button"
                              onClick={() => onOpenVoiceCheck()}
                              variant="link" className="h-auto min-h-10 whitespace-normal"
                            >
                              {t('settings.AudioSettingsModal.113')}</Button>
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

                  {!engineStats?.noiseReductionEnabled && <p className="text-ui-support text-muted-foreground">{t('settings.noiseOffHint')}</p>}
                  <div className="min-w-0 space-y-4">
                  <fieldset className="space-y-2"><legend className="sr-only">{t('structure.noise.standard')}</legend>
                    <SegmentedControl label={t('structure.noise.standard')}
                      options={([{ value: 'low', label: t('master.nrLow') }, { value: 'high', label: t('master.nrHigh') }] as Array<{ value: NoiseControlMode; label: string }>)}
                      value={noiseMode} onValueChange={mode => {
                        setNoiseMeasurementOpen(false);
                        void applyNoiseControlConfig({ mode });
                      }} />
                  </fieldset>
                  {(noiseMode === 'smart' || noiseMode === 'venue') && <p role="status" className="text-ui-support text-muted-foreground">{t('settings.noiseAdvancedActive', { mode: t(noiseMode === 'smart' ? 'master.nrLearn' : 'master.nrVenue') })}</p>}
                  {(noiseMode === 'low' || noiseMode === 'high') && <p className="text-ui-support text-muted-foreground">{t(noiseMode === 'low' ? 'settings.AudioSettingsModal.117' : 'settings.AudioSettingsModal.118')}</p>}
                  <details open={noiseAdvancedOpen} onToggle={event => setNoiseAdvancedOpen(event.currentTarget.open)} className="border-t border-border pt-3">
                    <summary className="cursor-pointer text-ui-control font-semibold">
                      {t('settings.noiseDetails')}
                    </summary>
                    {noiseAdvancedOpen && <div className="space-y-4 pt-4">
                  <fieldset className="space-y-2"><legend className="text-ui-control font-semibold">{t('structure.noise.adaptive')}</legend>
                    <SegmentedControl<NoiseControlMode> label={t('structure.noise.adaptive')} value={noiseMode}
                      options={[{ value: 'smart', label: t('master.nrLearn') }, { value: 'venue', label: t('master.nrVenue') }]}
                      onValueChange={mode => {
                        setNoiseMeasurementOpen(mode === 'smart' || mode === 'venue');
                        void applyNoiseControlConfig({ mode });
                      }} />
                  </fieldset>
                  {(noiseMode === 'smart' || noiseMode === 'venue') && <p className="max-w-prose text-ui-support text-muted-foreground leading-relaxed">{t(noiseMode === 'smart' ? 'settings.AudioSettingsModal.115' : 'settings.AudioSettingsModal.116')}</p>}

                  {/* 強さはふだん弱／強の2択だけにし、数値の強さは外観の「数値の詳細を表示」で出す。 */}
                  {!isBeginnerMode && <div className="space-y-2">
                    <SliderField disabled={!engineStats || noiseActionBusy} label={t('settings.AudioSettingsModal.120')} min={25} max={125} step={5} value={noiseStrength}
                      formatValue={value => `${value}%`} onValueChange={value => { noiseStrengthEditing.current = true; setNoiseStrength(value); }}
                      onValueCommit={value => commitNoiseStrength(String(value))} />
                  </div>}

                  <Disclosure open={noiseMeasurementOpen} onOpenChange={setNoiseMeasurementOpen} label={t('measurement.title')}>
                    {/* 閉じると測定欄を外し、既存の後片付けを維持する。 */}
                    {noiseMeasurementOpen && <NoiseMeasurementPanel embedded />}
                  </Disclosure>

                  <div className="flex items-center justify-between gap-3 rounded-control border border-input bg-background px-3 py-2">
                    <div>
                      <Label className="font-bold text-foreground text-ui-control">{t('settings.AudioSettingsModal.127')}</Label>
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
                <div className="p-4 bg-muted/20 rounded-card border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 className="text-foreground text-ui-heading font-semibold">{t('settings.AudioSettingsModal.095')}</h3>
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

                  {singingModel.snapshot && !singingModel.snapshot.config.active && <p className="text-ui-support text-muted-foreground">{t('settings.fxOffHint')}</p>}
                  <fieldset disabled={!singingModel.snapshot?.config.active || singingModel.busy} className="space-y-4 disabled:opacity-50">
                  <SegmentedControl label={t('home.chainPreset')}
                    options={([{ value: 'broadcast', label: t('settings.AudioSettingsModal.098') },
                      { value: 'warm', label: t('settings.AudioSettingsModal.099') },
                      { value: 'bright', label: t('settings.AudioSettingsModal.100') }] as Array<{ value: BuiltInEffectsPreset; label: string }>).map(option => ({ ...option, disabled: !singingModel.snapshot || singingModel.busy }))}
                    value={singingModel.snapshot?.config.preset ?? builtInEffectsPreset}
                    onValueChange={preset => void applyBuiltInEffects({ active: true, preset })} />

                  <div className="w-full space-y-2">
                    {singingModel.snapshot?.config.preset === 'singing' && <p className="text-ui-support">{t('settings.AudioSettingsModal.102')}</p>}
                    <SliderField label={t('settings.AudioSettingsModal.104')}
                      disabled={singingModel.snapshot?.config.preset === 'singing' || !singingModel.snapshot || singingModel.busy}
                      min={0} max={100} step={5} value={builtInEffectsAmount} formatValue={value => `${value}%`}
                      onValueChange={value => { builtInEffectsAmountEditing.current = true; setBuiltInEffectsAmount(value); }}
                      onValueCommit={value => commitBuiltInEffectsAmount(String(value))} />
                  </div>
                  </fieldset>
                  <div className="space-y-3 border-t border-border pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Label className="font-bold text-foreground text-ui-control">{t('settings.deesser')}</Label>
                        <p className="text-ui-support text-muted-foreground">{t('settings.deesserHint')}</p>
                        {engineStats?.latencyMetadata?.processingContext === 'broadcastWorker' && <p className="text-ui-support text-muted-foreground">{t('settings.deesserSplit')}</p>}
                      </div>
                      <Switch
                        disabled={!singingModel.snapshot || singingModel.busy}
                        checked={!!singingModel.snapshot?.config.deesser}
                        onCheckedChange={checked => { void applyDeesser(checked); }}
                        aria-label={t('settings.deesser')}
                      />
                    </div>
                    <div className="w-full">
                      <SliderField label={t('settings.deesserAmount')}
                        disabled={!singingModel.snapshot?.config.deesser || singingModel.busy}
                        min={0} max={100} step={5} value={deesserAmount} formatValue={value => `${value}%`}
                        onValueChange={value => { deesserEditing.current = true; setDeesserAmount(value); }}
                        onValueCommit={value => commitDeesserAmount(value)} />
                    </div>
                  </div>
                </div>

            </fieldset>
            <div className="flex flex-wrap gap-3">
              {onOpenVoiceCheck && <Button onClick={onOpenVoiceCheck} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.AudioSettingsModal.093')}</Button>}
              <Button type="button" disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : "sound-stream-mix-voice-only"} onClick={onOpenMixing} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('mixingHome.open')}</Button>
              {!streamMixAvailable && <p id="sound-stream-mix-voice-only" className="text-ui-support text-muted-foreground">{t('streamMix.voiceOnly')}</p>}
            </div>
            <LiveModeControls model={liveModel} onAdjust={mode => {
              setPreparingMode(mode);
              const target = mode === 'singing' ? settingsBody.current?.querySelector<HTMLDetailsElement>('#singing-settings') : soundStart.current;
              if (target instanceof HTMLDetailsElement) target.open = true;
              target?.scrollIntoView?.({ block: 'start' });
              (target instanceof HTMLDetailsElement ? target.querySelector('summary') : target)?.focus({ preventScroll: true });
            }} />
            <details id="singing-settings" open={singingOpen} onToggle={event => setSingingOpen(event.currentTarget.open)} className="rounded-control border border-border p-3 space-y-3">
              <summary className="cursor-pointer text-ui-heading font-semibold">{t('structure.singing')}</summary>
              <SingingControls showHeading={false} model={singingModel} onPreview={onPreviewSinging} onSaveProfile={onSaveSingingProfile} />
              {preparingMode === 'singing' && <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => {
                const target = settingsBody.current?.querySelector<HTMLElement>('#live-mode-settings');
                if (target) { target.scrollIntoView?.({ block: 'start' }); (target.querySelector<HTMLElement>('h3') ?? target).focus({ preventScroll: true }); }
              }}>{t('settings.mode.return')}</Button>}
            </details>
            {/* 出力の安全装置は上級設定。数値の詳細を出さない間は閉じた欄に置く。 */}
            {isBeginnerMode ? <details open={peakOpen} onToggle={event => setPeakOpen(event.currentTarget.open)} className="rounded-control border border-border p-3 space-y-3">
              <summary className="cursor-pointer text-ui-heading font-semibold">{t('peak.title')}</summary>
              <PeakProtectionPanel />
              <BroadcastTruePeakPanel />
            </details> : <><PeakProtectionPanel /><BroadcastTruePeakPanel /></>}
          </TabsContent>

  );
}
