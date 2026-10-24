import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readLiveRouting, LIVE_ROUTING_KEY } from '@/lib/liveRouting';
import { ObsModeRoutingSettings } from '../ObsModeRoutingSettings';
beforeEach(() => localStorage.clear()); afterEach(cleanup);
it('未設定の従来方式を説明し、明示保存でだけ背景連動と割当を設定する', () => {
    render(<ObsModeRoutingSettings />);
    expect(readLiveRouting()).toBeNull();
    expect(screen.getByText(/未設定時は従来方式/)).toHaveTextContent('最小化中も接続を保持');
    fireEvent.change(screen.getByRole('combobox', { name: 'OBSシーンの連動方式' }), { target: { value: 'mode' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'この方式の連動を有効にする' }));
    fireEvent.click(screen.getByRole('button', { name: 'シーンの割当を追加' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'OBSシーン名 1' }), { target: { value: '歌枠' } });
    expect(localStorage.getItem(LIVE_ROUTING_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '連動方式を保存' }));
    expect(readLiveRouting()).toEqual({ version: 1, strategy: 'mode', explicitEnabled: true, mappings: { 歌枠: 'singing' } });
    expect(screen.getByRole('status')).toHaveTextContent('次の実際のシーン変更');
});
it('空欄・重複のシーン割当は保存原本を置換しない', () => {
    render(<ObsModeRoutingSettings />);
    fireEvent.change(screen.getByRole('combobox', { name: 'OBSシーンの連動方式' }), { target: { value: 'mode' } });
    fireEvent.click(screen.getByRole('button', { name: 'シーンの割当を追加' }));
    fireEvent.click(screen.getByRole('button', { name: '連動方式を保存' }));
    expect(screen.getByRole('status')).toHaveTextContent('空欄・重複');
    expect(readLiveRouting()).toBeNull();
});
