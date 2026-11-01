import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MdExtension, MdRefresh, MdSettings } from 'react-icons/md';
import { audioApi, type EngineRuntimeStats, type EngineTuningConfig } from '../../../api/audio';
import { autostartApi } from '../../../api/autostart';
import { useMessages } from '@/i18n/LocaleProvider';
import { refreshRuntimeStatsChecked } from '@/hooks/useRuntimeStats';
import { toast } from 'sonner';
import { TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { LatencyDetails } from '@/components/layout/LatencyDetails';
import { MigrationPanel } from './MigrationPanel';
import { UpdatePreferences } from './UpdatePreferences';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';

type ConfirmOptions = { title: SettingsNotice; description?: SettingsNotice; confirmLabel?: SettingsNotice; variant?: 'default' | 'destructive'; onConfirm: () => void };
interface SystemSettingsOptions {
  isOpen: boolean; currentSampleRate?: number; currentBufferSize?: number; isBeginnerMode: boolean;
  showConfirm: (options: ConfirmOptions) => void;
}
export function useSystemSettings({ isOpen, currentSampleRate, currentBufferSize, isBeginnerMode, showConfirm }: SystemSettingsOptions) {
  const t = useMessages();
  const [openSections, setOpenSections] = useState({ optimization: false, diagnostics: false, migration: false });
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartCanChange, setAutostartCanChange] = useState(false);
  const [autostartReason, setAutostartReason] = useState<SettingsNotice | null>(null);
  const tuningDirty = useRef(false);
  const [engineTuningConfig, setLoadedEngineTuningConfig] = useState<EngineTuningConfig>({
    enableAffinityPinning: false,
    affinityMask: null,
    enableRealtimePriority: false,
    enableTimeCriticalAudioThreads: false,
  });
  const setEngineTuningConfig: Dispatch<SetStateAction<EngineTuningConfig>> = next => {
    tuningDirty.current = true;
    setLoadedEngineTuningConfig(next);
  };
  const [systemSaving, setSystemSaving] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  // Load settings from localStorage on mount/open
  useEffect(() => {
    if (isOpen) {
      autostartApi.getStatus().then(s => {
        setAutostartEnabled(s.enabled);
        setAutostartCanChange(s.canChange);
        setAutostartReason(s.reason ?? null);
      }).catch(() => {
        setAutostartCanChange(false);
        setAutostartReason(notice('settings.AudioSettingsModal.000'));
      });
      audioApi.getEngineTuningConfig()
        .then((config) => { if (config && typeof config === 'object' && !tuningDirty.current) setLoadedEngineTuningConfig(config); })
        .catch((e) => {
          console.error('Failed to load engine tuning config', e);
        });

    }
  }, [isOpen, currentSampleRate, currentBufferSize]);

  const refreshEngineRuntimeStats = async () => {
    setStatsLoading(true);
    try {
      await refreshRuntimeStatsChecked();
    } catch (e) {
      console.error('Failed to refresh engine runtime stats', e);
      toast.error(t('settings.AudioSettingsModal.001'));
    } finally {
      setStatsLoading(false);
    }
  };

  const saveEngineTuningConfig = async () => {
    const normalized: EngineTuningConfig = {
      ...engineTuningConfig,
      affinityMask: engineTuningConfig.affinityMask?.trim() || null,
    };

    setSystemSaving(true);
    try {
      await audioApi.setEngineTuningConfig(normalized);
      setLoadedEngineTuningConfig(normalized);
      tuningDirty.current = false;
      toast.success(t('settings.AudioSettingsModal.011'));
    } catch (e) {
      console.error('Failed to save engine tuning config', e);
      toast.error(t('settings.AudioSettingsModal.012'));
    } finally {
      setSystemSaving(false);
    }
  };



  const handleDangerousToggle = (
    key: 'enableRealtimePriority' | 'enableTimeCriticalAudioThreads',
    checked: boolean,
    title: SettingsNotice,
    warning: SettingsNotice
  ) => {
    if (!checked) {
      setEngineTuningConfig((prev) => ({ ...prev, [key]: false }));
      return;
    }

    showConfirm({
      title: notice('settings.AudioSettingsModal.013', { arg0: title }),
      description: notice('settings.warning', { warning, hint: isBeginnerMode ? notice('settings.AudioSettingsModal.015') : '' }),
      confirmLabel: notice('settings.AudioSettingsModal.016'),
      variant: 'destructive',
      onConfirm: () => {
        setEngineTuningConfig((prev) => ({ ...prev, [key]: true }));
      },
    });
  };

  return { autostartEnabled, setAutostartEnabled, autostartCanChange, setAutostartCanChange, autostartReason, setAutostartReason, engineTuningConfig, setEngineTuningConfig, systemSaving, statsLoading, refreshEngineRuntimeStats, saveEngineTuningConfig, handleDangerousToggle, openSections, setOpenSections };
}

