import { explicitSessionStartRequired } from '@/lib/temporarySession';
import { useMessages } from '../i18n/LocaleProvider';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '../api/audio';
import { REVIEW_KEY } from '../api/migration';
import { readAudioPreferences } from '../lib/audioPreferences';
import { liveModesApi } from '../api/liveModes';

// 重複通知をまとめ、失敗した要求自体から次の再試行を予約する。
export function useAudioRecovery() {
    const t = useMessages();
    useEffect(() => {
        let active = true;
        let recovering = false;
        let exhausted = false;
        let startingGeneration: number | null = null;
        let generation = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
            generation++;
            recovering = false;
            if (timer) clearTimeout(timer);
        };

        const errors = listen<string>('audio-stream-error', event => {
            if (!active || recovering || exhausted || !event.payload.includes('Stream Error')) return;
            if (explicitSessionStartRequired() || localStorage.getItem(REVIEW_KEY) === 'true') return;
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
                if (explicitSessionStartRequired() || localStorage.getItem(REVIEW_KEY) === 'true'
                    || JSON.stringify(readAudioPreferences()) !== snapshot) {
                    cancel();
                    return;
                }
                try {
                    const mode = await liveModesApi.request({ action: 'snapshot' });
                    if (!valid()) return;
                    let recovery = config;
                    if (mode.armed) {
                        const actual = (await audioApi.getAudioState()).config;
                        if (!valid()) return;
                        if (!actual?.host || !actual.input || !actual.output || !actual.sample_rate || !actual.buffer_size) throw new Error('本番保護中の具体的なデバイス設定を確認できません');
                        recovery = { ...config, host: actual.host, input: actual.input, output: actual.output, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size };
                    }
                    // ストリームだけを再開する。プロセスを破棄するとVSTとパラメーターも失う。
                    startingGeneration = current;
                    try {
                        await audioApi.start(recovery.host, recovery.input, recovery.output, recovery.bufferSize, recovery.sampleRate);
                    } finally {
                        // 古い要求の終了で、後から始まった復旧のStart所有権を解除しない。
                        if (startingGeneration === current) startingGeneration = null;
                    }
                    if (!valid()) return;
                    // 保護中は保持済み経路をそのまま再開し、古いUI選択でchを変更しない。
                    if (!mode.armed && config.inputChannels) await audioApi.setInputChannels(...config.inputChannels);
                    if (!valid()) return;
                    recovering = false;
                    toast.success(t('audioNotices.reconnected'));
                } catch {
                    if (!valid()) return;
                    if (attempt < 3) schedule(attempt + 1);
                    else {
                        recovering = false;
                        exhausted = true;
                        toast.error(t('audioNotices.reconnectFailed'), {
                            description: t('audioNotices.checkDevices'),
                        });
                    }
                }
            };
            toast.warning(t('audioNotices.disconnected'), {
                description: t('audioNotices.retrying'), duration: 5000,
            });
            schedule(1);
        });
        const started = listen('audio-started', () => { if (!recovering) exhausted = false; });
        const stopped = listen('audio-stopped', () => {
            // 自分のStartも停止通知を出すため、要求中以外の停止だけをキャンセルとする。
            if (startingGeneration !== generation) cancel();
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
