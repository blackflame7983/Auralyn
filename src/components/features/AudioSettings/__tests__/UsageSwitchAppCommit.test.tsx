import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '@/api/audio';
import { message } from '@/i18n/messages';
import { REVIEW_KEY } from '@/api/migration';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { AudioPreferences } from '@/lib/audioPreferences';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const voiceSource = { kind: 'device', config: { purpose: 'voice' } } as const;
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512, inputSource: voiceSource };
const appRecord = {
    host: 'Wasapi', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
    inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'endpoint', purpose: 'music' } },
} as const;
const candidate = { id: 'app-1', appKey: 'a'.repeat(64), name: 'Player', routes: [{ id: 'endpoint', name: 'Headphones', muted: false }] };
const devices = {
    inputs: [
        { host: 'Wasapi', name: 'Mic', channels: 2, is_input: true, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'CABLE Output', channels: 2, is_input: true, is_default: false, index: 1 },
    ],
    outputs: [
        { host: 'Wasapi', name: 'Headphones', channels: 2, is_input: false, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'USB Headphones', channels: 2, is_input: false, is_default: false, index: 1 },
    ],
};
const DISPLAY_KEY = 'auralyn_display_purpose';
const USAGE_KEY = 'auralyn_usage_devices';

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    localStorage.setItem(DISPLAY_KEY, 'voice');
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: appRecord }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });


const KEYS = ['vst_host_audio_config', 'auralyn_usage_devices', DISPLAY_KEY, REVIEW_KEY] as const;
const stored = () => Object.fromEntries(KEYS.map(key => [key, localStorage.getItem(key)]));

// 表示の保存だけが失敗する。times を省くと、巻き戻しの書き込みも失敗させる。
function failDisplayWrites(times = Infinity) {
    const original = Storage.prototype.setItem;
    let remaining = times;
    Storage.prototype.setItem = function (key, value) {
        if (key === DISPLAY_KEY && remaining > 0) { remaining -= 1; throw new Error('容量不足'); }
        return original.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = original; };
}

// 使い道の記録の保存だけが失敗する。times 回だけ失敗し、元へ戻す書き込みは通す。
function failUsageDeviceWrites(times = Infinity) {
    const original = Storage.prototype.setItem;
    let remaining = times;
    Storage.prototype.setItem = function (key, value) {
        if (key === USAGE_KEY && remaining > 0) { remaining -= 1; throw new Error('容量不足'); }
        return original.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = original; };
}

// saved を渡すと、その接続を保存済みの接続として始める。表示 voice のまま入力の用途だけ music にして、既存の不一致を作れる。
async function chooseApp(saved: AudioPreferences = config) {
    localStorage.setItem('vst_host_audio_config', JSON.stringify(saved));
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([candidate]);
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const stop = vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onConfigChange = vi.fn<(next: { inputSource?: unknown; host: string }, options?: { audioStarted: true }) => Promise<void>>(async next => {
        localStorage.setItem('vst_host_audio_config', JSON.stringify(next));
    });
    const onEngineRestarted = vi.fn(async () => 'completed' as const);
    const before = stored();
    const view = () => <AudioSettingsModal isOpen isAudioRunning currentConfig={saved} onClose={onClose} onConfigChange={onConfigChange} onEngineRestarted={onEngineRestarted} />;
    render(view());
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '使い道を切り替えます' })).getByRole('button', { name: '切り替える' }));
    const app = await screen.findByRole('combobox', { name: message('ja', 'processInput.app') });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Player' })).toBeInTheDocument());
    fireEvent.change(app, { target: { value: 'app-1' } });
    const save = screen.getByRole('button', { name: '接続を保存して再起動' });
    await waitFor(() => expect(save).toBeEnabled());
    return { start, restart, stop, onClose, onConfigChange, onEngineRestarted, before, save, view };
}

const sameAsBefore = (before: ReturnType<typeof stored>) => {
    expect(stored()).toEqual(before);
    expect(readDisplayPurpose()).toBe('voice');
};

