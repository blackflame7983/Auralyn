import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '@/api/audio';
import { message } from '@/i18n/messages';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { requestLeave } from '@/components/layout/pageLeave';
import type { SessionRestoreOutcome } from '@/lib/rackRestoreOutcome';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const voiceSource = { kind: 'device', config: { purpose: 'voice' } } as const;
const musicSource = { kind: 'device', config: { purpose: 'music' } } as const;
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512, inputSource: voiceSource };
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
const musicRecord = { host: 'Wasapi', input: 'CABLE Output', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512, inputSource: musicSource };
const appRecord = {
    host: 'Wasapi', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
    inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'endpoint', purpose: 'music' } },
} as const;
const restartResult = { sample_rate: 48000, buffer_size: 512, channels: 2 };
const independent = { inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 1] } };

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    localStorage.setItem('auralyn_display_purpose', 'voice');
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: musicRecord }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

async function openSwitch(props: { running?: boolean; onConfigChange?: () => Promise<void>; onEngineRestarted?: () => Promise<SessionRestoreOutcome> } = {}) {
    const onConfigChange = vi.fn(props.onConfigChange ?? (async () => {}));
    const onEngineRestarted = vi.fn(props.onEngineRestarted ?? (async () => 'completed' as const));
    render(<AudioSettingsModal isOpen isAudioRunning={props.running ?? true} currentConfig={config} onClose={vi.fn()}
        onConfigChange={onConfigChange} onEngineRestarted={onEngineRestarted} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    const opener = screen.getByRole('button', { name: '切り替える' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    return { onConfigChange, onEngineRestarted, dialog, opener };
}
const confirm = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));

it('再起動のあと保存が失敗したら、元の接続で再起動し、VST を戻して、表示と保存値を元のままにする', async () => {
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const { dialog, onConfigChange, onEngineRestarted } = await openSwitch();
    onConfigChange.mockRejectedValueOnce(new Error('保存できない'));
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('表示と音声設定は元のままです');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(restart.mock.calls[0].slice(0, 5)).toEqual(['Wasapi', 'CABLE Output', 'USB Headphones', 512, 48000]);
    expect(restart.mock.calls[0][8]).toEqual(independent);
    expect(restart.mock.calls[1].slice(0, 5)).toEqual(['Wasapi', 'Mic', 'Headphones', 512, 48000]);
    expect(restart.mock.calls[1][8]).toEqual(independent);
    expect(restart.mock.calls[1][9]).toEqual({ source: voiceSource });
    expect(onEngineRestarted).toHaveBeenCalledOnce();
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic', output: 'Headphones' });
});

it('保存の途中で VST の復元が例外で失敗しても、元の接続で再起動して保存値を戻す', async () => {
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const { dialog, onEngineRestarted } = await openSwitch();
    onEngineRestarted.mockRejectedValueOnce(new Error('VST を戻せません'));
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('VST を戻せません');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(onEngineRestarted).toHaveBeenCalledTimes(2);
    expect(readDisplayPurpose()).toBe('voice');
});

it.each(['partial', 'failed'] as const)('VST の復元が %s で終わったら、切り替えの失敗として元の接続と VST へ戻す', async outcome => {
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const { dialog, onEngineRestarted } = await openSwitch();
    onEngineRestarted.mockResolvedValueOnce(outcome);
    confirm(dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(message('ja', 'purpose.vstIncomplete'));
    expect(alert).toHaveTextContent('表示と音声設定は元のままです');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(onEngineRestarted).toHaveBeenCalledTimes(2);
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic', output: 'Headphones' });
});

it('元の接続へ戻したあとの VST の復元も完了しないときは、戻せなかったことを小窓に出す', async () => {
    vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const { dialog, onEngineRestarted } = await openSwitch();
    onEngineRestarted.mockResolvedValue('partial');
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('音声を元の接続で再開できていません');
    expect(onEngineRestarted).toHaveBeenCalledTimes(2);
    expect(readDisplayPurpose()).toBe('voice');
});

it('移行の確認を完了する保存では、確認の通知が復元を始めるため、ここでは VST を二重に復元しない', async () => {
    localStorage.setItem('vst_host_migration_review_required', 'true');
    vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const onConfigChange = vi.fn(async () => { localStorage.removeItem('vst_host_migration_review_required'); });
    const onEngineRestarted = vi.fn(async () => 'completed' as const);
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={onConfigChange} onEngineRestarted={onEngineRestarted} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: message('ja', 'settings.AudioSettingsModal.030') }));
    const opener = screen.getByRole('button', { name: '切り替える' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    confirm(await screen.findByRole('alertdialog', { name: '使い道を切り替えます' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfigChange).toHaveBeenCalledOnce();
    expect(onEngineRestarted).not.toHaveBeenCalled();
    expect(readDisplayPurpose()).toBe('music');
});

it('再起動の応答を待っている間は、画面を離れる共通の操作を止める', async () => {
    let release!: (value: typeof restartResult) => void;
    const restart = vi.spyOn(audioApi, 'restart').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { dialog } = await openSwitch();
    confirm(dialog);
    await waitFor(() => expect(restart).toHaveBeenCalledOnce());
    const left = vi.fn();
    requestLeave(left);
    expect(left).not.toHaveBeenCalled();
    release(restartResult);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    requestLeave(left);
    expect(left).toHaveBeenCalledOnce();
});

it('実行中の再起動が失敗して元の音声も止まったら、元の接続で再開して VST を戻す', async () => {
    const restart = vi.spyOn(audioApi, 'restart').mockRejectedValueOnce(new Error('機器が見つかりません')).mockResolvedValue(restartResult);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: false, config: null });
    const { dialog, onConfigChange, onEngineRestarted } = await openSwitch();
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('機器が見つかりません');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(restart.mock.calls[1].slice(0, 3)).toEqual(['Wasapi', 'Mic', 'Headphones']);
    expect(onEngineRestarted).toHaveBeenCalledOnce();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange.mock.calls[0]).toEqual([expect.objectContaining({ input: 'Mic', output: 'Headphones' })]);
});

