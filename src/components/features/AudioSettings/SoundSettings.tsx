import { Button } from '@/components/ui/button';
import { SliderField } from '@/components/ui/SliderField';
import { Disclosure } from '@/components/ui/Disclosure';
import { useCallback, useEffect, useRef, useState } from 'react';
import { audioApi, type BuiltInEffectsPreset, type EngineRuntimeStats, type NoiseControlMode } from '../../../api/audio';
import { useMessages } from '@/i18n/LocaleProvider';
import { refreshRuntimeStatsChecked } from '@/hooks/useRuntimeStats';
import type { SingingDraft } from '@/hooks/useSingingDraft';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { toast } from 'sonner';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SoundPlace } from '@/hooks/useUIState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { NoiseMeasurementPanel } from './NoiseMeasurementPanel';
import { PeakProtectionPanel } from './PeakProtectionPanel';
import { BroadcastTruePeakPanel } from './BroadcastTruePeakPanel';
import { SingingControls } from './SingingControls';
import { LiveModeControls } from './LiveModeControls';

export function useSoundSettings(engineStats: EngineRuntimeStats | null, singingModel: SingingDraft) {
  const t = useMessages();
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

  return { noiseMode, setNoiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, deesserAmount, setDeesserAmount, deesserEditing, applyDeesser, commitDeesserAmount };
}

interface SoundSettingsProps {
  model: ReturnType<typeof useSoundSettings>;
  engineStats: EngineRuntimeStats | null;
  singingModel: SingingDraft;
  liveModel: LiveModesModel;
  isBeginnerMode: boolean;
  place: SoundPlace;
  onPlace: (place: SoundPlace, focus?: boolean) => void;
  onPeakPending: (source: 'peak' | 'broadcast', pending: boolean) => void;
  /** 音楽鑑賞では声向けの小区分を出さず、音量の保護だけにする。 */
  music?: boolean;
  singingDirty?: boolean;
  onOpenVoiceCheck?: () => void;
  onPreviewSinging?: () => void;
  onSaveSingingProfile?: () => void;
  onOpenMixing: () => void;
  streamMixAvailable?: boolean;
}

const places = ['basic', 'liveModes', 'singing', 'peak'] as const satisfies readonly SoundPlace[];

export function SoundSettings({ model, engineStats, singingModel, liveModel, isBeginnerMode, place, onPlace, onPeakPending, music = false, singingDirty = false, onOpenVoiceCheck, onPreviewSinging, onSaveSingingProfile, onOpenMixing, streamMixAvailable = true }: SoundSettingsProps) {
  const t = useMessages();
  const shown = music ? 'peak' : place;
  const { noiseMode, noiseMeasurementOpen, setNoiseMeasurementOpen, noiseAdvancedOpen, setNoiseAdvancedOpen, noiseStrength, setNoiseStrength, noiseVoiceGuard, setNoiseVoiceGuard, noiseActionBusy, noiseStrengthEditing, builtInEffectsEnabled, builtInEffectsPreset, builtInEffectsAmount, setBuiltInEffectsAmount, builtInEffectsAmountEditing, applyNoiseControlConfig, commitNoiseStrength, applyBuiltInEffects, commitBuiltInEffectsAmount, deesserAmount, setDeesserAmount, deesserEditing, applyDeesser, commitDeesserAmount } = model;
  // 基本の声の値も歌向けの下書きと同じ取得を使う。小区分を開くまで待たない。
  useEffect(() => {
    if (music) return;
    const release = singingModel.activate();
    void singingModel.refresh();
    return release;
  }, [music, singingModel.activate, singingModel.refresh]);
  const onPeak = useCallback((pending: boolean) => onPeakPending('peak', pending), [onPeakPending]);
  const onBroadcast = useCallback((pending: boolean) => onPeakPending('broadcast', pending), [onPeakPending]);
  const lead = shown === 'basic' ? t('settings.apply.soundImmediate')
    : shown === 'liveModes' ? t('sound.lead.liveModes')
    : shown === 'singing' ? t('sound.lead.singing')
    : t('settings.apply.protectionDraft');
  const sectionId = shown === 'singing' ? 'singing-settings' : shown === 'liveModes' ? 'live-mode-section' : 'sound-section';
  return (
          <div className="space-y-4">
            {!music && <Tabs value={place} onValueChange={value => onPlace(value as SoundPlace)}>
              <TabsList aria-label={t('sound.tabs')} className="h-auto w-full justify-start gap-1 overflow-x-auto">
                {places.map(value => <TabsTrigger key={value} value={value} className="text-ui-control">
                  {t(`sound.section.${value}`)}
                  {value === 'singing' && singingDirty && <span className="ml-1 inline-flex items-center gap-1">
                    <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-foreground" />
                    <span className="sr-only">{t('sound.unappliedMark')}</span>
                  </span>}
                </TabsTrigger>)}
              </TabsList>
            </Tabs>}
            <section id={sectionId} aria-labelledby="sound-section-heading" className="space-y-4">
            <h2 id="sound-section-heading" tabIndex={-1} className="text-ui-heading font-semibold text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{t(`sound.section.${shown}`)}</h2>
            <p className="text-ui-support text-muted-foreground">{lead}</p>
            {shown === 'basic' && <>
            {!engineStats && <p role="status" className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.094')}</p>}
            <fieldset disabled={!engineStats || noiseActionBusy} className="min-w-0 space-y-4">
                {/* Noise reduction */}
                <div className="p-4 bg-muted/20 rounded-card border border-border space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <h3 tabIndex={-1} className="text-foreground text-ui-heading font-semibold">{t('settings.AudioSettingsModal.105')}</h3>
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
                  <p className="text-ui-support text-muted-foreground">{t('sound.noiseMix')}</p>
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
                    {singingModel.snapshot?.config.preset !== 'singing' && <p className="text-ui-support text-muted-foreground">{t('sound.amountMeans')}</p>}
                  </div>
                  </fieldset>
                </div>
                <div className="space-y-3 rounded-card border border-border bg-muted/20 p-4">
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

            </fieldset>
            <div className="flex flex-wrap gap-3">
              {onOpenVoiceCheck && <Button onClick={onOpenVoiceCheck} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.AudioSettingsModal.093')}</Button>}
              <Button type="button" disabled={!streamMixAvailable} aria-describedby={streamMixAvailable ? undefined : "sound-stream-mix-voice-only"} onClick={onOpenMixing} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('mixingHome.open')}</Button>
              {!streamMixAvailable && <p id="sound-stream-mix-voice-only" className="text-ui-support text-muted-foreground">{t('streamMix.voiceOnly')}</p>}
            </div>
            </>}
            {shown === 'liveModes' && <LiveModeControls model={liveModel} onAdjust={() => onPlace('singing', true)} />}
            {shown === 'singing' && <>
              <SingingControls showHeading={false} hideApplyButton suspendActivation model={singingModel} onPreview={onPreviewSinging} onSaveProfile={onSaveSingingProfile} />
              <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => onPlace('liveModes', true)}>{t('settings.mode.return')}</Button>
            </>}
            {shown === 'peak' && <div className="flex flex-col gap-4">
              <PeakProtectionPanel applyInHeading hideApplyNote onPendingChange={onPeak} />
              <BroadcastTruePeakPanel applyInHeading hideApplyNote onPendingChange={onBroadcast} />
            </div>}
            </section>
          </div>

  );
}
