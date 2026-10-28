import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { RouteSummary } from '../RouteSummary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('分離出力は安定IDを露出せず、主経路と独立したWASAPIの一意な表示名を使う', async () => {
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [{id: 'cable-id', name: 'CABLE Input', host: 'WASAPI'}, {id: 'cable-id', name: 'ASIO output', host: 'ASIO'}] } as any);
    const props = {host: 'WASAPI', output: 'Headphones', onSettings: vi.fn(), routing: {deviceId: 'cable-id', splitProcessing: true, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false}};
    const view = render(<RouteSummary {...props} />);
    await act(async () => {});
    expect(screen.getByText(/配信側: CABLE Input/)).toBeInTheDocument();
    expect(screen.queryByText(/cable-id/)).not.toBeInTheDocument();
    view.rerender(<RouteSummary {...props} routing={{...props.routing, deviceId: 'missing-guid'}} />);
    expect(screen.getByText(/配信側: 未確認/)).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByText(/missing-guid/)).not.toBeInTheDocument();
});
