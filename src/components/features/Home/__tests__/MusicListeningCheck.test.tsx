import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MusicListeningCheck } from '../MusicListeningCheck';
import { audioApi } from '@/api/audio';

afterEach(() => {cleanup(); vi.restoreAllMocks();});
it('確認欄を開いても再生・録音・機器変更を始めず、設定は明示操作だけで開く', () => {
    const start = vi.spyOn(audioApi, 'start');
    const settings = vi.fn(); const close = vi.fn();
    render(<MusicListeningCheck running input="CABLE Output" output="Headphones" vstBypassed={false} onCompareVst={vi.fn()} onSettings={settings} onClose={close} />);
    expect(screen.getByRole('heading', {name: '再生の確認'})).toHaveFocus();
    expect(screen.getByText('CABLE Output')).toBeInTheDocument();
    expect(screen.getByText('Headphones')).toBeInTheDocument();
    expect(screen.getByText(/1\. 再生アプリで音を流す/)).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '入力・出力の設定を確認'}));
    expect(settings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', {name: '閉じる'}));
    expect(close).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
});

it('再生の確認から、右の列と同じVST外しを1回で切り替える', () => {
    const start = vi.spyOn(audioApi, 'start');
    const compare = vi.fn();
    render(<MusicListeningCheck running vstBypassed={false} onCompareVst={compare} onSettings={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'VSTを外して聴き比べる' }));
    expect(compare).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
});
