import { expect, it } from 'vitest';
import { formatAudioRoute } from '../audioRouteLine';

it('配信・通話は送り先まで、音楽鑑賞は再生元と出力だけを1行にする', () => {
    expect(formatAudioRoute('Mic [48.0 kHz]', 'Speakers [48 kHz]', '通話', false)).toBe('Mic → Speakers → 通話');
    expect(formatAudioRoute('再生元', 'ヘッドホン', '自分で聴く', true)).toBe('再生元 → ヘッドホン');
    expect(formatAudioRoute('Mic', 'Speakers', undefined, false)).toBe('Mic → Speakers');
});

it('入力か出力が空のときは経路を出さない', () => {
    expect(formatAudioRoute('', 'Speakers', '通話', false)).toBeNull();
    expect(formatAudioRoute(undefined, 'Speakers', '通話', false)).toBeNull();
    expect(formatAudioRoute('Mic', '  ', '通話', false)).toBeNull();
});
