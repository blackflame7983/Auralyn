import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { displayAudioHost } from '@/lib/audioDevices';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { preparationReach } from '@/lib/preparation';
import { message, type MessageKey } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useId, useRef, useState } from 'react';
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
export function ObsConnectionSettings({ showConfirm, onOpenOBSGuide, onOpenTroubleshoot }: ObsConnectionSettingsProps) {
    const t = useMessages();
    const reasonId = useId();
    const { locale } = useLocale();
  const [loading, setLoading] = useState(false);
  const [endpoint] = useState(readObsEndpoint);
  const [obsHost, setObsHost] = useState(endpoint.host);
  const [obsPort, setObsPort] = useState(endpoint.port);
  const [obsPassword, setObsPassword] = useState('');
  const [savedCredentials, setSavedCredentials] = useState<{ host: string; port: number } | null>(null);
  const [credentialStatusLoading, setCredentialStatusLoading] = useState(true);
  const [credentialReadFailed, setCredentialReadFailed] = useState(false);
  const [useSavedPassword, setUseSavedPassword] = useState(true);
  const savedPasswordAvailable = savedCredentials?.host === obsHost.trim().toLowerCase() && savedCredentials?.port === obsPort;
  const [isObsConnected, setIsObsConnected] = useState(false);
  const isObsConnectedRef = useRef(isObsConnected);
  isObsConnectedRef.current = isObsConnected;
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
  const connectionDetails = useRef<HTMLDetailsElement>(null);
  const connectionDetailsTouched = useRef(false);

  // 翻訳の変更では購読・接続・確認をやり直さない。自己toneの通知もいったん
  // staleにしてからnativeの終了後witnessを照合し、通知を一括無視しない。
  const revalidateReach = async (record = reachRecord.current, invalidate = true) => {
    const version = ++reachValidation.current;
    if (invalidate) setReachCurrent(false);
    if (!record?.verification || !reachListeners.current || isAppHidden() || reachExpiredRef.current) return false;
    try {
      const current = await obsApi.audioReachCurrent(record.verification.operationId);
      if (!reachAlive.current || version !== reachValidation.current || isAppHidden() || !reachListeners.current || reachRecord.current !== record) return false;
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
      if (isAppHidden()) {
        reachRequest.current += 1;
        reachContext.current += 1;
        reachValidation.current += 1;
        setObsReachLoading(false);
        setReachCurrent(false);
        reachExpiredRef.current = true; setReachExpired(true);
      }
    };
    const refreshConnection = () => {
      const revision = connectionRevision.current;
      void obsApi.connectionStatus().then(connected => {
        if (!active || revision !== connectionRevision.current || typeof connected !== 'boolean') return;
        if (isObsConnectedRef.current && !connected && connectionDetails.current) connectionDetails.current.open = true;
        setIsObsConnected(connected);
      }).catch(() => {});
    };
    const subscriptions = ['obs://timing-invalidated', 'obs://reach-invalidated', 'audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed']
      .map(event => listen(event, () => { invalidate(); if (event === 'obs://timing-invalidated') refreshConnection(); }));
    void Promise.all(subscriptions).then(() => {
      if (active) { reachListeners.current = true; setReachListenersReady(true); }
    }).catch(() => {
      if (active) { reachContext.current += 1; reachListeners.current = false; setReachListenersReady(false); setReachCurrent(false); }
    });
    window.addEventListener('profile-fx-applied', invalidate);
    addAppVisibilityListener(visibility);
    return () => {
      active = false; reachAlive.current = false; reachListeners.current = false;
      reachRequest.current += 1; reachValidation.current += 1; reachContext.current += 1;
      window.removeEventListener('profile-fx-applied', invalidate);
      removeAppVisibilityListener(visibility);
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
      if (!active || isAppHidden() || reachExpiredRef.current) return;
      await revalidateReach(reachRecord.current, false);
      if (active && !reachExpiredRef.current) timer = setTimeout(() => { void poll(); }, 3000);
    };
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [obsReachResult, obsInUse, reachListenersReady, reachExpired]);

  useEffect(() => {
    let active = true;
    void obsApi.savedCredentials().then(value => { if (active) setSavedCredentials(value ?? null); })
      .catch(() => { if (active) { setCredentialReadFailed(true); setObsConnectionHint(notice('obs.credentialsUnavailable')); } })
      .finally(() => { if (active) setCredentialStatusLoading(false); });
    return () => { active = false; };
  }, []);

  // 再表示では接続を作り直さず、バックエンドが保持する接続・履歴へ戻る。
  useEffect(() => {
    connectionRevision.current += 1;
    setLoading(false);
    if (!obsInUse) { setIsObsConnected(false); setReachCurrent(false); reachRequest.current += 1; reachValidation.current += 1; return; }
    let active = true;
    setObsStatusLoading(true);
    obsApi.connectionStatus()
      .then(connected => { if (active) { setIsObsConnected(connected); if (!connectionDetailsTouched.current && connectionDetails.current) connectionDetails.current.open = !connected; } })
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
      await obsApi.connect({ host: obsHost, port: obsPort, password: savedPasswordAvailable && useSavedPassword ? undefined : obsPassword, remember: true });
      // 秘密はJSの入力欄から除き、再接続はネイティブ側の保存値を使う。
      setObsPassword('');
      setSavedCredentials({ host: obsHost.trim().toLowerCase(), port: obsPort });
      setUseSavedPassword(true);
      localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: obsHost.trim(), port: obsPort }));
      if (revision !== connectionRevision.current || isAppHidden()) return;
      setIsObsConnected(true);
      if (connectionDetails.current) connectionDetails.current.open = false;
      setObsConnectionHint(null);
      toast.success(notify('settings.ObsConnectionSettings.267'));
    } catch (e) {
      if (revision !== connectionRevision.current || isAppHidden()) return;
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
      if (connectionDetails.current) connectionDetails.current.open = true;
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
        if (!reachAlive.current || !reachListeners.current || isAppHidden()) return;
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
          if (!reachAlive.current || request !== reachRequest.current || isAppHidden()) return;
          reachRecord.current = result;
          setObsReachResult(result);
          const current = await revalidateReach(result);
          if (!reachAlive.current || request !== reachRequest.current || isAppHidden()) return;
          if (current || result.reached === 'unsupported') preparationReach.record(result);
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
          if (reachAlive.current && request === reachRequest.current && !isAppHidden()) toast.error(t('settings.ObsConnectionSettings.279'));
        } finally {
          if (reachAlive.current && request === reachRequest.current) setObsReachLoading(false);
        }
      },
    });
  };

  return (

            <div className="space-y-4">
              {/* 接続 → 到達確認 → 設定の変更 → 連動 の順に並べる。 */}
              <section aria-label={t('obs.section.connect')} className="space-y-3">
                <h3 className="text-ui-heading font-semibold">{t('obs.section.connect')}</h3>
                {isObsConnected && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDisconnectObs}
                      disabled={obsSetupLoading || obsReachLoading}
                      aria-describedby={obsSetupLoading || obsReachLoading ? `${reasonId}-disconnect` : undefined}
                    >
                      {t('settings.ObsConnectionSettings.292')}
                    </Button>
                    {(obsSetupLoading || obsReachLoading) && <p id={`${reasonId}-disconnect`} className="text-ui-support text-muted-foreground">{t('settings.obs.operationBusy')}</p>}
                  </div>
                )}
                {/* 入力欄は接続中も残し、接続先の確認だけできるよう折りたたむ。 */}
                <details ref={connectionDetails} open className="space-y-3">
                  <summary onClick={() => { connectionDetailsTouched.current = true; }} className="cursor-pointer text-ui-heading font-semibold">{t('obs.target')}{isObsConnected && <span role="status"> — {t('settings.obs.connectedTarget', { host: obsHost, port: obsPort })} · {t('settings.ObsConnectionSettings.291')}</span>}</summary>
                  <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Field label={t('settings.ObsConnectionSettings.280')}>
                    <Input
                      aria-label={t('settings.ObsConnectionSettings.281')}
                      disabled={loading || isObsConnected}
                      type="text"
                      value={obsHost}
                      onChange={(e) => setObsHost(e.target.value)}

                      placeholder="localhost"
                    /></Field>
                  </div>
                  <div className="space-y-2">
                    <Field label={t('settings.ObsConnectionSettings.282')}>
                    <Input
                      aria-label={t('settings.ObsConnectionSettings.283')}
                      disabled={loading || isObsConnected}
                      type="number"
                      value={obsPort}
                      onChange={(e) => setObsPort(Number(e.target.value))}

                      placeholder="4455"
                    /></Field>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-1">
                      <label className="font-medium text-muted-foreground text-ui-control">{t('settings.ObsConnectionSettings.284')}</label>
                      {!isObsConnected && <InfoPopover label={t('settings.ObsConnectionSettings.284')}>{t('obs.passwordScope')}</InfoPopover>}
                    </div>
                    <Field label={<span className="sr-only">{t('settings.ObsConnectionSettings.285')}</span>}><Input
                      aria-label={t('settings.ObsConnectionSettings.285')}
                      disabled={loading || isObsConnected}
                      type="password"
                      value={obsPassword}
                      onChange={(e) => { setObsPassword(e.target.value); setUseSavedPassword(false); }}

                      placeholder={t('settings.ObsConnectionSettings.286')}
                    /></Field>
                    {savedPasswordAvailable && <label className="flex items-center gap-2 text-muted-foreground text-ui-control"><Checkbox disabled={loading || isObsConnected} checked={useSavedPassword} onChange={event => setUseSavedPassword(event.target.checked)} />{t('obs.useSavedPassword')}</label>}
                    {(savedCredentials || credentialReadFailed) && <Button type="button" disabled={loading || isObsConnected} variant="link" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => { void obsApi.clearCredentials().then(() => { setSavedCredentials(null); setUseSavedPassword(false); setCredentialReadFailed(false); }).catch(() => setObsConnectionHint(notice('obs.credentialsUnavailable'))); }}>{t('obs.forgetPassword')}</Button>}
                  </div>

                    {isObsConnected && <p className="text-ui-support text-muted-foreground">{t('settings.ObsConnectionSettings.287')}</p>}
                  </div>
                </details>
                {!isObsConnected && (
                  <Button
                    onClick={handleConnectObs}
                    disabled={loading || obsStatusLoading || credentialStatusLoading}
                    variant="default" className="h-auto min-h-10 whitespace-normal w-fit"
                  >
                    {obsStatusLoading ? t('settings.ObsConnectionSettings.288') : loading ? t('settings.ObsConnectionSettings.289') : t('settings.ObsConnectionSettings.290')}
                  </Button>
                )}
              {obsConnectionHint && (
                <div className="text-ui-support bg-destructive/10 border border-destructive-text/30 text-destructive-text rounded-control p-3 space-y-2">
                  <p className="font-bold">{t('settings.ObsConnectionSettings.293')}</p>
                  <p>{renderNotice(t, obsConnectionHint)}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {onOpenOBSGuide && (
                      <Button
                        onClick={onOpenOBSGuide}
                        variant="destructive" className="h-auto min-h-10 whitespace-normal"
                      >
                        {t('settings.ObsConnectionSettings.294')}</Button>
                    )}
                    <Button
                      onClick={() => {
                        setObsHost('localhost');
                        setObsPort(4455);
                      }}
                      variant="outline" className="h-auto min-h-10 whitespace-normal"
                    >
                      {t('settings.ObsConnectionSettings.295')}</Button>
                  </div>
                </div>
              )}

                {!isObsConnected && (
                  <details className="text-ui-support text-muted-foreground">
                    <summary className="cursor-pointer">{t('obs.prepare')}</summary>
                    <p className="mt-2">{t('settings.ObsConnectionSettings.296')}<br />{t('settings.ObsConnectionSettings.297')}</p>
                  </details>
                )}
              </section>
              {isObsConnected && (
                <section aria-label={t('obs.section.reach')} className="space-y-3 border-t border-border pt-4">
                  <h3 className="text-foreground text-ui-heading font-semibold">{t('obs.section.reach')}</h3>
                  <div className="space-y-3">

                    <Button
                      type="button"
                      onClick={handleObsReachCheck}
                      disabled={obsSetupLoading || obsReachLoading || !reachListenersReady}
                      aria-describedby={[
                        obsSetupLoading || obsReachLoading ? `${reasonId}-reach-busy` : null,
                        !reachListenersReady ? `${reasonId}-reach-monitor` : null,
                      ].filter(Boolean).join(' ') || undefined}
                      variant="outline" className="h-auto min-h-10 whitespace-normal w-full"
                    >
                      {obsReachLoading ? t('settings.ObsConnectionSettings.299') : t('settings.ObsConnectionSettings.300')}
                    </Button>
                    {(obsSetupLoading || obsReachLoading) && <p id={`${reasonId}-reach-busy`} className="text-ui-support text-muted-foreground">{t('settings.obs.operationBusy')}</p>}
                    {!reachListenersReady && <p id={`${reasonId}-reach-monitor`} role="status" className="text-ui-support text-muted-foreground">{t('obsReach.monitorUnavailable')}</p>}

                    {obsReachResult && (
                      <div className="text-ui-support bg-muted/50 border border-border rounded-control p-3 space-y-2">
                        {obsReachResult.verification && <div className="text-muted-foreground space-y-1">
                          <p>{t('obsReach.record', { source: obsReachResult.verification.source, time: new Date(obsReachResult.verification.checkedAtUnixMs).toLocaleString(locale) })}</p>
                          <details><summary>{t('obsReach.diagnostics')}</summary><p>{t('obsReach.conditions', { connection: obsReachResult.verification.connectionGeneration, setup: obsReachResult.verification.setupGeneration, source: obsReachResult.verification.sourceGeneration, settings: obsReachResult.verification.targetSettingsGeneration, engine: obsReachResult.verification.audioEngineEpoch, revision: obsReachResult.verification.audioConditionsRevision })}</p></details>
                          {obsReachResult.verification.config && <p>{t('obsReach.config', { host: displayAudioHost(obsReachResult.verification.config.host), input: obsReachResult.verification.config.input ?? '—', output: obsReachResult.verification.config.output ?? '—', rate: obsReachResult.verification.config.sample_rate ?? '—', buffer: obsReachResult.verification.config.buffer_size ?? t('obsReach.defaultBuffer') })}</p>}
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
                              <Button
                                type="button"
                                onClick={() => onOpenTroubleshoot()}
                                variant="outline" className="h-auto min-h-10 whitespace-normal"
                              >
                                {t('settings.ObsConnectionSettings.307')}</Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}
              <section aria-label={t('settings.ObsConnectionSettings.298')} className="space-y-3 border-t border-border pt-4">
                <h3 className="text-foreground text-ui-heading font-semibold">{t('settings.ObsConnectionSettings.298')}</h3>
                <ObsSafeSetup
                  connected={isObsConnected}
                  disabled={!isObsConnected || obsStatusLoading || obsReachLoading}
                  onBusyChange={setObsSetupLoading}
                  onOpenGuide={onOpenOBSGuide}
                />
              </section>
              <details className="rounded-control border border-border p-3 space-y-3">
                <summary className="cursor-pointer text-ui-heading font-semibold">{t('structure.sceneRouting')}</summary>
                <ObsModeRoutingSettings />
              </details>
            </div>
  );
}