it('元の音声が動いたまま失敗したときは、再起動も VST の復元もしない', async () => {
    const restart = vi.spyOn(audioApi, 'restart').mockRejectedValue(new Error('マイクの許可がありません'));
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: { host: 'Wasapi', input: 'Mic', output: 'Headphones', sample_rate: 48000, buffer_size: 512 } });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    const { dialog, onConfigChange, onEngineRestarted } = await openSwitch();
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('マイクの許可がありません');
    expect(restart).toHaveBeenCalledOnce();
    expect(onEngineRestarted).not.toHaveBeenCalled();
    expect(onConfigChange).not.toHaveBeenCalled();
});

it('元の接続にも戻せないときは、戻せなかったことを小窓に出す', async () => {
    vi.spyOn(audioApi, 'restart').mockRejectedValue(new Error('機器が見つかりません'));
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: false, config: null });
    const { dialog } = await openSwitch();
    confirm(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('音声を元の接続で再開できていません');
    expect(readDisplayPurpose()).toBe('voice');
});

it('成功したら表示を切り替え、確定後の焦点を切り替えるボタンへ戻す', async () => {
    vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const { dialog, opener } = await openSwitch();
    confirm(dialog);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(readDisplayPurpose()).toBe('music');
    await waitFor(() => expect(opener).toHaveFocus());
});

it('アプリの音声の記録へは、自動で再開せず、表示と入力の用途を下書きにして、アプリの選択欄へ案内する。保存するまで表示も保存値も変えない', async () => {
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: appRecord }));
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
    const sources = vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([]);
    const { dialog, onConfigChange, onEngineRestarted } = await openSwitch();
    expect(dialog).toHaveTextContent('アプリ「Player」の音声でした');
    expect(dialog).not.toHaveTextContent(message('ja', 'purpose.switchRestart'));
    const before = { config: localStorage.getItem('vst_host_audio_config'), usage: localStorage.getItem('auralyn_usage_devices') };
    confirm(dialog);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(restart).not.toHaveBeenCalled();
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(onEngineRestarted).not.toHaveBeenCalled();
    expect(readDisplayPurpose()).toBe('voice');
    expect({ config: localStorage.getItem('vst_host_audio_config'), usage: localStorage.getItem('auralyn_usage_devices') }).toEqual(before);
    await waitFor(() => expect(sources).toHaveBeenCalled());
    const app = await screen.findByRole('combobox', { name: message('ja', 'processInput.app') });
    await waitFor(() => expect(app).toHaveFocus());
    expect(screen.getByText(message('ja', 'processInput.reselectHelp', { name: 'Player' }))).toBeVisible();
    expect(screen.getByRole('button', { name: '接続を保存して再起動' })).toBeDisabled();
    expect(screen.getByText('使い道：音楽鑑賞（PCの音にVSTをかけて聴く）')).toBeVisible();
    expect(screen.queryByText(message('ja', 'purpose.mismatch'))).not.toBeInTheDocument();
    const opener = screen.getByRole('button', { name: '切り替える' });
    expect(opener).toBeDisabled();
    expect(opener).toHaveAccessibleDescription(message('ja', 'purpose.blockedPending'));
});

