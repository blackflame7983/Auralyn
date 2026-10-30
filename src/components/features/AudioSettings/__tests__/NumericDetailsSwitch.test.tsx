import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NumericDetailsSwitch } from '../DisplayPurposeSelector';

afterEach(() => { cleanup(); localStorage.clear(); });

it('外観の「数値の詳細を表示」は以前の詳細表示と同じ保存値を切り替える', () => {
    render(<NumericDetailsSwitch />);
    const toggle = screen.getByRole('switch', { name: '数値の詳細を表示' });
    // 未設定の人は数値を出さない状態から始める。
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription(/ヘッダーの遅延/);
    fireEvent.click(toggle);
    expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('vst_host_beginner_mode')).toBe('true');
});
