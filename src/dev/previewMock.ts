// 開発サーバーだけで読み込む。?mock=<状態> のとき、Tauri なしのブラウザで画面を再現する。
// 用途: Pencil などのデザインツールへの取り込み、部品の見た目確認。音声処理・IPC の挙動確認には使わない。
// vite.config.ts の serve 専用プラグインが main.tsx より前に挿入するため、本番ビルドには含まれない。
import { installTauriMock, type TauriMockOptions } from './tauriMock';

type Preset = { mock: Omit<TauriMockOptions, 'strict' | 'nativeMeterProfile'>; storage: Record<string, string> };

const configured = {
    vst_host_wizard_done: 'true',
    vst_host_setup_goal: 'obs',
    auralyn_vst_panel_open: 'false',
    vst_host_audio_config: JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }),
};

// e2e/browser の liveHome / stoppedHome と同じ組み合わせに揃える。
const presets: Record<string, Preset> = {
    'live-home': { mock: { liveHome: true, stoppedHome: false, registeredModes: true, builtinEnabled: false }, storage: configured },
    'live-home-builtin': { mock: { liveHome: true, stoppedHome: false, registeredModes: true, builtinEnabled: true }, storage: configured },
    'stopped-home': { mock: { liveHome: true, stoppedHome: true, registeredModes: true, builtinEnabled: false }, storage: configured },
    'first-run': { mock: { liveHome: false, stoppedHome: false, registeredModes: false, builtinEnabled: false }, storage: {} },
};

const name = new URLSearchParams(location.search).get('mock');
if (name !== null) {
    const preset = presets[name];
    if ('__TAURI_INTERNALS__' in window) {
        console.warn('[preview-mock] Tauri 上では模擬応答を使いません。');
    } else if (!preset) {
        console.warn(`[preview-mock] 未定義の状態: ${name}。使える値: ${Object.keys(presets).join(', ')}`);
    } else {
        // 開発用ブラウザの保存値を上書きする。プレビュー専用のブラウザ・プロファイルで使う。
        for (const [key, value] of Object.entries(preset.storage)) localStorage.setItem(key, value);
        installTauriMock({ ...preset.mock, nativeMeterProfile: false, strict: false });
        console.info(`[preview-mock] ${name} で起動しました。未定義の IPC は window.__e2eUnexpected に記録します。`);
    }
}
