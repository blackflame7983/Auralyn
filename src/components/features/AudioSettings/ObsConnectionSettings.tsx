import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { obsApi, type ObsAudioReachResult } from '../../../api/obs';
import { useObsUsage } from '../../../hooks/useObsUsage';
import { ObsSafeSetup } from './ObsSafeSetup';

interface ObsConnectionSettingsProps {
  showConfirm: (request: {
    title: string; description?: string; confirmLabel?: string;
    variant?: 'default' | 'destructive'; onConfirm: () => void;
  }) => void;
  onClose: () => void;
  onOpenOBSGuide?: () => void;
  onOpenTroubleshoot?: () => void;
}

// OBS接続の寿命はこのタブの表示に合わせ、音声デバイス設定とは独立して管理する。
export function ObsConnectionSettings({ showConfirm, onClose, onOpenOBSGuide, onOpenTroubleshoot }: ObsConnectionSettingsProps) {
  const [loading, setLoading] = useState(false);
  const [obsHost, setObsHost] = useState('localhost');
  const [obsPort, setObsPort] = useState(4455);
  const [obsPassword, setObsPassword] = useState('');
  const [isObsConnected, setIsObsConnected] = useState(false);
  const obsInUse = useObsUsage(true);
  const [obsStatusLoading, setObsStatusLoading] = useState(true);
  const [obsConnectionHint, setObsConnectionHint] = useState<string | null>(null);
  const [obsSetupLoading, setObsSetupLoading] = useState(false);
  const [obsReachLoading, setObsReachLoading] = useState(false);

  const [obsReachResult, setObsReachResult] = useState<ObsAudioReachResult | null>(null);


  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('vst_host_obs_config') ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.host === 'string') setObsHost(saved.host);
      if (Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535) setObsPort(saved.port);
      if (typeof saved.password === 'string') setObsPassword(saved.password);
    } catch { /* 保存データが壊れていても、接続先を入力して再設定できるようにする。 */ }
  }, []);

  // 再表示では接続を作り直さず、バックエンドが保持する接続・履歴へ戻る。
  useEffect(() => {
    if (!obsInUse) return;
    let active = true;
    setObsStatusLoading(true);
    obsApi.connectionStatus()
      .then(connected => { if (active) setIsObsConnected(connected); })
      .catch(() => { if (active) setObsConnectionHint('接続状態を確認できませんでした。接続先を確認してください。'); })
      .finally(() => { if (active) setObsStatusLoading(false); });
    return () => { active = false; };
  }, [obsInUse]);

  const handleConnectObs = async () => {
    setLoading(true);
    try {
      await obsApi.connect({ host: obsHost, port: obsPort, password: obsPassword });
      setIsObsConnected(true);
      setObsConnectionHint(null);
      toast.success("OBSに接続しました");
      localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: obsHost, port: obsPort, password: obsPassword }));
    } catch (e) {
      console.error(e);
      const message = `${e}`.toLowerCase();
      let hint = 'OBS側で「ツール → WebSocketサーバー設定」を開き、サーバー有効化・ポート4455・パスワード一致を確認してください。';
      if (message.includes('401') || message.includes('auth')) {
        hint = '認証に失敗しました。OBSのWebSocketパスワードと、この画面のパスワードが一致しているか確認してください。';
      } else if (message.includes('connection refused') || message.includes('failed to connect')) {
        hint = 'OBSが起動していないか、WebSocketサーバーが無効の可能性があります。OBSを起動して設定を確認してください。';
      }

      setObsConnectionHint(hint);
      toast.error("OBSへの接続に失敗しました", {
        description: hint,
        action: onOpenOBSGuide
          ? {
            label: 'ガイドを開く',
            onClick: onOpenOBSGuide,
          }
          : undefined,
      });
      setIsObsConnected(false);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnectObs = async () => {
    try {
      await obsApi.disconnect();
      setIsObsConnected(false);
      setObsConnectionHint(null);

      setObsReachResult(null);
      toast.info("切断しました");
    } catch (e) {
      console.error(e);
    }
  };

  const handleObsReachCheck = () => {
    showConfirm({
      title: '接続テストを実行しますか？',
      description: 'テストトーンを再生して OBS への到達を確認します。配信中は実行しないでください。',
      confirmLabel: 'テストを開始',
      onConfirm: async () => {
        setObsReachLoading(true);
        setObsReachResult(null);
        try {
          const result = await obsApi.checkAudioReach(2000);
          setObsReachResult(result);
          if (result.reached === 'unsupported') {
            toast.info('メーター取得がサポートされていません', {
              description: 'OBS の入力メーターを手動で確認してください。',
            });
          } else if (result.reached) {
            toast.success('OBS に音が届いています');
          } else {
            toast.error('OBS に音が届いていません', {
              description: 'ルーティング設定を確認してください。',
            });
          }
        } catch (e) {
          console.error(e);
          toast.error('接続テストに失敗しました', { description: `${e}` });
        } finally {
          setObsReachLoading(false);
        }
      },
    });
  };

  return (

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">ホスト名</label>
                <input
                  aria-label="OBSホスト名"
                  type="text"
                  value={obsHost}
                  onChange={(e) => setObsHost(e.target.value)}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="localhost"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">ポート</label>
                <input
                  aria-label="OBSポート"
                  type="number"
                  value={obsPort}
                  onChange={(e) => setObsPort(Number(e.target.value))}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="4455"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">パスワード</label>
                <input
                  aria-label="OBSパスワード"
                  type="password"
                  value={obsPassword}
                  onChange={(e) => setObsPassword(e.target.value)}
                  className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="パスワードを入力"
                />
              </div>

              <div className="pt-4">
                {!isObsConnected ? (
                  <button
                    onClick={handleConnectObs}
                    disabled={loading || obsStatusLoading}
                    className="w-full py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-all font-bold"
                  >
                    {obsStatusLoading ? "接続状態を確認中..." : loading ? "接続中..." : "接続"}
                  </button>
                ) : (
                  <button
                    onClick={handleDisconnectObs}
                    disabled={obsSetupLoading || obsReachLoading}
                    className="w-full py-2 bg-green-600/20 text-green-400 border border-green-600/50 rounded-lg hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/50 transition-all font-bold group"
                  >
                    <span className="group-hover:hidden">接続済み (クリックで切断)</span>
                    <span className="hidden group-hover:inline">切断する</span>
                  </button>
                )}
              </div>

              {obsConnectionHint && (
                <div className="text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-3 space-y-2">
                  <p className="font-bold">接続に失敗しました。次を確認してください。</p>
                  <p>{obsConnectionHint}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {onOpenOBSGuide && (
                      <button
                        onClick={onOpenOBSGuide}
                        className="px-2.5 py-1 rounded border border-destructive/40 hover:bg-destructive/10 transition-colors"
                      >
                        OBS連携ガイドを開く
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setObsHost('localhost');
                        setObsPort(4455);
                      }}
                      className="px-2.5 py-1 rounded border border-border hover:bg-muted/60 text-foreground transition-colors"
                    >
                      ホスト/ポートを既定値に戻す
                    </button>
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-md border border-input mt-4">
                <p>OBS WebSocket v5 (OBS 28+) が必要です。<br />OBS側で「ツール」→「WebSocketサーバー設定」を確認してください。</p>
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
                  <h3 className="text-sm font-bold text-foreground">OBS の設定を確認・変更</h3>
                  <div className="space-y-3">

                    <button
                      type="button"
                      onClick={handleObsReachCheck}
                      disabled={obsSetupLoading || obsReachLoading}
                      className="w-full py-2 bg-muted border border-border text-foreground rounded-lg hover:bg-muted/80 transition-all font-bold disabled:opacity-50"
                    >
                      {obsReachLoading ? 'テスト中...' : '2. 接続テスト'}
                    </button>

                    {obsReachResult && (
                      <div className="text-xs bg-muted/50 border border-border rounded-md p-3 space-y-2">
                        {obsReachResult.reached === 'unsupported' ? (
                          <p className="text-yellow-600 dark:text-yellow-400">
                            メーター取得に対応していません。OBS の音声ミキサーで「Auralyn マイク」のレベルが動くか手動で確認してください。
                          </p>
                        ) : obsReachResult.reached ? (
                          <p className="text-emerald-500 font-medium">
                            ✅ OBS に音が届いています
                            {obsReachResult.peakDb !== undefined && (
                              <span className="text-muted-foreground font-normal ml-1">
                                （ピーク {obsReachResult.peakDb.toFixed(1)} dB）
                              </span>
                            )}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-destructive font-medium">
                              ❌ OBS に音が届いていません
                              {obsReachResult.peakDb !== undefined && (
                                <span className="text-muted-foreground font-normal ml-1">
                                  （ピーク {obsReachResult.peakDb.toFixed(1)} dB）
                                </span>
                              )}
                            </p>
                            <p className="text-muted-foreground">
                              Auralyn の出力先が CABLE Input になっているか、OBS のデバイスが CABLE Output か確認してください。
                            </p>
                            {onOpenTroubleshoot && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onOpenTroubleshoot();
                                }}
                                className="px-2.5 py-1 rounded border border-border hover:bg-muted/80 transition-colors text-foreground"
                              >
                                トラブルシュートを開く
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
  );
}
