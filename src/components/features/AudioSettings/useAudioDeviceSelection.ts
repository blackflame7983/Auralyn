import { notice, type SettingsNotice } from './settingsNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type AudioDevice, type AudioDeviceList } from '../../../api/audio';
import { readAudioPreferences, readCachedAudioDevices, type AudioPreferences } from '../../../lib/audioPreferences';
import { defaultAudioDevice } from '@/lib/audioDevices';

interface SelectionOptions {
  isOpen: boolean;
  currentSampleRate?: number;
  currentBufferSize?: number;
  currentConfig?: AudioPreferences;
  onError: (message: SettingsNotice | null) => void;
}

// 列挙結果と稼働中機器の補完値で表記が異なることがある。同じドライバの候補を分断しない。
const normalizeHosts = (devices: AudioDeviceList): AudioDeviceList => {
  const hosts = new Map<string, string>();
  const normalize = (device: AudioDeviceList['inputs'][number]) => {
    const key = device.host.toLowerCase();
    if (!hosts.has(key)) hosts.set(key, device.host);
    return { ...device, host: hosts.get(key)! };
  };
  return { ...devices, inputs: devices.inputs.map(normalize), outputs: devices.outputs.map(normalize) };
};

export const audioDeviceKey = (device: AudioDevice) => device.id ? `id:${device.id}` : device.name;
const uniqueByName = (devices: AudioDevice[], name: string) => {
  const matches = devices.filter(device => device.name === name);
  return matches.length === 1 ? matches[0] : undefined;
};