it('アプリの音声の下書きを捨てて画面を開き直しても、表示と保存値は元のままで、食い違いの案内も出ない', async () => {
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: appRecord }));
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([]);
    const { dialog } = await openSwitch();
    confirm(dialog);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('combobox', { name: message('ja', 'processInput.app') })).toBeVisible();
    cleanup();
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ input: 'Mic', inputSource: voiceSource });
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} onEngineRestarted={vi.fn(async () => 'completed' as const)} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    expect(screen.getByText('使い道：配信・通話（マイクの声を整えて送る）')).toBeVisible();
    expect(screen.queryByText(message('ja', 'purpose.mismatch'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '切り替える' })).toBeEnabled();
});

describe('元の接続がアプリの音声だったとき', () => {
    const appSource = appRecord.inputSource;
    const appConfig = { ...appRecord, host: 'Wasapi' };
    const candidate = { id: 'app-1', appKey: 'a'.repeat(64), name: 'Player', routes: [{ id: 'endpoint', name: 'Headphones', muted: false }] };
    async function failAfterRestart(candidates: typeof candidate[]) {
        localStorage.setItem('vst_host_audio_config', JSON.stringify(appConfig));
        localStorage.setItem('auralyn_display_purpose', 'music');
        localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: appRecord }));
        const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue(restartResult);
        vi.spyOn(audioApi, 'processInputSources').mockResolvedValue(candidates);
        const onConfigChange = vi.fn(async () => {});
        onConfigChange.mockRejectedValueOnce(new Error('保存できない'));
        render(<AudioSettingsModal isOpen isAudioRunning currentConfig={appConfig} onClose={vi.fn()} onConfigChange={onConfigChange} onEngineRestarted={vi.fn(async () => 'completed' as const)} />);
        const opener = await screen.findByRole('button', { name: '切り替える' });
        await waitFor(() => expect(opener).toBeEnabled());
        fireEvent.click(opener);
        const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
        confirm(dialog);
        return { restart, dialog };
    }

    it('起動中のアプリを見つけられたら、その候補を渡して元のアプリの音声へ戻す', async () => {
        const { restart, dialog } = await failAfterRestart([candidate]);
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('表示と音声設定は元のままです');
        expect(restart).toHaveBeenCalledTimes(2);
        expect(restart.mock.calls[1][9]).toEqual({ source: appSource, candidateId: 'app-1' });
        expect(readDisplayPurpose()).toBe('music');
    });

    it('アプリが起動していなければ、元の接続へ戻せなかったと小窓に出す', async () => {
        const { restart, dialog } = await failAfterRestart([]);
        const alert = await within(dialog).findByRole('alert');
        expect(alert).toHaveTextContent('音声を元の接続で再開できていません');
        expect(alert).toHaveTextContent(message('ja', 'purpose.appNotRunning', { app: 'Player' }));
        expect(restart).toHaveBeenCalledOnce();
        expect(readDisplayPurpose()).toBe('music');
    });
});

it('移行の確認にチェックを入れるまで、理由を示して切り替えを押せなくする', async () => {
    localStorage.setItem('vst_host_migration_review_required', 'true');
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} onEngineRestarted={vi.fn()} />);
    const opener = await screen.findByRole('button', { name: '切り替える' });
    expect(opener).toBeDisabled();
    expect(opener).toHaveAccessibleDescription(message('ja', 'purpose.blockedReview'));
    fireEvent.click(screen.getByRole('checkbox', { name: message('ja', 'settings.AudioSettingsModal.030') }));
    await waitFor(() => expect(opener).toBeEnabled());
});
