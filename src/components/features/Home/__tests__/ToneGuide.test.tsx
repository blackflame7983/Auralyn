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
