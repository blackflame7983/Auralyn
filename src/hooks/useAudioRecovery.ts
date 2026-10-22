import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '../api/audio';
import { REVIEW_KEY } from '../api/migration';
import { readAudioPreferences } from '../lib/audioPreferences';

// 重複通知をまとめ、失敗した要求自体から次の再試行を予約する。
export function useAudioRecovery() {
    useEffect(() => {
        let active = true;
        let recovering = false;
        let exhausted = false;
        let inFlight = false;
        let generation = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
            generation++;
            recovering = false;
            if (timer) clearTimeout(timer);
        };

        const errors = listen<string>('audio-stream-error', event => {
            if (!active || recovering || exhausted || !event.payload.includes('Stream Error')) return;
            if (localStorage.getItem(REVIEW_KEY) === 'true') return;
            const config = readAudioPreferences();
            if (!config) return;
            const snapshot = JSON.stringify(config);
            const current = ++generation;
            recovering = true;
            const valid = () => active && current === generation;

            const schedule = (attempt: number) => {
                timer = setTimeout(() => void retry(attempt), attempt * 2000);
            };
            const retry = async (attempt: number) => {
                if (!valid()) return;
                if (localStorage.getItem(REVIEW_KEY) === 'true'
                    || JSON.stringify(readAudioPreferences()) !== snapshot) {
                    cancel();
                    return;
                }
                inFlight = true;
                try {
                    // ストリームだけを再開する。プロセスを破棄するとVSTとパラメーターも失う。
                    await audioApi.start(config.host, config.input, config.output, config.bufferSize, config.sampleRate);
                    if (!valid()) return;
                    if (config.inputChannels) await audioApi.setInputChannels(...config.inputChannels);
                    if (!valid()) return;
                    recovering = false;
                    toast.success('オーディオエンジンを再接続しました');
                } catch {
                    if (!valid()) return;
                    if (attempt < 3) schedule(attempt + 1);
                    else {
                        recovering = false;
                        exhausted = true;
                        toast.error('デバイスの再接続に失敗しました', {
                            description: '設定からオーディオデバイスを確認してください。',
                        });
                    }
                } finally {
                    inFlight = false;
                }
            };
            toast.warning('オーディオデバイスの接続が切れました', {
                description: '自動復帰を試みています…', duration: 5000,
            });
            schedule(1);
        });
        const started = listen('audio-started', () => { if (!recovering) exhausted = false; });
        const stopped = listen('audio-stopped', () => {
            // 自分のStartも停止通知を出すため、要求中以外の停止だけをキャンセルとする。
            if (!inFlight) cancel();
        });
        const crashed = listen('audio-error', () => { cancel(); exhausted = true; });
        return () => {
            active = false;
            cancel();
            [errors, started, stopped, crashed].forEach(subscription => {
                void subscription.then(unlisten => unlisten()).catch(console.error);
            });
        };
    }, []);
}
