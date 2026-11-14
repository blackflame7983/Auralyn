import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Button } from '../button';
import { SegmentedControl } from '../SegmentedControl';
import { Switch } from '../switch';

it('押す・切り替えるクラスを3つの部品だけに付ける', () => {
    const { container } = render(<>
        <Button>保存</Button>
        <Switch aria-label="例" />
        <SegmentedControl label="選択" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="a" onValueChange={() => {}} />
    </>);
    expect(screen.getByRole('button', { name: '保存' })).toHaveClass('control-press');
    expect(screen.getByRole('switch', { name: '例' })).toHaveClass('control-press');
    expect(container.querySelector('.switch-thumb')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'A' })).toHaveClass('control-press');
    const marker = container.querySelector('[data-segment-indicator]');
    expect(marker).toHaveClass('duration-(--motion-base)');
    expect(marker).toHaveClass('motion-reduce:transition-none');
});

it('沈みと滑りはトークンを使い、動きを減らす設定では色だけを残す', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
    const press = css.slice(css.indexOf('共通の押下'));
    expect(press).toMatch(/\.control-press \{[^}]*transition-duration: var\(--motion-fast\)/);
    expect(press).toMatch(/\.control-press:active:not\(:disabled\) \{ transform: translateY\(1px\)/);
    expect(press).toMatch(/\.switch-thumb \{[^}]*transition-duration: var\(--motion-fast\)/);
    expect(press).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.control-press \{ transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow; \}\s*\.control-press:active:not\(:disabled\) \{ transform: none; \}\s*\.switch-thumb \{ transition-property: background-color; \}\s*\/\*[^*]*\*\/\s*\[data-segment-indicator\] \{ transition-property: opacity, background-color, border-color; \}/);
    // 強い押下は共通の 1px よりあとに書き、上書きされない。
    expect(css.indexOf('.control-press:active:not(:disabled)')).toBeLessThan(css.indexOf('.press-feedback:active:not(:disabled)'));
});
