import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { RouteSummary, RouteLine } from '../RouteSummary';
import { message } from '@/i18n/messages';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('分離出力は安定IDを露出せず、主経路と独立したWASAPIの一意な表示名を使う', async () => {
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [{id: 'cable-id', name: 'CABLE Input', host: 'WASAPI'}, {id: 'cable-id', name: 'ASIO output', host: 'ASIO'}] } as any);
    const props = {host: 'WASAPI', output: 'Headphones', onSettings: vi.fn(), routing: {deviceId: 'cable-id', splitProcessing: true, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false}};
    const view = render(<RouteSummary {...props} />);
    await act(async () => {});
    expect(screen.getByText(/配信側: CABLE Input/)).toBeInTheDocument();
    expect(screen.queryByText(/cable-id/)).not.toBeInTheDocument();
    view.rerender(<RouteSummary {...props} routing={{...props.routing, deviceId: 'missing-guid'}} />);
    expect(screen.getByText(new RegExp(`配信側: ${message('ja', 'flow.unknown')}`))).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByText(/missing-guid/)).not.toBeInTheDocument();
});

it('畳んだ経路は配信用と自分用を併記し、出力名が取れない場合も未確認を示す', () => {
    const view = render(<RouteLine output="Headphones" broadcastName="CABLE Input" split receiver="OBS" />);
    expect(screen.getByText('配信用 CABLE Input → OBS')).toBeInTheDocument();
    expect(screen.getByText('自分用: Headphones')).toBeInTheDocument();
    view.rerender(<RouteLine output="Headphones" split receiver="OBS" />);
    expect(screen.getByText(`配信用 ${message('ja', 'flow.unknown')} → OBS`)).toBeInTheDocument();
});