interface SystemSettingsProps {
  model: ReturnType<typeof useSystemSettings>; engineStats: EngineRuntimeStats | null;
  loading: boolean; setLoading: Dispatch<SetStateAction<boolean>>; showConfirm: (options: ConfirmOptions) => void;
  onClose: () => void; onOpenWizard?: () => void; handleRestart: () => void; canRestart: boolean; knownStopped: boolean;
}
export function SystemSettings({ model, engineStats, loading, setLoading, showConfirm, onClose, onOpenWizard, handleRestart, canRestart, knownStopped }: SystemSettingsProps) {
  const t = useMessages();
  const { autostartEnabled, setAutostartEnabled, autostartCanChange, setAutostartCanChange, autostartReason, setAutostartReason, engineTuningConfig, setEngineTuningConfig, systemSaving, statsLoading, refreshEngineRuntimeStats, saveEngineTuningConfig, handleDangerousToggle, openSections, setOpenSections } = model;
  return (
          <TabsContent value="system" className="space-y-4">
            {onOpenWizard && <section className="rounded-xl border border-border p-4 space-y-3">
              <h3 className="font-semibold">{t('settings.system.setup')}</h3>
              <p className="text-xs text-muted-foreground">{t('settings.system.setupDescription')}</p>
              <button type="button" disabled={loading} onClick={() => { onClose(); onOpenWizard(); }} className="rounded-md border border-border px-3 py-2 text-sm">{t('settings.AudioSettingsModal.198')}</button>
            </section>}

            {/* Startup Settings */}
            <section className="p-4 bg-muted/20 border border-border rounded-xl flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-foreground">{t('settings.AudioSettingsModal.142')}</h3>
                <div className="text-xs text-muted-foreground mt-0.5">{autostartReason ? renderNotice(t, autostartReason) : t('settings.AudioSettingsModal.143')}</div>
              </div>
              <div className="flex items-center">
                <Switch
                  aria-label={t('settings.AudioSettingsModal.144')}
                    checked={autostartEnabled}
                  onCheckedChange={async (checked) => {
                    setLoading(true);
                    try {
                      await autostartApi.setEnabled(checked);
                      const s = await autostartApi.getStatus();
                      setAutostartEnabled(s.enabled);
                      setAutostartCanChange(s.canChange);
                      setAutostartReason(s.reason ?? null);
                      if (s.enabled === checked) {
                        toast.success(checked ? t('settings.AudioSettingsModal.145') : t('settings.AudioSettingsModal.146'));
                      }
                    } catch (e) {
                      console.error(e);
                      toast.error(t('settings.AudioSettingsModal.147'));
                      setAutostartCanChange(false);
                      setAutostartReason(notice('settings.AudioSettingsModal.148'));
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading || !autostartCanChange}
                />
              </div>
            </section>

            <UpdatePreferences />
            <section className="rounded-xl border border-border p-4 space-y-2">
              <h3 className="font-semibold">{t('structure.restart')}</h3>
              <p className="text-xs text-muted-foreground">{t('settings.system.restartDescription')}</p>
                <button
                  onClick={handleRestart}
                  disabled={loading || !canRestart}
                  className="px-3 py-2 bg-muted hover:bg-destructive/10 text-muted-foreground hover:text-destructive-text border border-input hover:border-destructive/30 rounded-md transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('settings.AudioSettingsModal.196')}</button>
            </section>
            <details open={openSections.optimization} onToggle={event => {
              const open = event.currentTarget.open;
              setOpenSections(prev => ({ ...prev, optimization: open }));
            }} className="rounded-xl border border-border p-4 space-y-3">
              <summary className="cursor-pointer"><h3 className="inline font-semibold">{t('structure.optimization')}</h3></summary>
            {/* Engine Tuning */}
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-foreground flex items-center gap-2 px-1">
                <MdSettings className="w-4 h-4 text-primary" />
                {t('settings.AudioSettingsModal.149')}</h4>
              <div className="p-4 bg-muted/20 border border-border rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.150')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.151')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.152')}
                    checked={engineTuningConfig.enableAffinityPinning}
                    onCheckedChange={(checked) =>
                      setEngineTuningConfig((prev) => ({ ...prev, enableAffinityPinning: checked }))
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('settings.AudioSettingsModal.153')}</label>
                  <input
                    aria-label={t('settings.AudioSettingsModal.154')}
                    type="text"
                    value={engineTuningConfig.affinityMask ?? ''}
                    onChange={(e) =>
                      setEngineTuningConfig((prev) => ({ ...prev, affinityMask: e.target.value || null }))
                    }
                    placeholder={t('settings.AudioSettingsModal.155')}
                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.156')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.157')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.158')}
                    checked={engineTuningConfig.enableRealtimePriority}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableRealtimePriority',
                        checked,
                        notice('settings.AudioSettingsModal.159'),
                        notice('settings.AudioSettingsModal.160')
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.161')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.162')}</div>
                  </div>
                  <Switch
                    aria-label={t('settings.AudioSettingsModal.163')}
                    checked={engineTuningConfig.enableTimeCriticalAudioThreads}
                    onCheckedChange={(checked) =>
                      handleDangerousToggle(
                        'enableTimeCriticalAudioThreads',
                        checked,
                        notice('settings.AudioSettingsModal.164'),
                        notice('settings.AudioSettingsModal.165')
                      )
                    }
                    disabled={systemSaving}
                  />
                </div>

                <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border">
                  {t('settings.AudioSettingsModal.166')}</div>

                <div className="flex gap-2">
                  <button
                    onClick={saveEngineTuningConfig}
                    disabled={systemSaving}
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition"
                  >
                    {systemSaving ? t('settings.AudioSettingsModal.167') : t('settings.AudioSettingsModal.168')}
                  </button>

                </div>


              </div>
            </div>

            </details>
            <details open={openSections.diagnostics} onToggle={event => {
              const open = event.currentTarget.open;
              setOpenSections(prev => ({ ...prev, diagnostics: open }));
            }} className="rounded-xl border border-border p-4 space-y-3">
              <summary className="cursor-pointer"><h3 className="inline font-semibold">{t('structure.diagnostics')}</h3></summary>
              <button
                    onClick={refreshEngineRuntimeStats}
                    disabled={statsLoading}
                    className="px-3 py-1.5 text-xs border border-input rounded-md text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-50 transition flex items-center gap-1"
                  >
                    <MdRefresh className="w-3 h-3" />
                    {statsLoading ? t('settings.AudioSettingsModal.169') : t('settings.AudioSettingsModal.170')}
                  </button>
<table className="w-full text-sm">
                <caption className="sr-only">{t('structure.statistics')}</caption>
                <tbody>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.171')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.activePluginCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.172')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.enabledPluginCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.173')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.pendingUnloadCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.174')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.burnedLibraryCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.175')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats ? `${(engineStats.maxJitterUs / 1000).toFixed(2)}ms` : '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.176')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.glitchCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.177')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats
                        ? (engineStats.noiseReductionEnabled
                          ? t('settings.AudioSettingsModal.178', { arg0: engineStats.noiseReductionMode === 'high' ? t('master.nrHigh') : engineStats.noiseReductionMode === 'smart' ? t('master.nrLearn') : engineStats.noiseReductionMode === 'venue' ? t('master.nrVenue') : t('master.nrLow') })
                          : 'OFF')
                        : '-'}</td>
                </tr>
                </tbody>
                </table>
            <LatencyDetails stats={engineStats} isRunning={!knownStopped} />
            </details>
            {/* Plugin Management */}
            <section className="rounded-xl border border-border p-4 space-y-4">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <MdExtension className="w-4 h-4 text-primary" />
                {t('settings.AudioSettingsModal.179')}</h3>
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.180')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.181')}</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: notice('settings.AudioSettingsModal.182'),
                        description: notice('settings.AudioSettingsModal.183'),
                        confirmLabel: notice('settings.AudioSettingsModal.184'),
                        variant: 'destructive',
                        onConfirm: async () => {
                          setLoading(true);
                          try {
                            await audioApi.clearBlacklist();
                            toast.success(t('settings.AudioSettingsModal.185'));
                          } catch (e) {
                            console.error(e);
                            toast.error(t('settings.AudioSettingsModal.186'));
                          } finally {
                            setLoading(false);
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive-text bg-destructive/10 hover:bg-destructive/20 border border-destructive/20 rounded-md transition-colors whitespace-nowrap"
                  >
                    {t('settings.AudioSettingsModal.187')}</button>
                </div>
              </div>
            </section>

            <details open={openSections.migration} onToggle={event => {
              const open = event.currentTarget.open;
              setOpenSections(prev => ({ ...prev, migration: open }));
            }} className="rounded-xl border border-border p-4 space-y-3">
              <summary className="cursor-pointer"><h3 className="inline font-semibold">{t('structure.migration')}</h3></summary>
              <MigrationPanel />
            </details>

            {/* Factory Reset */}
            <section className="rounded-xl border border-border p-4 space-y-4">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <MdRefresh className="w-4 h-4 text-destructive-text" />
                {t('settings.AudioSettingsModal.188')}</h3>
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-foreground">{t('settings.AudioSettingsModal.189')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.190')}</div>
                  </div>
                  <button
                    onClick={() => {
                      showConfirm({
                        title: notice('settings.AudioSettingsModal.191'),
                        description: notice('settings.AudioSettingsModal.192'),
                        confirmLabel: notice('settings.AudioSettingsModal.193'),
                        variant: 'destructive',
                        onConfirm: async () => {
                          try {
                            await audioApi.stop().catch(() => {});
                            // Clear all vst_host_ prefixed localStorage keys
                            const keysToRemove: string[] = [];
                            for (let i = 0; i < localStorage.length; i++) {
                              const key = localStorage.key(i);
                              if (key && key.startsWith('vst_host_')) {
                                keysToRemove.push(key);
                              }
                            }
                            keysToRemove.forEach(key => localStorage.removeItem(key));
                            // Reload the app
                            window.location.reload();
                          } catch (e) {
                            console.error("Reset failed:", e);
                            toast.error(t('settings.AudioSettingsModal.194'));
                          }
                        },
                      });
                    }}
                    className="px-3 py-1.5 text-xs text-destructive-foreground bg-destructive hover:bg-destructive/90 rounded-md transition-colors whitespace-nowrap"
                  >
                    {t('settings.AudioSettingsModal.195')}</button>
                </div>
              </div>
            </section>
          </TabsContent>
  );
}
