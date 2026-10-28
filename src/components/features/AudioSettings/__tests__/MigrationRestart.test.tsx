import { audioApi } from '@/api/audio';
import { openSystemTab } from './settingsActions';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ModalLayer } from '@/components/layout/ModalLayer';
import { useUIState } from '@/hooks/useUIState';
import { useAudioConfig } from '@/hooks/useAudioConfig';
import { usePlugins } from '@/hooks/usePlugins';
import { bootstrapMigration, REVIEW_KEY } from '@/api/migration';
import type { SessionRackRequest } from '@/api/audio';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function Harness() {
    const ui = useUIState();
    const audio = useAudioConfig(() => {});
    const plugins = usePlugins();
    return <>
        <button onClick={() => ui.setIsSettingsOpen(true)}>設定を表示</button>
        <output data-testid="chain">{plugins.plugins.map(p => p.path).join(',')}</output>
        <ModalLayer ui={ui} audioConfig={audio.audioConfig} handleConfigUpdate={audio.handleConfigUpdate}
            pluginsApi={plugins} onPluginAdded={() => {}} />
    </>;
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it.each([
    { operation: '保存して開始', host: 'Wasapi', failAt: null },
    { operation: '音声エンジンを再起動', host: 'Wasapi', failAt: null },
    { operation: '通常再起動', host: 'Wasapi', failAt: null },
    { operation: '保存して開始', host: 'ASIO', failAt: null },
    { operation: '音声エンジンを再起動', host: 'ASIO', failAt: null },
    { operation: '保存して開始', host: 'ASIO', failAt: 'start' },
    { operation: '音声エンジンを再起動', host: 'ASIO', failAt: 'start' },
    { operation: '保存して開始', host: 'ASIO', failAt: 'channels' },
    { operation: '音声エンジンを再起動', host: 'ASIO', failAt: 'channels' },
    { operation: '保存して開始', host: 'ASIO', failAt: 'complete' },
    { operation: '音声エンジンを再起動', host: 'ASIO', failAt: 'complete' },
])('$host・$operation・初回失敗=$failAt: 確認後の開始成功時だけ各VSTを1回復元する', async ({ operation, host, failAt }) => {
    localStorage.clear();
    if (operation !== '通常再起動') localStorage.setItem(REVIEW_KEY, 'true');
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host, input: 'Mic', output: host === 'ASIO' ? 'Mic' : 'Output', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] }));
    const paths = ['eq.vst3', 'meter.vst3'];
    localStorage.setItem('vst_host_session_plugins', JSON.stringify(paths.map(path => ({ path, name: path, vendor: '', version: '', enabled: true, muted: false, gain: 1 }))));
    let enginePaths: string[] = [];
    let engineGeneration = 0;
    let rackRevision = 0;
    let sessionToken: string | undefined;
    let restoreEligible = true;
    let rejectOnce = !!failAt;
    let started = false;
    let channelsApplied = false;
    let nativeReview = operation !== '通常再起動';
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'get_audio_devices') return { inputs: [{ name: 'Mic', host, channels: 8 }], outputs: [{ name: host === 'ASIO' ? 'Mic' : 'Output', host, channels: 8 }] };
        if (command === 'get_audio_state') return { is_running: true, config: { host, sample_rate: 48000, buffer_size: 512 } };
        if (command === 'auto_gain') return { running: true, streamFailed: false };
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'start_audio' || command === 'restart_audio_engine') {
            if (rejectOnce && failAt === 'start') {
                rejectOnce = false;
                throw new Error('試験用のstart失敗');
            }
            started = true;
            channelsApplied = false;
            if (command === 'restart_audio_engine') {
                enginePaths = []; engineGeneration += 1; rackRevision = 0;
                sessionToken = undefined; restoreEligible = true;
            }
            return { sample_rate: 48000, buffer_size: 512, channels: 2 };
        }
        if (command === 'set_input_channels' && started) {
            if (rejectOnce && failAt === 'channels') {
                rejectOnce = false;
                throw new Error('試験用のchannels失敗');
            }
            channelsApplied = true;
        }
        if (command === 'migration_bootstrap') return { reviewRequired: nativeReview, ui: null };
        if (command === 'migration_complete_review') {
            expect(started && channelsApplied).toBe(true);
            if (host === 'ASIO') expect(JSON.parse(localStorage.getItem('vst_host_audio_config')!).inputChannels).toEqual([6, 7]);
            if (rejectOnce && failAt === 'complete') {
                rejectOnce = false;
                throw new Error('試験用のcomplete失敗');
            }
            nativeReview = false;
        }
        if (command === 'session_rack') {
            const request = (args as { request: SessionRackRequest }).request;
            if (request.action === 'snapshot') return { status: 'snapshot', generation: String(engineGeneration), revision: String(rackRevision),
                present: true, running: started, restoreEligible, plugins: enginePaths.map((path, index) => ({
                    id: `instance-${engineGeneration}-${index + 1}`, path, name: 'Restored', enabled: true, muted: false, gain: 1,
                })) };
            if (request.action === 'begin') {
                expect(nativeReview).toBe(false);
                if (sessionToken || request.generation !== String(engineGeneration) || request.revision !== String(rackRevision) || enginePaths.length) return { status: 'conflict' };
                restoreEligible = false; sessionToken = `session-${engineGeneration}`;
                return { status: 'ready', generation: String(engineGeneration), token: sessionToken };
            }
            if (request.action === 'retain') { restoreEligible = false; return { status: 'finished' }; }
            if (request.token !== sessionToken) return { status: 'conflict' };
            if (request.action === 'finish') { sessionToken = undefined; return { status: 'finished' }; }
            expect(nativeReview).toBe(false);
            enginePaths.push(request.request.path); rackRevision += 1;
            return { status: 'restored', plugin: { id: `instance-${engineGeneration}-${enginePaths.length}`, name: 'Restored', prepared: started } };
        }
        return null;
    });
    render(<Harness />);
    if (operation === '通常再起動') {
        await waitFor(() => expect(screen.getByTestId('chain')).toHaveTextContent(paths.join(',')));
        vi.mocked(invoke).mockClear();
    } else {
        expect(enginePaths).toEqual([]);
    }
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    // 全体並列実行時の初回lazy読込みを待つ。移行・復元の条件や回数は以下で検証する。
    await screen.findByRole('button', { name: '保存して開始' }, { timeout: 3000 });
    if (operation !== '通常再起動') {
        expect(screen.getByRole('button', { name: '保存して開始' })).toBeDisabled();
        if (host === 'ASIO') {
            fireEvent.click(await screen.findByRole('radio', { name: '入力チャンネル 7/8' }));
            await waitFor(() => expect(JSON.parse(localStorage.getItem('vst_host_audio_config')!).inputChannels).toEqual([6, 7]));
            expect(localStorage.getItem(REVIEW_KEY)).toBe('true');
            expect(screen.getByRole('button', { name: '保存して開始' })).toBeDisabled();
            await openSystemTab();
            expect(screen.getByRole('button', { name: '音声エンジンを再起動' })).toBeDisabled();
            fireEvent.keyDown(screen.getByRole('tab', { name: 'オーディオ' }), { key: 'Enter' });
            expect(enginePaths).toEqual([]);
            expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
            expect(invoke).not.toHaveBeenCalledWith('restart_audio_engine', expect.anything());
        }
        fireEvent.click(screen.getByRole('checkbox', { name: '移行した入力・出力先・VSTを確認しました' }));
    }
    await waitFor(() => expect(screen.getByRole('button', { name: '保存して開始' })).toBeEnabled());
    const start = async () => {
        if (operation === '保存して開始') fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
        else {
            await openSystemTab();
            fireEvent.click(screen.getByRole('button', { name: '音声エンジンを再起動' }));
            fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
        }
    };
    await start();
    if (failAt) {
        await screen.findByText(/試験用の.*失敗/);
        expect(localStorage.getItem(REVIEW_KEY)).toBe('true');
        expect(enginePaths).toEqual([]);
        expect(nativeReview).toBe(true);
        // 次回のbootstrapでも確認待ちが消えず、自動復元を許さない。
        await bootstrapMigration();
        expect(localStorage.getItem(REVIEW_KEY)).toBe('true');
        expect(screen.getByTestId('chain')).toBeEmptyDOMElement();
        fireEvent.click(screen.getByRole('button', { name: '設定に戻って再試行' }));
        await screen.findByRole('button', { name: '保存して開始' });
        await start();
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存して開始' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('chain')).toHaveTextContent(paths.join(',')));
    expect(localStorage.getItem(REVIEW_KEY)).toBeNull();
    expect(enginePaths).toEqual(paths);
    expect(nativeReview).toBe(false);
    const completions = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'migration_complete_review');
    expect(completions).toHaveLength(operation === '通常再起動' ? 0 : failAt === 'complete' ? 2 : 1);
    if (host === 'ASIO') {
        expect(JSON.parse(localStorage.getItem('vst_host_audio_config')!).inputChannels).toEqual([6, 7]);
        expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 6, right: 7 });
    }
    const loads = vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'session_rack' && (args as { request: SessionRackRequest }).request.action === 'add');
    expect(loads.map(([, args]) => (args as { request: { request: { path: string } } }).request.request.path)).toEqual(paths);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'restore_plugin')).toBe(false);
});

beforeEach(() => { vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false }); });
