import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ToneGuide } from '../VoiceQuickControls';
import { message } from '@/i18n/messages';

it('整え具合の目安は短い言葉で、語の途中では折り返さない', () => {
    render(<ToneGuide amount={40} on />);
    const caption = screen.getByText(message('ja', 'home.toneGuide'));
    expect(caption).toHaveTextContent('整え具合の目安');
    expect(caption).toHaveClass('break-keep');
});

it('OFFでも選んだ量の形を残し、無彩色の印で未適用と分ける', () => {
    const { rerender } = render(<ToneGuide amount={70} on={false} />);
    const off = document.querySelector('path');
    expect(off).toHaveAttribute('stroke', 'hsl(var(--muted-foreground))');
    expect(off?.closest('figure')).toHaveClass('home-held');
    rerender(<ToneGuide amount={70} on />);
    const on = document.querySelector('path');
    expect(on).toHaveAttribute('stroke', 'hsl(var(--aurora-teal))');
    expect(on).toHaveAttribute('d', off?.getAttribute('d'));
});