describe('アプリの音声を保存したあと、表示の確定に失敗したとき', () => {
    it('切り替え全体の失敗として、元の接続で再起動し、VST を戻し、音声・親・保存値・表示・記録を切り替え前へ戻す', async () => {
        const { start, restart, onClose, onConfigChange, onEngineRestarted, before, save } = await chooseApp();
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            expect(await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }))).toBeVisible();
        } finally { unpatch(); }
        expect(start).toHaveBeenCalledOnce();
        expect(restart).toHaveBeenCalledOnce();
        expect(restart.mock.calls[0].slice(0, 5)).toEqual(['Wasapi', 'Mic', 'Headphones', 512, 48000]);
        expect(onEngineRestarted).toHaveBeenCalledOnce();
        expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'Wasapi', input: 'Mic', output: 'Headphones', inputSource: voiceSource }));
        sameAsBefore(before);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
        expect(screen.getByRole('button', { name: '切り替える' })).toBeEnabled();
        // 失敗の通知は上に出る。保存の操作でページが下へ送られていても、通知へ焦点を移す。
        await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    });

    it('理由は「理由：…」の文として添え、次にすることを示す。接続の適用の失敗の操作（設定に戻って再試行・ホームへ戻る）は出さない', async () => {
        const { before, save } = await chooseApp();
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            const alert = await screen.findByRole('alert');
            expect(alert).toHaveTextContent('ホームの表示を切り替えられなかったため、接続を元に戻しました。理由：容量不足。もう一度切り替えるか、そのまま使ってください。');
        } finally { unpatch(); }
        expect(screen.queryByRole('button', { name: message('ja', 'settings.AudioSettingsModal.031') })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('ja', 'settings.returnHome') })).not.toBeInTheDocument();
        sameAsBefore(before);
    });

    it('元へ戻したら接続の下書きも捨て、保存欄は変更なしで押せず、画面の選択・入力の用途・保存値が切り替え前と一致する', async () => {
        const { before, save } = await chooseApp();
        expect(screen.getByText(message('ja', 'settings.connection.changes', { fields: '' }), { exact: false })).toBeVisible();
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        expect(screen.getByText(message('ja', 'settings.connection.unchanged'))).toBeVisible();
        expect(screen.queryByText(message('ja', 'settings.connection.changes', { fields: '' }), { exact: false })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '接続を保存して再起動' })).toBeDisabled();
        expect(screen.queryByRole('combobox', { name: message('ja', 'processInput.app') })).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic');
        expect(screen.getByRole('combobox', { name: '出力先' })).toHaveValue('Headphones');
        sameAsBefore(before);
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ inputSource: voiceSource });
    });

    it('そのあとに接続欄を編集して保存すると、編集が普通に保存される（表示の確定だけを繰り返さない）', async () => {
        const { start, onClose, onConfigChange, before, save } = await chooseApp();
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        sameAsBefore(before);

        fireEvent.change(screen.getByRole('combobox', { name: '出力先' }), { target: { value: 'USB Headphones' } });
        const retry = screen.getByRole('button', { name: '接続を保存して再起動' });
        await waitFor(() => expect(retry).toBeEnabled());
        fireEvent.click(retry);
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(start).toHaveBeenCalledTimes(2);
        expect(start.mock.calls[1][2]).toBe('USB Headphones');
        const [saved, saveOptions] = onConfigChange.mock.lastCall ?? [];
        expect(saved).toMatchObject({ output: 'USB Headphones', inputSource: voiceSource });
        expect(saveOptions).toEqual({ audioStarted: true });
        // 下書きは捨てているので、保存するのは切り替え前の入力元に、編集した出力先だけを替えた接続。表示も入力の用途も配信・通話のまま。
        expect(readDisplayPurpose()).toBe('voice');
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ output: 'USB Headphones', inputSource: voiceSource });
    });

    it('そのあとに変更を捨てて画面を離れ、開き直しても、表示・入力の用途・保留・記録が切り替え前と一致する', async () => {
        const { before, save, view } = await chooseApp();
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        cleanup();
        render(view());
        await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
        sameAsBefore(before);
        expect(screen.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
        expect(screen.queryByRole('button', { name: message('ja', 'purpose.align') })).not.toBeInTheDocument();
        const opener = screen.getByRole('button', { name: '切り替える' });
        expect(opener).toBeEnabled();
        expect(opener).not.toHaveAccessibleDescription(message('ja', 'purpose.blockedPending'));
    });

    it('元へ戻す再起動も失敗したら、音声を元の接続で再開できていないことを出す。保存値と表示は元へ戻す', async () => {
        const { restart, before, save } = await chooseApp();
        restart.mockRejectedValue(new Error('再開できない'));
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            const alert = await screen.findByRole('alert');
            expect(alert).toHaveTextContent(message('ja', 'purpose.commitRestoreFailed', { targets: message('ja', 'wizard.rewind.audio'), reason: '容量不足、再開できない' }));
            // 元へ戻せなかったときだけ、ホームで確かめる操作を出す。設定へ戻って再試行は出さない。
            expect(screen.getByRole('button', { name: message('ja', 'settings.returnHome') })).toBeVisible();
            expect(screen.queryByRole('button', { name: message('ja', 'settings.AudioSettingsModal.031') })).not.toBeInTheDocument();
        } finally { unpatch(); }
        sameAsBefore(before);
    });

    it('保存値と表示を元へ戻せなかったときは、その対象を出す', async () => {
        const { save } = await chooseApp();
        const unpatch = failDisplayWrites();
        try {
            fireEvent.click(save);
            const alert = await screen.findByRole('alert');
            expect(alert).toHaveTextContent(message('ja', 'purpose.commitRestoreFailed', { targets: message('ja', 'wizard.rewind.saved'), reason: '容量不足' }));
        } finally { unpatch(); }
    });

    it('切り替え前に音声が動いていなかったときは、元へ戻すとき再起動せず、新しい接続で動き出した音声を止める', async () => {
        vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([candidate]);
        const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
        const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
        const stop = vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined);
        const onConfigChange = vi.fn(async (next: { host: string }) => { localStorage.setItem('vst_host_audio_config', JSON.stringify(next)); });
        const before = stored();
        render(<AudioSettingsModal isOpen isAudioRunning={false} currentConfig={config} onClose={vi.fn()} onConfigChange={onConfigChange} onEngineRestarted={vi.fn(async () => 'completed' as const)} />);
        await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
        fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: '使い道を切り替えます' })).getByRole('button', { name: '切り替える' }));
        const app = await screen.findByRole('combobox', { name: message('ja', 'processInput.app') });
        await waitFor(() => expect(screen.getByRole('option', { name: 'Player' })).toBeInTheDocument());
        fireEvent.change(app, { target: { value: 'app-1' } });
        const save = screen.getByRole('button', { name: /接続を保存/ });
        await waitFor(() => expect(save).toBeEnabled());
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        expect(start).toHaveBeenCalledOnce();
        expect(restart).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledOnce();
        sameAsBefore(before);
    });
});

