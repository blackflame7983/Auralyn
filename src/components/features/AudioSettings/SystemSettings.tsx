import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/button';
import { openUrl } from '@tauri-apps/plugin-opener';
import { APP_INFO } from '../../../constants/appInfo';
import { MixingDiagnostics } from './MixingDiagnostics';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MdExtension, MdRefresh, MdFavorite, MdLanguage } from 'react-icons/md';
import { audioApi, type EngineRuntimeStats, type EngineTuningConfig } from '../../../api/audio';
import { autostartApi } from '../../../api/autostart';
import { useMessages } from '@/i18n/LocaleProvider';
import { refreshRuntimeStatsChecked } from '@/hooks/useRuntimeStats';
import { toast } from 'sonner';
import { TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { LatencyDetails } from '@/components/layout/LatencyDetails';
import { recentAnomalyWarning } from '@/components/layout/processingHealth';
import { MigrationPanel } from './MigrationPanel';
import { UpdatePreferences } from './UpdatePreferences';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { Modal } from '@/components/ui/modal';

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
  onOpenLicense?: () => void; onClose: () => void; onOpenWizard?: () => void; handleRestart: () => void; canRestart: boolean; knownStopped: boolean;
}
export function SystemSettings({ model, engineStats, loading, setLoading, showConfirm, onOpenWizard, onOpenLicense, handleRestart, canRestart, knownStopped }: SystemSettingsProps) {
  const t = useMessages();
  const { autostartEnabled, setAutostartEnabled, autostartCanChange, setAutostartCanChange, autostartReason, setAutostartReason, engineTuningConfig, setEngineTuningConfig, systemSaving, statsLoading, refreshEngineRuntimeStats, saveEngineTuningConfig, handleDangerousToggle, openSections, setOpenSections } = model;
  return (
          <TabsContent value="system" className="space-y-4">
            <section aria-label={t('settings.system.preferences')} className="space-y-3">
              <h3 className="text-ui-heading font-semibold">{t('settings.system.preferences')}</h3>
            {/* Startup Settings */}
            <section className="flex items-center justify-between gap-3 py-2">
              <div>
                <div className="flex items-center gap-1"><h3 className="text-foreground text-ui-heading font-semibold">{t('settings.AudioSettingsModal.142')}</h3><InfoPopover label={t('settings.AudioSettingsModal.142')}>{t('settings.AudioSettingsModal.143')}</InfoPopover></div>
                <div className="text-ui-support text-muted-foreground mt-0.5">{autostartReason ? renderNotice(t, autostartReason) : t('settings.system.autostartAudio')}</div>
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
            </section>
            <section aria-label={t('settings.system.maintenance')} className="space-y-4 border-t border-border pt-5">
              <h3 className="text-ui-heading font-semibold">{t('settings.system.maintenance')}</h3>
            {onOpenWizard && <section className="rounded-card border border-border p-4 space-y-3">
              <h3 className="text-ui-heading font-semibold">{t('settings.system.setup')}</h3>
              <p className="text-ui-support text-muted-foreground">{t('settings.system.setupDescription')}</p>
              <Button type="button" disabled={loading} onClick={onOpenWizard} variant="outline" className="h-auto min-h-10 whitespace-normal">{t('settings.AudioSettingsModal.198')}</Button>
            </section>}


            <section className="rounded-card border border-border p-4 space-y-2">
              <div className="flex items-center gap-1"><h3 className="text-ui-heading font-semibold">{t('structure.restart')}</h3><InfoPopover label={t('settings.system.restartHelp')}>{t('settings.system.restartDescription')}</InfoPopover></div>
              <p className="text-ui-support text-muted-foreground">{t('settings.system.restartWarning')}</p>
                <Button variant="outline"
                  onClick={handleRestart}
                  disabled={loading || !canRestart}

                >
                  {t('settings.AudioSettingsModal.196')}</Button>
            </section>
            <details open={openSections.optimization} onToggle={event => {
              const open = event.currentTarget.open;
              setOpenSections(prev => ({ ...prev, optimization: open }));
            }} className="rounded-card border border-border p-4 space-y-3">
              <summary className="cursor-pointer"><h3 className="inline text-ui-heading font-semibold">{t('structure.optimization')}</h3></summary>
            {/* Engine Tuning */}
            <div className="space-y-2">
              <p className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.166')}</p>
              <div className="p-4 bg-muted/20 border border-border rounded-card space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-ui-support font-medium text-foreground">{t('settings.AudioSettingsModal.150')}</div>
                    <div className="text-ui-support text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.151')}</div>
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
                  <Field label={t('settings.AudioSettingsModal.153')}>
                  <Input
                    aria-label={t('settings.AudioSettingsModal.154')}
                    type="text"
                    value={engineTuningConfig.affinityMask ?? ''}
                    onChange={(e) =>
                      setEngineTuningConfig((prev) => ({ ...prev, affinityMask: e.target.value || null }))
                    }
                    placeholder={t('settings.AudioSettingsModal.155')}

                    disabled={systemSaving}
                  /></Field>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-ui-support font-medium text-foreground">{t('settings.AudioSettingsModal.156')}</div>
                    <div className="text-ui-support text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.157')}</div>
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
                    <div className="text-ui-support font-medium text-foreground">{t('settings.AudioSettingsModal.161')}</div>
                    <div className="text-ui-support text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.162')}</div>
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

                <div className="flex gap-2">
                  <Button
                    onClick={saveEngineTuningConfig}
                    disabled={systemSaving}
                    variant="default" size="sm" className="h-auto min-h-9 whitespace-normal"
                  >
                    {systemSaving ? t('settings.AudioSettingsModal.167') : t('settings.AudioSettingsModal.168')}
                  </Button>

                </div>


              </div>
            </div>

            </details>
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => setOpenSections(prev => ({ ...prev, diagnostics: true }))}>{t('settings.diagnosticsOpen')}</Button>
            {openSections.diagnostics && <Modal title={t('structure.diagnostics')} onClose={() => setOpenSections(prev => ({ ...prev, diagnostics: false }))}>
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-background/90 p-4 gaming:bg-background/60">
              <div className="modal-surface-base max-h-[80vh] w-full max-w-lg space-y-3 overflow-y-auto p-6">
              <h2 className="text-ui-heading font-semibold text-foreground">{t('structure.diagnostics')}</h2>
              <Button
                    onClick={refreshEngineRuntimeStats}
                    disabled={statsLoading}
                    variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal gap-1"
                  >
                    <MdRefresh className="w-3 h-3" />
                    {statsLoading ? t('settings.AudioSettingsModal.169') : t('settings.AudioSettingsModal.170')}
                  </Button>
<table className="w-full text-ui-support">
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
                <td className="py-2 text-right tabular-nums">{engineStats ? `${(engineStats.maxJitterUs / 1000).toFixed(2)} ms` : '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('settings.AudioSettingsModal.176')}</th>
                <td className="py-2 text-right tabular-nums">{engineStats?.glitchCount ?? '-'}</td>
                </tr>
                <tr className="border-b border-border">
                <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">{t('master.recentAnomaliesLabel')}</th>
                <td className="py-2 text-right">
                    <div className="whitespace-normal break-words">{engineStats?.processingHealth ? t('master.recentAnomalies', { window: engineStats.processingHealth.windowSecs, late: engineStats.processingHealth.recentLate, underflow: engineStats.processingHealth.recentUnderflow }) : '-'}</div>
                    {engineStats?.processingHealth && <div className="mt-1 whitespace-normal break-words text-muted-foreground">{t('master.recentAnomaliesNote')}</div>}
                    {recentAnomalyWarning(engineStats?.processingHealth) && <div className="mt-1 whitespace-normal break-words">{t('master.recentAnomaliesHigh')}</div>}
                </td>
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
            <MixingDiagnostics open={openSections.diagnostics} />
            <LatencyDetails stats={engineStats} isRunning={!knownStopped} />
              <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => setOpenSections(prev => ({ ...prev, diagnostics: false }))}>{t('common.close')}</Button>
              </div>
            </div>
            </Modal>}
            {/* Plugin Management */}
            <section className="rounded-card border border-border p-4 space-y-4">
              <h3 className="text-foreground flex items-center gap-2 text-ui-heading font-semibold">
                <MdExtension className="w-4 h-4 text-primary" />
                {t('settings.AudioSettingsModal.179')}</h3>
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-ui-support font-medium text-foreground">{t('settings.AudioSettingsModal.180')}</div>
                    <div className="text-ui-support text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.181')}</div>
                  </div>
                  <Button
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
                    variant="destructive" size="sm" className="h-auto min-h-9 whitespace-normal"
                  >
                    {t('settings.AudioSettingsModal.187')}</Button>
                </div>
              </div>
            </section>

            <details open={openSections.migration} onToggle={event => {
              const open = event.currentTarget.open;
              setOpenSections(prev => ({ ...prev, migration: open }));
            }} className="rounded-card border border-border p-4 space-y-3">
              <summary className="cursor-pointer"><h3 className="inline text-ui-heading font-semibold">{t('structure.migration')}</h3></summary>
              <MigrationPanel />
            </details>

            {/* Factory Reset */}
            <section className="rounded-card border border-border p-4 space-y-4">
              <h3 className="text-foreground flex items-center gap-2 text-ui-heading font-semibold">
                <MdRefresh className="w-4 h-4 text-destructive-text" />
                {t('settings.AudioSettingsModal.188')}</h3>
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-ui-support font-medium text-foreground">{t('settings.AudioSettingsModal.189')}</div>
                    <div className="text-ui-support text-muted-foreground mt-0.5">{t('settings.AudioSettingsModal.190')}</div>
                  </div>
                  <Button
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
                    variant="destructive" size="sm" className="h-auto min-h-9 whitespace-normal"
                  >
                    {t('settings.AudioSettingsModal.195')}</Button>
                </div>
              </div>
            </section>
            </section>
            {/* アプリ情報 */}
            <div className="p-6 bg-muted/20 border border-border rounded-card flex flex-col items-center justify-center space-y-3">
              <img src="/auralyn_icon.png" alt="Auralyn Icon" className="w-16 h-16 rounded-full shadow-sm object-contain" />
              <div className="text-center">
                <h3 className="text-foreground text-ui-heading font-semibold">{APP_INFO.NAME}</h3>
                <p className="text-ui-support text-muted-foreground">{t('settings.AudioSettingsModal.138')}{APP_INFO.VERSION}</p>
              </div>

              <div className="flex gap-4 pt-2">
                <Button onClick={() => openUrl('https://www.kuro7983.com/apps/auralyn')} variant="ghost" size="sm" className="h-auto min-h-9 whitespace-normal gap-1">
                  <MdLanguage className="w-3.5 h-3.5" />
                  {t('settings.AudioSettingsModal.139')}</Button>
                {onOpenLicense && (
                  <Button onClick={onOpenLicense} variant="ghost" size="sm" className="h-auto min-h-9 whitespace-normal gap-1">
                    {t('settings.AudioSettingsModal.140')}</Button>
                )}
                <Button onClick={() => openUrl('https://ofuse.me/o?uid=149216')} variant="ghost" size="sm" className="h-auto min-h-9 whitespace-normal gap-1">
                  <MdFavorite className="w-3 h-3" />
                  {t('settings.AudioSettingsModal.141')}</Button>
              </div>
            </div>
          </TabsContent>
  );
}
