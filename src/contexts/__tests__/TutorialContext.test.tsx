import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TutorialProvider, useTutorial } from '../TutorialContext';

const notify = () => window.dispatchEvent(new Event('vst_host_tutorial_start'));
function Progress() {
    const { currentStep, isActive, completeStep, skipTutorial } = useTutorial();
    return <>
        <output data-testid="progress" data-active={isActive}>{currentStep}</output>
        <button onClick={() => { completeStep('click_add_effect'); notify(); }}>追加と再通知</button>
        <button onClick={skipTutorial}>案内終了</button>
    </>;
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

it('保存後の通知で開始し、重複通知でも手順を維持する', () => {
    render(<TutorialProvider><Progress /></TutorialProvider>);
    const progress = screen.getByTestId('progress');
    act(notify);
    expect(progress).toHaveTextContent('none');
    act(() => { localStorage.setItem('vst_host_wizard_done', 'true'); notify(); notify(); });
    expect(progress).toHaveTextContent('click_add_effect');
    expect(progress).toHaveAttribute('data-active', 'true');
    act(notify);
    expect(progress).toHaveTextContent('click_add_effect');
});

it('同じ更新内で手順が進んだ後の通知でも先頭へ戻さない', () => {
    render(<TutorialProvider><Progress /></TutorialProvider>);
    act(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        notify();
        fireEvent.click(screen.getByRole('button', { name: '追加と再通知' }));
    });
    expect(screen.getByTestId('progress')).toHaveTextContent('explain_plugin_card');
    act(notify);
    expect(screen.getByTestId('progress')).toHaveTextContent('explain_plugin_card');
});

it.each(['事前に完了済み', '開始後に終了'])('%sなら通知で再開しない', kind => {
    localStorage.setItem('vst_host_wizard_done', 'true');
    if (kind === '事前に完了済み') localStorage.setItem('vst_host_tutorial_completed', 'true');
    render(<TutorialProvider><Progress /></TutorialProvider>);
    if (kind === '開始後に終了') fireEvent.click(screen.getByRole('button', { name: '案内終了' }));
    act(notify);
    expect(screen.getByTestId('progress')).toHaveAttribute('data-active', 'false');
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBe('true');
});
