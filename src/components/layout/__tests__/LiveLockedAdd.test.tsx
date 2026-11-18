import { type ComponentProps, useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { message } from '@/i18n/messages';
import { liveModesApi, type LiveModeSnapshot } from '@/api/liveModes';
import { useLiveModes } from '@/hooks/useLiveModes';
import { useUIState } from '@/hooks/useUIState';
import { ModalLayer } from '../ModalLayer';

beforeAll(async () => { await import('../../features/PluginBrowser/PluginBrowserModal'); }, 60_000);

const plugin = { id: 'comp', name: 'Comp', vendor: 'Studio', path: 'comp.vst3', version: '', category: 'Fx|Dynamics' };
const reason = message('ja', 'pluginNotices.liveLockedBody');

const snapshot = (armed: boolean): LiveModeSnapshot => ({
    epoch: '1', running: true, revision: '1', acceptedRevision: '1', completedRevision: '1', target: null, applied: null, phase: 'custom',
    armed, naturalTail: false, error: null, definitions: { schemaVersion: 1, version: '1', singing: null, talk: null },
});

let armed: boolean;
const scan = vi.fn(async () => {});
const retry = vi.fn(async () => {});
const addPlugin = vi.fn(async (_plugin: unknown, options?: { onLocked?: () => void }) => { options?.onLocked?.(); return false; });
const pluginsApi: ComponentProps<typeof ModalLayer>['pluginsApi'] = {
    plugins: [], availablePlugins: [plugin], isScanning: false, error: null, scanPlugins: scan, retryPluginScan: retry, addPlugin,
    loadPreset: vi.fn(), savePreset: vi.fn(), saveProfile: vi.fn(), applyProfile: vi.fn(), restoreBackupProfile: vi.fn(), applyTemplate: vi.fn(),
    resetPlugins: vi.fn(), recoverSession: vi.fn(), keepSessionStopped: vi.fn(), resumeWithoutPlugins: vi.fn(), restoreSession: vi.fn(),
};

function Harness() {
    const ui = useUIState();
    const live = useLiveModes();
    const { activate } = live;
    useEffect(() => activate(), [activate]);
    return <>
        <button onClick={() => ui.setIsBrowserOpen(true)}>追加の画面を開く</button>
        <ModalLayer ui={ui} liveModel={live} audioConfig={{ host: 'WASAPI' }} handleConfigUpdate={vi.fn()} pluginsApi={pluginsApi} onPluginAdded={vi.fn()} />
    </>;
}

beforeEach(() => {
    armed = true;
    vi.spyOn(liveModesApi, 'request').mockImplementation(async () => snapshot(armed));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

async function lockedAdd() {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '追加の画面を開く' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Comp を追加' }));
    return await screen.findByText(reason);
}

// 開いている画面の裏でも、ロックの監視は定期確認（500ms）で状態を取り直す。
async function refreshWith(next: boolean) {
    armed = next;
    const before = vi.mocked(liveModesApi.request).mock.calls.length;
    await waitFor(() => expect(vi.mocked(liveModesApi.request).mock.calls.length).toBeGreaterThan(before), { timeout: 3000 });
}

it('追加を断られた理由は追加の画面の中に出し、日本語を語の途中で折り返さない', async () => {
    const text = await lockedAdd();
    expect(screen.getByRole('dialog')).toContainElement(text);
    expect(text.className).toContain('[word-break:auto-phrase]');
});

it.each(['更新', 'すべて再スキャン'])('追加を断られたあとで「%s」を押すと、理由を消す', async name => {
    await lockedAdd();
    fireEvent.click(screen.getByRole('button', { name }));
    expect(scan).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText(reason)).not.toBeInTheDocument());
});

it('追加を断られたあとで操作ロックが外れたら、画面を開いたまま理由を消す', async () => {
    await lockedAdd();
    await refreshWith(true);
    expect(screen.getByText(reason)).toBeInTheDocument();
    await refreshWith(false);
    await waitFor(() => expect(screen.queryByText(reason)).not.toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
});
