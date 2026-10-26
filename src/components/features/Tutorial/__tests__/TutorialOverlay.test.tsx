import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider, useMessages } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { TutorialProvider } from '@/contexts/TutorialContext';
import { TutorialOverlay } from '../TutorialOverlay';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
const Copy = () => { const t = useMessages(); return <p>{t('guide.copy.427')}</p>; };
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
it('localeだけで同じTutorial targetとstepを保持しskipや保存完了へ進まない', async () => {
    vi.useFakeTimers(); localStorage.setItem('vst_host_wizard_done', 'true');
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><TutorialProvider><button id="add-effect-btn">Actual target</button>
        <TutorialOverlay targetId="add-effect-btn" step="click_add_effect" content={<Copy />} />
    </TutorialProvider></LocaleProvider>);
    await act(async () => {});
    const end = screen.getByRole('button', { name: 'チュートリアルを終了する' });
    expect(document.querySelectorAll('.tutorial-spotlight')).toHaveLength(1);
    expect(end).not.toHaveClass('tutorial-spotlight');
    const target = document.getElementById('add-effect-btn');
    const measure = vi.spyOn(target!, 'getBoundingClientRect');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('button', { name: 'End tutorial' })).toBe(end);
    expect(document.getElementById('add-effect-btn')).toBe(target);
    expect(screen.getByText('Step 1: add an effect')).toBeInTheDocument();
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBeNull();
    expect(measure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBe('true');
});