// 一覧の取得・選択復元・バッファ候補を画面の描画と適用処理から分離する。
export function useAudioDeviceSelection({ isOpen, currentSampleRate, currentBufferSize, currentConfig, onError }: SelectionOptions) {
  const requestRevision = useRef(0);
  const active = useRef(false);
  const [loading, setLoading] = useState(false);
  const [devices, setDevices] = useState<AudioDeviceList>(() => normalizeHosts(readCachedAudioDevices()));
  const [selectedHost, setSelectedHost] = useState<string>('');
  const [selectedInputKey, setSelectedInputKey] = useState('');
  const [selectedOutputKey, setSelectedOutputKey] = useState('');
  const [selectedBufferSize, setSelectedBufferSize] = useState<number>(currentBufferSize || 512);
  const [selectedSampleRate, setSelectedSampleRate] = useState<number>(currentSampleRate || 48000);
  const restoreKey = (list: AudioDevice[], targetHost: string, input: boolean) => {
    const saved = readAudioPreferences() ?? currentConfig;
    const candidates = list.filter(device => device.host.toLowerCase() === targetHost.toLowerCase());
    if (saved?.host.toLowerCase() === targetHost.toLowerCase()) {
      const id = input ? saved.inputId : saved.outputId;
      const name = input ? saved.input : saved.output;
      const device = id ? candidates.find(item => item.id === id) : name ? uniqueByName(candidates, name) : undefined;
      return device ? audioDeviceKey(device) : '';
    }
    const device = defaultAudioDevice(candidates, input);
    return device ? audioDeviceKey(device) : '';
  };
  const restoreDeviceSelection = (result: AudioDeviceList) => {
      // Extract available hosts
      const hosts = Array.from(new Set([...result.inputs, ...result.outputs].map(d => d.host)));

      const saved = readAudioPreferences() ?? currentConfig;
      const currentHost = saved?.host ?? '';


      if (hosts.length > 0) {
        // If we don't have a host, or the current one is invalid, pick a default
        // 保存値のWASAPIと列挙名のWasapiは同じドライバ。表記差でASIOへ切り替えない。
        const requestedHost = currentHost || selectedHost;
        const effectiveHost = hosts.find(host => host.toLowerCase() === requestedHost.toLowerCase()) ?? requestedHost;

        if (!effectiveHost || !hosts.includes(effectiveHost)) {
          // 未設定では共有のWASAPIから始める。ASIOは保存済みか、利用者が選んだ場合だけ使う。
          const defaultHost = hosts.find(h => h.toLowerCase() === 'wasapi')
            ?? hosts.find(h => !h.toLowerCase().includes('asio')) ?? '';
          setSelectedHost(defaultHost);
        } else {
          // Ensure state is synced with effective host (fixes closure staleness)
          setSelectedHost(effectiveHost);

          setSelectedInputKey(restoreKey(result.inputs, effectiveHost, true));
          setSelectedOutputKey(restoreKey(result.outputs, effectiveHost, false));
        }
      } else {
        setSelectedHost('');
        setSelectedInputKey('');
        setSelectedOutputKey('');
      }
  };

  const fetchDevices = async (force: boolean = false, restoreSelection: boolean = true) => {
    if (force || (devices.inputs.length === 0 && devices.outputs.length === 0)) {
      setLoading(true);
    }
    onError(null);
    const request = ++requestRevision.current;
    try {
      const result = normalizeHosts(await audioApi.getDevices(force));
      if (!active.current || request !== requestRevision.current) return;
      setDevices(result);
      localStorage.setItem('vst_host_cached_devices', JSON.stringify(result));
      if (restoreSelection) restoreDeviceSelection(result);
    } catch (err) {
      if (!active.current || request !== requestRevision.current) return;
      console.error('Failed to get devices:', err);
      onError(notice('settings.useAudioDeviceSelection.439'));
    } finally {
      if (active.current && request === requestRevision.current) setLoading(false);
    }
  };


  // Filter devices based on selected host
  const isAsio = useMemo(() => selectedHost.toLowerCase().includes('asio'), [selectedHost]);

  const filteredInputs = useMemo(() =>
    devices.inputs.filter(d => d.host === selectedHost),
    [devices.inputs, selectedHost]);

  const filteredOutputs = useMemo(() =>
    devices.outputs.filter(d => d.host === selectedHost),
    [devices.outputs, selectedHost]);

  const selectedInputDevice = filteredInputs.find(device => audioDeviceKey(device) === selectedInputKey);
  const selectedOutputDevice = filteredOutputs.find(device => audioDeviceKey(device) === selectedOutputKey);
  const selectedInput = selectedInputDevice?.name ?? '';
  const selectedOutput = selectedOutputDevice?.name ?? '';
  const selectNamedDevice = (list: AudioDevice[], name: string, targetHost: string) => {
    const device = uniqueByName(list.filter(item => item.host.toLowerCase() === targetHost.toLowerCase()), name);
    return device ? audioDeviceKey(device) : '';
  };
  const setSelectedInput = (name: string, targetHost = selectedHost) => setSelectedInputKey(selectNamedDevice(devices.inputs, name, targetHost));
  const setSelectedOutput = (name: string, targetHost = selectedHost) => setSelectedOutputKey(selectNamedDevice(devices.outputs, name, targetHost));

  // Determine active device for capabilities (Buffer Size)
  const activeDevice = useMemo(() => {
    if (!selectedHost) return null;
    // For ASIO, Input and Output are typically same driver properties.
    // We prefer Input device info if available.
    return selectedInputDevice
      || selectedOutputDevice
      || (filteredInputs.length > 0 ? filteredInputs[0] : null);
  }, [selectedHost, selectedInputDevice, selectedOutputDevice, filteredInputs]);

  // Calculate supported buffer sizes based on active device
  const supportedBufferSizes = useMemo(() => {
    // Standard powers of 2 (Fallback / Default)
    const allCandidates = [64, 128, 256, 512, 1024, 2048, 4096];

    if (!activeDevice || !activeDevice.buffer_size_range) {
      // 未取得の能力を固定バッファと見なさない。実際の受理は開始時に確認する。
      return currentBufferSize && Number.isSafeInteger(currentBufferSize) && currentBufferSize > 0
        ? Array.from(new Set([...allCandidates, currentBufferSize])).sort((a, b) => a - b)
        : allCandidates;
    }

    const [min, max] = activeDevice.buffer_size_range;

    // Find valid candidates
    const valid = allCandidates.filter(s => s >= min && s <= max);

    // If no standard candidates fit (e.g. range 100-200), fallback to min/max
    if (valid.length === 0) {
      valid.push(min);
      if (max !== min) valid.push(max);
    }

    // Ensure the CURRENT running buffer size is always an option (Trust the Engine)
    if (currentBufferSize && !valid.includes(currentBufferSize)) {
      valid.push(currentBufferSize);
    }

    return valid.sort((a, b) => a - b);
  }, [activeDevice, isAsio, currentBufferSize]);

  const canChangeBufferSize = supportedBufferSizes.length > 0;
  // Auto-correct selectedBufferSize if it falls out of range
  useEffect(() => {
    if (canChangeBufferSize && supportedBufferSizes.length > 0) {
      // Trust the engine: If matches active engine config, allow it even if not in list
      if (currentBufferSize && selectedBufferSize === currentBufferSize) return;

      if (!supportedBufferSizes.includes(selectedBufferSize)) {
        // Find nearest
        const nearest = supportedBufferSizes.reduce((prev, curr) => {
          return (Math.abs(curr - selectedBufferSize) < Math.abs(prev - selectedBufferSize) ? curr : prev);
        });
        // Auto-corrected buffer size to nearest supported value
        setSelectedBufferSize(nearest);
      }
    }
  }, [canChangeBufferSize, supportedBufferSizes, selectedBufferSize, currentBufferSize]);


  // ホスト変更・一覧更新時だけ補完し、手動で未選択にした値を直後に戻さない。
  useEffect(() => {
    if (!selectedHost) return;
    setSelectedInputKey(key => filteredInputs.some(device => audioDeviceKey(device) === key) ? key : restoreKey(filteredInputs, selectedHost, true));
    setSelectedOutputKey(key => filteredOutputs.some(device => audioDeviceKey(device) === key) ? key : restoreKey(filteredOutputs, selectedHost, false));
  }, [selectedHost, filteredInputs, filteredOutputs]);

  useEffect(() => {
    active.current = isOpen;
    setLoading(false);
    if (isOpen) {
      const saved = readAudioPreferences() ?? currentConfig;
      if (saved) {
        setSelectedHost(saved.host);
        setSelectedInputKey(saved.inputId ? `id:${saved.inputId}` : saved.input ?? '');
        setSelectedOutputKey(saved.outputId ? `id:${saved.outputId}` : saved.output ?? '');
      }
      setSelectedSampleRate(currentSampleRate ?? saved?.sampleRate ?? 48000);
      setSelectedBufferSize(currentBufferSize ?? saved?.bufferSize ?? 512);
      if (devices.inputs.length === 0 && devices.outputs.length === 0) void fetchDevices();
      else {
        restoreDeviceSelection(devices);
        // 前回の登録名だけのキャッシュを、現在稼働している機器の能力で補完する。
        if (devices.inputs.some(device => device.host.toLowerCase() === 'asio' && device.channels === 0)) void fetchDevices(true, false);
      }
    }
    return () => { active.current = false; requestRevision.current++; };
  }, [isOpen]);

  // 開始結果の補正は数値だけへ同期する。機器の下書きを保存済み値へ戻さない。
  useEffect(() => {
    if (!isOpen) return;
    if (currentSampleRate) setSelectedSampleRate(currentSampleRate);
    if (currentBufferSize) setSelectedBufferSize(currentBufferSize);
  }, [isOpen, currentSampleRate, currentBufferSize]);

  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    const subscription = listen('audio-started', () => {
      if (!disposed && active.current) void fetchDevices(true, false);
    });
    void subscription.catch(() => console.warn('音声開始後の機器情報を監視できませんでした。'));
    return () => {
      disposed = true;
      void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [isOpen]);

  return {
    devices, selectedHost, setSelectedHost, selectedInput, setSelectedInput, selectedInputKey, setSelectedInputKey, selectedInputDevice,
    selectedOutput, setSelectedOutput, selectedOutputKey, setSelectedOutputKey, selectedOutputDevice, selectedBufferSize, setSelectedBufferSize,
    selectedSampleRate, setSelectedSampleRate, fetchDevices, isAsio,
    filteredInputs, filteredOutputs, activeDevice, supportedBufferSizes, canChangeBufferSize, loading,
  };
}
