import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginRackEmptyState } from '../PluginRackEmptyState';

afterEach(cleanup);

it('空ラックの主操作はVST追加へ進み、テンプレートと初回設定の入口も保つ', () => {
    const add = vi.fn();
    const templates = vi.fn();
    const wizard = vi.fn();
    render(<PluginRackEmptyState onAddClick={add} onOpenTemplates={templates} onOpenWizard={wizard} />);
    fireEvent.click(screen.getByRole('button', { name: 'VSTを追加' }));
    expect(add).toHaveBeenCalledOnce();
    expect(wizard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'VST構成テンプレート' }));
    expect(templates).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'セットアップを開く' }));
    expect(wizard).toHaveBeenCalledOnce();
});
