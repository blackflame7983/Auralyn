import type { AudioStateInfo } from '@/api/audio';
import type { InputSource } from './inputSource';

let current: InputSource | undefined;
const listeners = new Set<() => void>();

function replace(next: InputSource | undefined): void {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    listeners.forEach(listener => listener());
}

/**
 * 既存の get_audio_state の応答から、エンジンが実際に使っている入力元を取り出して保つ。
 * 保存した設定は再起動前の選択や別経路の開始とずれうるので、操作ロックの可否のような安全側の判断はこの値も見る。
 * 取得は useAudioConfig の定期確認などが行うので、この値のための問い合わせは増やさない。停止中・取得失敗は未確認（undefined）。
 */
export function publishEngineAudioState(state: AudioStateInfo | null): void {
    replace(state?.is_running ? state.config?.input_source : undefined);
}

export function clearEngineInputSource(): void {
    replace(undefined);
}

export function readEngineInputSource(): InputSource | undefined {
    return current;
}

export function subscribeEngineInputSource(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