describe('表示と入力の用途が食い違ったまま切り替え、表示の確定に失敗したとき', () => {
    // 表示は配信・通話、保存済みの入力の用途は音楽鑑賞。仕様が認める既存の不一致で、「そろえる」が出る。
    const mismatched: AudioPreferences = { ...config, inputSource: { kind: 'device', config: { purpose: 'music' } } };

    it('機器の欄を、元の機器・入力元・保存値のとおり戻す。保存欄は変更なしで押せない', async () => {
        const { before, save } = await chooseApp(mismatched);
        const unpatch = failDisplayWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic');
        expect(screen.getByRole('combobox', { name: '出力先' })).toHaveValue('Headphones');
        expect(screen.queryByRole('combobox', { name: message('ja', 'processInput.app') })).not.toBeInTheDocument();
        expect(screen.getByText(message('ja', 'settings.connection.unchanged'))).toBeVisible();
        expect(screen.getByRole('button', { name: '接続を保存して再起動' })).toBeDisabled();
        sameAsBefore(before);
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ inputSource: mismatched.inputSource });
        expect(screen.getByText(message('ja', 'purpose.mismatch', { display: message('ja', 'purpose.voice'), input: message('ja', 'purpose.music') }))).toBeVisible();
        expect(screen.getByRole('button', { name: message('ja', 'purpose.align') })).toBeVisible();
    });
});

describe('保留した切り替えを保存したとき、切り替え先の使い道の記録を残せなかったとき', () => {
    async function editOutputAndSave() {
        const started = await chooseApp();
        fireEvent.change(screen.getByRole('combobox', { name: '出力先' }), { target: { value: 'Headphones' } });
        await waitFor(() => expect(started.save).toBeEnabled());
        return started;
    }

    it('切り替え全体の失敗として、表示・音声設定・両方の使い道の記録を切り替え前へ戻す', async () => {
        const { restart, onClose, onConfigChange, onEngineRestarted, before, save } = await editOutputAndSave();
        const unpatch = failUsageDeviceWrites(1);
        try {
            fireEvent.click(save);
            expect(await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }))).toBeVisible();
        } finally { unpatch(); }
        expect(restart).toHaveBeenCalledOnce();
        expect(restart.mock.calls[0].slice(0, 5)).toEqual(['Wasapi', 'Mic', 'Headphones', 512, 48000]);
        expect(onEngineRestarted).toHaveBeenCalledOnce();
        expect(onConfigChange).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'Wasapi', input: 'Mic', output: 'Headphones', inputSource: voiceSource }));
        sameAsBefore(before);
        expect(JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}')).toMatchObject({ voice: { output: 'Headphones' }, music: { output: 'USB Headphones' } });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
        expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic');
        expect(screen.getByText(message('ja', 'settings.connection.unchanged'))).toBeVisible();
    });

    it('保存の失敗を握りつぶさず、保留も残さない。切り替えの操作を、また押せる', async () => {
        const { save } = await editOutputAndSave();
        const unpatch = failUsageDeviceWrites(1);
        try {
            fireEvent.click(save);
            await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
        } finally { unpatch(); }
        const opener = screen.getByRole('button', { name: '切り替える' });
        expect(opener).toBeEnabled();
        expect(opener).not.toHaveAccessibleDescription(message('ja', 'purpose.blockedPending'));
    });
});

describe('切り替えを伴わない普通の保存で、使い道の記録を残せなかったとき', () => {
    it('接続の保存は済んでいるため、これまでどおり保存を成功として閉じる', async () => {
        vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
        vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
        const onClose = vi.fn();
        const onConfigChange = vi.fn(async (next: { host: string }) => { localStorage.setItem('vst_host_audio_config', JSON.stringify(next)); });
        render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={onClose} onConfigChange={onConfigChange} onEngineRestarted={vi.fn(async () => 'completed' as const)} />);
        await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
        fireEvent.change(screen.getByRole('combobox', { name: '出力先' }), { target: { value: 'USB Headphones' } });
        const save = screen.getByRole('button', { name: '接続を保存して再起動' });
        await waitFor(() => expect(save).toBeEnabled());
        const unpatch = failUsageDeviceWrites();
        try {
            fireEvent.click(save);
            await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        } finally { unpatch(); }
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ output: 'USB Headphones' });
    });
});
