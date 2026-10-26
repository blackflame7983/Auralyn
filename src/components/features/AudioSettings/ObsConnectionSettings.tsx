import { message, type MessageKey } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { obsApi, type ObsAudioReachResult } from '../../../api/obs';
import { useObsUsage } from '../../../hooks/useObsUsage';
import { ObsSafeSetup } from './ObsSafeSetup';
import { readObsEndpoint, obsConnectionFailureNotice } from '../../../lib/obsConnectionPreferences';
import { ObsModeRoutingSettings } from './ObsModeRoutingSettings';
import { Button } from '@/components/ui/button';

interface ObsConnectionSettingsProps {
  showConfirm: (request: {
    title: SettingsNotice; description?: SettingsNotice; confirmLabel?: SettingsNotice;
    variant?: 'default' | 'destructive'; onConfirm: () => void;
  }) => void;
  onClose: () => void;
  onOpenOBSGuide?: () => void;
  onOpenTroubleshoot?: () => void;
}

// OBS接続の寿命はこのタブの表示に合わせ、音声デバイス設定とは独立して管理する。
export function ObsConnectionSettings({ showConfirm, onClose, onOpenOBSGuide, onOpenTroubleshoot }: ObsConnectionSettingsProps) {
    const t = useMessages();
    const { locale } = useLocale();
  const [loading, setLoading] = useState(false);
  const [endpoint] = useState(readObsEndpoint);
  const [obsHost, setObsHost] = useState(endpoint.host);
  const [obsPort, setObsPort] = useState(endpoint.port);
  const [obsPassword, setObsPassword] = useState('');
  const [isObsConnected, setIsObsConnected] = useState(false);
  const obsInUse = useObsUsage(true);
  const [obsStatusLoading, setObsStatusLoading] = useState(true);
  const [obsConnectionHint, setObsConnectionHint] = useState<SettingsNotice | null>(null);
  const [obsSetupLoading, setObsSetupLoading] = useState(false);
  const [obsReachLoading, setObsReachLoading] = useState(false);

  const [obsReachResult, setObsReachResult] = useState<ObsAudioReachResult | null>(null);
  const [reachCurrent, setReachCurrent] = useState(false);
  const [reachExpired, setReachExpired] = useState(false);
  const reachExpiredRef = useRef(false);
  const [reachListenersReady, setReachListenersReady] = useState(false);
  const reachRecord = useRef<ObsAudioReachResult | null>(null);
  const reachAlive = useRef(false);
  const reachRequest = useRef(0);
  const reachValidation = useRef(0);
  // 応答順の番号と確認dialogの条件番号を分離する。正常なpollは条件変更ではない。
  const reachContext = useRef(0);
  const reachListeners = useRef(false);
  const connectionRevision = useRef(0);

  // 翻訳の変更では購読・接続・確認をやり直さない。自己toneの通知もいったん
  // staleにしてからnativeの終了後witnessを照合し、通知を一括無視しない。
  const revalidateReach = async (record = reachRecord.current, invalidate = true) => {
    const version = ++reachValidation.current;
    if (invalidate) setReachCurrent(false);
    if (!record?.verification || !reachListeners.current || document.hidden || reachExpiredRef.current) return false;
    try {
      const current = await obsApi.audioReachCurrent(record.verification.operationId);
      if (!reachAlive.current || version !== reachValidation.current || document.hidden || !reachListeners.current || reachRecord.current !== record) return false;
      setReachCurrent(current === true);
      if (current !== true) { reachContext.current += 1; reachExpiredRef.current = true; setReachExpired(true); }
      return current === true;
    } catch {
      if (reachAlive.current && version === reachValidation.current && reachRecord.current === record) {
        reachContext.current += 1;
        reachExpiredRef.current = true; setReachExpired(true); setReachCurrent(false);
      }
      return false;
    }
  };

  useEffect(() => {
    reachAlive.current = true;
    let active = true;
    const invalidate = () => {
      if (!active) return;
      reachContext.current += 1;
      void revalidateReach();
    };
    const visibility = () => {
      if (document.hidden) {
        reachRequest.current += 1;
        reachContext.current += 1;
        reachValidation.current += 1;
        setObsReachLoading(false);
        setReachCurrent(false);
        reachExpiredRef.current = true; setReachExpired(true);
      }
    };
    const subscriptions = ['obs://timing-invalidated', 'obs://reach-invalidated', 'audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed']
      .map(event => listen(event, invalidate));
    void Promise.all(subscriptions).then(() => {
      if (active) { reachListeners.current = true; setReachListenersReady(true); }
    }).catch(() => {
      if (active) { reachContext.current += 1; reachListeners.current = false; setReachListenersReady(false); setReachCurrent(false); }
    });
    window.addEventListener('profile-fx-applied', invalidate);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false; reachAlive.current = false; reachListeners.current = false;
      reachRequest.current += 1; reachValidation.current += 1; reachContext.current += 1;
      window.removeEventListener('profile-fx-applied', invalidate);
      document.removeEventListener('visibilitychange', visibility);
      subscriptions.forEach(subscription => { void subscription.then(stop => stop()).catch(() => {}); });
    };
  }, []);

  // obwsが通知しない同名ソースのdevice/filter設定は表示中だけ再読取りする。
  // localeを依存にせず、要求の完了後に次回を予約して重複pollを作らない。
  useEffect(() => {
    if (!obsReachResult?.verification || !obsInUse || !reachListenersReady || reachExpired) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || document.hidden || reachExpiredRef.current) return;
      await revalidateReach(reachRecord.current, false);
      if (active && !reachExpiredRef.current) timer = setTimeout(() => { void poll(); }, 3000);
    };
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [obsReachResult, obsInUse, reachListenersReady, reachExpired]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('vst_host_obs_config') ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.password === 'string') setObsPassword(saved.password);
    } catch { /* 保存データが壊れていても、接続先を入力して再設定できるようにする。 */ }
  }, []);

  // 再表示では接続を作り直さず、バックエンドが保持する接続・履歴へ戻る。
  useEffect(() => {
    connectionRevision.current += 1;
    setLoading(false);
    if (!obsInUse) { setIsObsConnected(false); setReachCurrent(false); reachRequest.current += 1; reachValidation.current += 1; return; }
    let active = true;
    setObsStatusLoading(true);
    obsApi.connectionStatus()
      .then(connected => { if (active) setIsObsConnected(connected); })
      .catch(() => { if (active) setObsConnectionHint(notice('settings.ObsConnectionSettings.266')); })
      .finally(() => { if (active) setObsStatusLoading(false); });
    return () => { active = false; connectionRevision.current += 1; };
  }, [obsInUse]);

  const handleConnectObs = async () => {
    reachContext.current += 1;
    connectionRevision.current += 1;
    reachRequest.current += 1; reachValidation.current += 1; setReachCurrent(false);
    const startedLocale = locale;
    const notify = (key: MessageKey, args?: Record<string, string | number>) => message(startedLocale, key, args);
    const attemptedPort = obsPort;
    const revision = connectionRevision.current;
    setLoading(true);
    try {
      await obsApi.connect({ host: obsHost, port: obsPort, password: obsPassword });
      if (revision !== connectionRevision.current || document.hidden) return;
      setIsObsConnected(true);
      setObsConnectionHint(null);
      toast.success(notify('settings.ObsConnectionSettings.267'));
      localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: obsHost, port: obsPort, password: obsPassword }));
    } catch (e) {
      if (revision !== connectionRevision.current || document.hidden) return;
      const hint = obsConnectionFailureNotice(e, attemptedPort);

      setObsConnectionHint(hint);
      toast.error(notify('settings.ObsConnectionSettings.268'), {
        description: notify(hint.key, hint.args),
        action: onOpenOBSGuide
          ? {
            label: notify('settings.ObsConnectionSettings.269'),
            onClick: onOpenOBSGuide,
          }
          : undefined,
      });
      setIsObsConnected(false);
    } finally {
      if (revision === connectionRevision.current) setLoading(false);
    }
  };

  const handleDisconnectObs = async () => {
    reachContext.current += 1;
    connectionRevision.current += 1;
    reachRequest.current += 1; reachValidation.current += 1; setReachCurrent(false);
    try {
      await obsApi.disconnect();
      setIsObsConnected(false);
      setObsConnectionHint(null);

      toast.info(t('settings.ObsConnectionSettings.270'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleObsReachCheck = () => {
    const connection = connectionRevision.current;
    const context = reachContext.current;
    showConfirm({
      title: notice('settings.ObsConnectionSettings.271'),
      description: notice('settings.ObsConnectionSettings.272'),
      confirmLabel: notice('settings.ObsConnectionSettings.273'),
      onConfirm: async () => {
        if (!reachAlive.current || !reachListeners.current || document.hidden) return;
        if (connection !== connectionRevision.current || context !== reachContext.current) {
          toast.info(t('obsReach.stale'));
          return;
        }
        const request = ++reachRequest.current;
        reachContext.current += 1;
        reachValidation.current += 1;
        reachRecord.current = null;
        reachExpiredRef.current = false; setReachExpired(false);
        setObsReachLoading(true);
        setReachCurrent(false);
        try {
          const result = await obsApi.checkAudioReach(2000);
          if (!reachAlive.current || request !== reachRequest.current || document.hidden) return;
          reachRecord.current = result;
          setObsReachResult(result);
          const current = await revalidateReach(result);
          if (!reachAlive.current || request !== reachRequest.current || document.hidden) return;
          if (result.reached === 'unsupported') {
            toast.info(t('settings.ObsConnectionSettings.274'), {
              description: t('settings.ObsConnectionSettings.275'),
            });
          } else if (result.reached && current) {
            toast.success(t('obsReach.confirmed'));
          } else if (current) {
            toast.error(t('settings.ObsConnectionSettings.277'), {
              description: t('settings.ObsConnectionSettings.278'),
            });
          }
        } catch (e) {
          if (reachAlive.current && request === reachRequest.current && !document.hidden) toast.error(t('settings.ObsConnectionSettings.279'));
        } finally {
          if (reachAlive.current && request === reachRequest.current) setObsReachLoading(false);
        }
      },
    });
  };

  return (

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">{t('settings.ObsConnectionSettings.280')}</label>
                <input
                  aria-label={t('settings.ObsConnectionSettings.281')}
                  disabled={loading || isObsConnected}
                  type="text"
                  value={obsHost}
                  onChange={(e) => setObsHost(e.target.value)}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="localhost"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">{t('settings.ObsConnectionSettings.282')}</label>
                <input
                  aria-label={t('settings.ObsConnectionSettings.283')}
                  disabled={loading || isObsConnected}
                  type="number"
                  value={obsPort}
                  onChange={(e) => setObsPort(Number(e.target.value))}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="4455"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">{t('settings.ObsConnectionSettings.284')}</label>
                <input
                  aria-label={t('settings.ObsConnectionSettings.285')}
                  disabled={loading || isObsConnected}
                  type="password"
                  value={obsPassword}
                  onChange={(e) => setObsPassword(e.target.value)}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder={t('settings.ObsConnectionSettings.286')}
                />
              </div>

              <p className="text-xs text-muted-foreground">{t('settings.ObsConnectionSettings.287')}</p>
              <div className="pt-4">
                {!isObsConnected ? (
                  <button
                    onClick={handleConnectObs}
                    disabled={loading || obsStatusLoading}
                    className="w-full py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-all font-bold"
                  >
                    {obsStatusLoading ? t('settings.ObsConnectionSettings.288') : loading ? t('settings.ObsConnectionSettings.289') : t('settings.ObsConnectionSettings.290')}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3">
                    <span role="status" className="text-sm font-medium">{t('settings.ObsConnectionSettings.291')}</span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDisconnectObs}
                      disabled={obsSetupLoading || obsReachLoading}
                    >
                      {t('settings.ObsConnectionSettings.292')}
                    </Button>
                  </div>
                )}
              </div>

              {obsConnectionHint && (
                <div className="text-xs bg-destructive/10 border border-destructive/30 text-destructive-text rounded-md p-3 space-y-2">
                  <p className="font-bold">{t('settings.ObsConnectionSettings.293')}</p>
                  <p>{renderNotice(t, obsConnectionHint)}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {onOpenOBSGuide && (
                      <button
                        onClick={onOpenOBSGuide}
                        className="px-2.5 py-1 rounded border border-destructive/40 hover:bg-destructive/10 transition-colors"
                      >
                        {t('settings.ObsConnectionSettings.294')}</button>
                    )}
                    <button
                      onClick={() => {
                        setObsHost('localhost');
                        setObsPort(4455);
                      }}
                      className="px-2.5 py-1 rounded border border-border hover:bg-muted/60 text-foreground transition-colors"
                    >
                      {t('settings.ObsConnectionSettings.295')}</button>
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-md border border-input mt-4">
                <p>{t('settings.ObsConnectionSettings.296')}<br />{t('settings.ObsConnectionSettings.297')}</p>
              </div>

              <div className="mt-4">
                <ObsSafeSetup
                  connected={isObsConnected}
                  disabled={!isObsConnected || obsStatusLoading || obsReachLoading}
                  onBusyChange={setObsSetupLoading}
                  onOpenGuide={onOpenOBSGuide}
                />
              </div>
              {isObsConnected && (
                <div className="mt-6 pt-6 border-t border-border space-y-4">
                  <h3 className="text-sm font-bold text-foreground">{t('settings.ObsConnectionSettings.298')}</h3>
                  <div className="space-y-3">

                    <button
                      type="button"
                      onClick={handleObsReachCheck}
                      disabled={obsSetupLoading || obsReachLoading || !reachListenersReady}
                      className="w-full py-2 bg-muted border border-border text-foreground rounded-lg hover:bg-muted/80 transition-all font-bold disabled:opacity-50"
                    >
                      {obsReachLoading ? t('settings.ObsConnectionSettings.299') : t('settings.ObsConnectionSettings.300')}
                    </button>
                    {!reachListenersReady && <p role="status" className="text-xs text-muted-foreground">{t('obsReach.monitorUnavailable')}</p>}

                    {obsReachResult && (
                      <div className="text-xs bg-muted/50 border border-border rounded-md p-3 space-y-2">
                        {obsReachResult.verification && <div className="text-muted-foreground space-y-1">
                          <p>{t('obsReach.record', { source: obsReachResult.verification.source, time: new Date(obsReachResult.verification.checkedAtUnixMs).toLocaleString(locale) })}</p>
                          <details><summary>{t('obsReach.diagnostics')}</summary><p>{t('obsReach.conditions', { connection: obsReachResult.verification.connectionGeneration, setup: obsReachResult.verification.setupGeneration, source: obsReachResult.verification.sourceGeneration, settings: obsReachResult.verification.targetSettingsGeneration, engine: obsReachResult.verification.audioEngineEpoch, revision: obsReachResult.verification.audioConditionsRevision })}</p></details>
                          {obsReachResult.verification.config && <p>{t('obsReach.config', { host: obsReachResult.verification.config.host, input: obsReachResult.verification.config.input ?? '—', output: obsReachResult.verification.config.output ?? '—', rate: obsReachResult.verification.config.sample_rate ?? '—', buffer: obsReachResult.verification.config.buffer_size ?? t('obsReach.defaultBuffer') })}</p>}
                        </div>}
                        <p className="text-muted-foreground">{t('obsReach.scope')}</p>
                        <p className="text-muted-foreground">{t('obsReach.monitorLimits')}</p>
                        {!reachCurrent && obsReachResult.reached !== 'unsupported' ? <p role="status" className="text-warning">{t('obsReach.stale')}</p> : obsReachResult.reached === 'unsupported' ? (
                          <p className="text-warning">
                            {t('settings.ObsConnectionSettings.301')}</p>
                        ) : obsReachResult.reached ? (
                          <p className="text-success font-medium">
                            {t('obsReach.confirmed')}{obsReachResult.peakDb !== undefined && (
                              <span className="text-muted-foreground font-normal ml-1">
                                {t('settings.obs.peak', { peak: obsReachResult.peakDb.toFixed(1) })}
                              </span>
                            )}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-destructive-text font-medium">
                              {t('settings.ObsConnectionSettings.304')}{obsReachResult.peakDb !== undefined && (
                                <span className="text-muted-foreground font-normal ml-1">
                                  {t('settings.obs.peak', { peak: obsReachResult.peakDb.toFixed(1) })}
                                </span>
                              )}
                            </p>
                            <p className="text-muted-foreground">
                              {t('settings.ObsConnectionSettings.306')}</p>
                            {onOpenTroubleshoot && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onOpenTroubleshoot();
                                }}
                                className="px-2.5 py-1 rounded border border-border hover:bg-muted/80 transition-colors text-foreground"
                              >
                                {t('settings.ObsConnectionSettings.307')}</button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <details className="rounded border border-border p-3 space-y-3">
                <summary className="cursor-pointer font-semibold">{t('structure.sceneRouting')}</summary>
                <ObsModeRoutingSettings />
              </details>
            </div>
  );
}
