import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MdVolumeOff, MdVolumeUp } from 'react-icons/md';
import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { Slider } from '@/components/ui/slider';
import { useMessages } from '@/i18n/LocaleProvider';
import { clientErrorNotice, type ClientErrorNotice } from '@/lib/clientError';
import { addAppVisibilityListener, isAppHidden, removeAppVisibilityListener } from '@/lib/appVisibility';
import { audioApi } from '@/api/audio';
import { readOutputGainStatus, restoreSavedOutputGain, setOutputGain as applyOutputGain } from '@/api/outputGain';

let mountedControls = 0;

export function focusOutputGain() {
  const target = document.querySelector<HTMLElement>('#master-output-gain [role="slider"]');
  if (!target) return;
  target.focus();
  target.dataset.attention = '';
  window.setTimeout(() => { delete target.dataset.attention; }, 1200);
}

export function OutputGainControl() {
  const rejectSecondMount = import.meta.env.DEV || import.meta.env.MODE === 'test';
  useEffect(() => {
    mountedControls += 1;
    if (mountedControls > 1 && rejectSecondMount) {
      mountedControls -= 1;
      throw new Error('OutputGainControl is already mounted');
    }
    return () => { mountedControls -= 1; };
  }, [rejectSecondMount]);
  const t = useMessages();
  const [outputGain, setOutputGain] = useState<number>(() => {
    const saved = localStorage.getItem('vst_host_output_gain');
    return saved ? parseFloat(saved) : 100;
  });
  const outputGainDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gainRequestGeneration = useRef(0);
  const [gainError, setGainError] = useState<{ notice: ClientErrorNotice; requestedGain: number } | null>(null);
  const [gainRestoreError, setGainRestoreError] = useState<ClientErrorNotice | null>(null);
  const gainMessage = renderNotice(t, gainError?.notice ?? gainRestoreError);

  const handleOutputGainChange = useCallback((values: number[]) => {
    const generation = ++gainRequestGeneration.current;
    setGainError(null);
    window.dispatchEvent(new Event('output-gain-intent'));
    const pct = values[0];
    setOutputGain(pct);
    if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current);
    outputGainDebounce.current = setTimeout(() => {
      // 状態取得で表示が実値へ戻っても、失敗した要求値を再試行できるように残す。
      applyOutputGain(pct / 100).catch((e) => {
        if (generation === gainRequestGeneration.current) setGainError({ notice: clientErrorNotice(e), requestedGain: pct });
      });
    }, 30);
  }, []);

  // reloadは読取だけ。実際の開始通知を受けた時だけ保存gainの初期化を行う。
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let applying = false;
    let applyAgain = false;
    let restorePending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const applyGain = async () => {
      if (disposed) return;
      if (applying) {
        applyAgain = true;
        return;
      }
      applying = true;
      const saved = localStorage.getItem('vst_host_output_gain');
      const pct = saved ? parseFloat(saved) : 100;
      try {
        // 保存音量の初期化は観測に付随する処理。新しいchildは要求しない。
        const process = await audioApi.getAudioState();
        if (disposed) return;
        if (!process.is_running) {
          restorePending = true;
          setGainRestoreError(null);
          return;
        }
        await restoreSavedOutputGain(pct / 100);
        restorePending = false;
        if (!disposed) setGainRestoreError(null);
      } catch (e) {
        restorePending = true;
        if (!disposed) setGainRestoreError(clientErrorNotice(e));
      } finally {
        applying = false;
        if (applyAgain && !disposed) {
          applyAgain = false;
          void applyGain();
        }
      }
    };

    const sync = (event: Event) => {
      if (!disposed) setOutputGain((event as CustomEvent<number>).detail);
    };
    window.addEventListener('output-gain-sync', sync);
    const refresh = async () => {
      if (refreshing || isAppHidden()) return;
      refreshing = true;
      try {
        if (restorePending) await applyGain();
        else {
          const process = await audioApi.getAudioState();
          if (disposed || !process.is_running) return;
          const state = await readOutputGainStatus();
          if (!disposed && state.settled && !state.streamFailed && Number.isFinite(state.confirmedGain)) {
            setOutputGain(state.confirmedGain * 100);
          }
        }
      } catch {
        /* エンジン停止中は保存値を維持する。 */
      } finally {
        refreshing = false;
      }
    };
    // mount直後のstatusはLSへ公開しない。初回bootstrap待ちの保存音量を保持する。
    const unlisten = listen('audio-started', () => { void applyGain(); });
    const initialize = async () => {
      try {
        await unlisten;
        if (disposed) return;
        await refresh();
        if (!disposed) timer = setInterval(() => void refresh(), 1000);
      } catch (e) {
        if (!disposed) setGainRestoreError(clientErrorNotice(e));
      }
    };
    void initialize();
    const visibility = () => { if (!isAppHidden()) void refresh(); };
    addAppVisibilityListener(visibility);

    return () => {
      disposed = true;
      clearInterval(timer);
      removeAppVisibilityListener(visibility);
      window.removeEventListener('output-gain-sync', sync);
      void unlisten.then(f => f()).catch(() => {});
    };
  }, []);

  useEffect(() => () => { if (outputGainDebounce.current) clearTimeout(outputGainDebounce.current); }, []);

  return <div className="flex min-w-0 shrink-0 flex-col gap-1.5">
    <div className="flex min-w-0 items-center gap-2">
      {outputGain === 0 ? <MdVolumeOff aria-hidden="true" className="w-4 h-4 text-warning flex-shrink-0" /> : <MdVolumeUp aria-hidden="true" className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
      <span aria-hidden="true" className="min-w-0 flex-1 text-ui-control font-medium text-muted-foreground">{t('master.outputGain')}</span>
      <span className="w-[6ch] min-w-[6ch] shrink-0 whitespace-nowrap text-right text-ui-support font-mono tabular-nums text-muted-foreground">
        {Math.round(outputGain * 10) / 10}%
      </span>
    </div>
    <Slider
      id="master-output-gain"
      aria-label={t('master.outputGain')}
      aria-valuetext={`${outputGain}%`}
      value={[outputGain]}
      onValueChange={handleOutputGainChange}
      min={0}
      max={200}
      step={1}
      className="w-full"
      onDoubleClick={() => handleOutputGainChange([100])}
    />
    {gainMessage && <div className="flex min-w-0 flex-col items-start gap-2">
      <span role="alert" className="min-w-0 whitespace-normal break-words text-ui-support leading-4 text-warning" title={gainMessage}>{t('master.gainUnknown')}</span>
      <button type="button" onClick={() => handleOutputGainChange([gainError?.requestedGain ?? outputGain])} className="rounded-control border border-border px-3 py-1.5 text-ui-support">{t('common.retry')}</button>
    </div>}
  </div>;
}
