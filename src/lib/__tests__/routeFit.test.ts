import { expect, it } from 'vitest';
import { fitRoute, routeSegments } from '../routeFit';

// 区切りの幅 [機器, 機器, 送り先]、区切り記号 16、省略記号 12。送り先の短い形は 40、20。
const widths = [200, 80, 70];
const compact = [40, 20];

it('区切りは矢印だけで分け、空の区間は捨てる', () => {
    expect(routeSegments('CABLE Output → スピーカー → OBSで配信')).toEqual(['CABLE Output', 'スピーカー', 'OBSで配信']);
    expect(routeSegments('自分用 → スピーカー')).toEqual(['自分用', 'スピーカー']);
});

it('幅が足りるときは何も隠さず、送り先も全文のまま', () => {
    expect(fitRoute(widths, compact, 16, 12, 400)).toEqual({ hidden: 0, variant: 0, clipped: false });
    expect(fitRoute([70], compact, 16, 12, 10)).toEqual({ hidden: 0, variant: 0, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 0)).toEqual({ hidden: 0, variant: 0, clipped: false });
});

it('入りきらないときは、送り先を全文で残せるところまで先頭を隠す', () => {
    // 全体 382。中間まで残すと 194。送り先だけなら 98。
    expect(fitRoute(widths, compact, 16, 12, 200)).toEqual({ hidden: 1, variant: 0, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 120)).toEqual({ hidden: 2, variant: 0, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 98)).toEqual({ hidden: 2, variant: 0, clipped: false });
});

it('送り先を全文で残せないときは、機器名を隠したまま送り先を短い形にする', () => {
    // 全文なら 98 が要る。短い形は 12 + 16 + 40 = 68、さらに短い形は 48。
    expect(fitRoute(widths, compact, 16, 12, 97)).toEqual({ hidden: 2, variant: 1, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 68)).toEqual({ hidden: 2, variant: 1, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 67)).toEqual({ hidden: 2, variant: 2, clipped: false });
    expect(fitRoute(widths, compact, 16, 12, 48)).toEqual({ hidden: 2, variant: 2, clipped: false });
});

it('どの幅でも、最も短い形（48）が入る限り、選んだ形は幅に収まり送り先は切れない', () => {
    for (let available = 48; available <= 400; available += 1) {
        const fit = fitRoute(widths, compact, 16, 12, available);
        const shown = fit.variant === 0 ? 70 : compact[fit.variant - 1] ?? 0;
        const used = fit.hidden === 0 ? 382 : 12 + 16 + shown + widths.slice(fit.hidden, 2).reduce((sum, width) => sum + width + 16, 0);
        expect({ available, fits: used <= available, clipped: fit.clipped }).toEqual({ available, fits: true, clipped: false });
    }
    expect(fitRoute(widths, compact, 16, 12, 47)).toEqual({ hidden: 2, variant: 2, clipped: true });
});

it('短い形が無いときは、送り先だけを残し、入らなければ末尾を省略する', () => {
    expect(fitRoute(widths, [], 16, 12, 50)).toEqual({ hidden: 2, variant: 0, clipped: true });
    expect(fitRoute([100, 40], [], 10, 10, 30)).toEqual({ hidden: 1, variant: 0, clipped: true });
    expect(fitRoute([100, 40], [], 10, 10, 60)).toEqual({ hidden: 1, variant: 0, clipped: false });
});
