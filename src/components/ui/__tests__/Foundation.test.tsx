import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from '../Field';
import { Input } from '../Input';
import { Select } from '../Select';
import { Checkbox } from '../Checkbox';
import { ChoiceCard } from '../ChoiceCard';
import { SliderField } from '../SliderField';
import { Disclosure } from '../Disclosure';
import { Button } from '../button';
import { SegmentedControl } from '../SegmentedControl';

describe('共通入力', () => {
    it.each([Input, Select, Checkbox])('ラベル・説明・エラーと無効状態を関連付ける', Control => {
        render(<Field label="項目" description="説明" error="エラー"><Control disabled aria-describedby="external" /></Field>);
        const control = screen.getByLabelText('項目');
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('aria-invalid', 'true');
        expect(control.getAttribute('aria-describedby')?.split(' ')).toEqual(['external', screen.getByText('説明').id, screen.getByRole('alert').id]);
        expect(control).toHaveClass('rounded-control', 'focus-visible:ring-2');
    });
    it('入力と選択とチェックは標準操作を保つ', async () => {
        render(<><Field label="検索"><Input /></Field><Field label="選択"><Select><option>A</option><option>B</option></Select></Field><Field label="確認"><Checkbox /></Field></>);
        fireEvent.change(screen.getByLabelText('検索'), { target: { value: 'abc' } });
        expect(screen.getByLabelText('検索')).toHaveValue('abc');
        fireEvent.change(screen.getByLabelText('選択'), { target: { value: 'B' } });
        expect(screen.getByLabelText('選択')).toHaveValue('B');
        screen.getByLabelText('確認').focus(); fireEvent.click(screen.getByLabelText('確認'));
        expect(screen.getByLabelText('確認')).toBeChecked();
    });
});
it('ChoiceCard は標準radioをlabelで包み、選択・説明・無効を保つ', async () => {
    render(<><ChoiceCard name="choice" defaultChecked description="説明">A</ChoiceCard><ChoiceCard name="choice">B</ChoiceCard><ChoiceCard name="choice" disabled>C</ChoiceCard></>);
    const first = screen.getByRole('radio', { name: /A/ });
    expect(first).toHaveAccessibleDescription('説明'); first.focus();
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(screen.getByRole('radio', { name: 'B' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'C' })).toBeDisabled();
});
it('SliderField は単位を読み上げ、キーを離すまで確定しない', () => {
    const commit = vi.fn();
    function Example() { const [value, set] = useState(30); return <SliderField label="強さ" value={value} formatValue={n => `${n}%`} onValueChange={set} onValueCommit={commit} />; }
    render(<Example />);
    const slider = screen.getByRole('slider', { name: '強さ' });
    expect(slider).toHaveAttribute('aria-valuetext', '30%');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuetext', '31%'); expect(commit).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: 'ArrowRight' }); expect(commit).toHaveBeenCalledExactlyOnceWith(31);
    fireEvent.blur(slider); expect(commit).toHaveBeenCalledTimes(1);
});
it('SliderField の無効状態ではキー操作を反映しない', () => {
    const change = vi.fn();
    render(<SliderField disabled label="強さ" value={30} formatValue={n => `${n}%`} onValueChange={change} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' }); expect(change).not.toHaveBeenCalled();
});
it('SliderField は外側の fieldset の無効を引き継ぎ、無効が解けたら操作できる', () => {
    const change = vi.fn();
    function Example({ off }: { off: boolean }) { return <fieldset disabled={off}><SliderField label="量" value={30} formatValue={n => `${n}%`} onValueChange={change} /></fieldset>; }
    const { rerender } = render(<Example off />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' }); expect(change).not.toHaveBeenCalled();
    rerender(<Example off={false} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' }); expect(change).toHaveBeenCalled();
});
it('Disclosure は開閉の補間を指定し、閉じた内容を操作・読み上げから外す', async () => {
    const { container } = render(<Disclosure label="詳細"><Input aria-label="中身" /></Disclosure>);
    const trigger = screen.getByRole('button', { name: '詳細' });
    const panel = container.querySelector('.disclosure-panel')!;
    expect(trigger).toHaveAttribute('aria-controls', panel.id); expect(panel).toHaveAttribute('inert');
    fireEvent.click(trigger); expect(trigger).toHaveAttribute('aria-expanded', 'true'); expect(panel).not.toHaveAttribute('inert');
    screen.getByLabelText('中身').focus(); fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(trigger).toHaveFocus(); expect(panel).toHaveAttribute('aria-hidden', 'true');
});
it('Disclosure の無効な入口は開かない', async () => {
    render(<Disclosure label="詳細" disabled>内容</Disclosure>);
    fireEvent.click(screen.getByRole('button')); expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
});
it('Button の既定と補助操作を文字の段に合わせる', () => {
    render(<><Button>通常</Button><Button size="sm">補助</Button></>);
    expect(screen.getByText('通常')).toHaveClass('text-ui-control', 'h-10');
    expect(screen.getByText('補助')).toHaveClass('text-ui-support', 'h-9');
});
it('SegmentedControl は無効を飛ばし、矢印・Home・Endで選択してTabは1回だけ止まる', async () => {
    function Example() { const [value, set] = useState('a'); return <SegmentedControl label="値" value={value} onValueChange={set} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]} />; }
    render(<Example />); screen.getByRole('radio', { name: 'A' }).focus(); expect(screen.getByRole('radio', { name: 'A' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); expect(screen.getByRole('radio', { name: 'C' })).toBeChecked();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); expect(screen.getByRole('radio', { name: 'A' })).toBeChecked();
    fireEvent.keyDown(document.activeElement!, { key: 'End' }); expect(screen.getByRole('radio', { name: 'C' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' }); expect(screen.getByRole('radio', { name: 'A' })).toHaveFocus();
    expect(screen.getAllByRole('radio').filter(node => node.tabIndex === 0)).toHaveLength(1);
});

it('標準入力は矢印キーを奪わず、ブラウザの選択操作へ渡す', () => {
    render(<><ChoiceCard name="choice">A</ChoiceCard><Select aria-label="選択"><option>A</option></Select><Input aria-label="入力" /><Checkbox aria-label="確認" /></>);
    for (const control of [screen.getByRole('radio'), screen.getByRole('combobox'), screen.getByRole('textbox'), screen.getByRole('checkbox')]) {
        expect(fireEvent.keyDown(control, { key: 'ArrowRight' })).toBe(true);
    }
});
it('Disclosureを外から閉じてもフォーカスを隠れた中身に残さない', () => {
    const { rerender } = render(<Disclosure open label="詳細"><Input aria-label="中身" /></Disclosure>);
    screen.getByLabelText('中身').focus();
    rerender(<Disclosure open={false} label="詳細"><Input aria-label="中身" /></Disclosure>);
    expect(screen.getByRole('button', { name: '詳細' })).toHaveFocus();
});

it('Fieldは外部のラベルを重複させず説明とエラーを関連付ける', () => {
    render(<><label htmlFor="device">機器</label><Field id="device" label={null} description="選択の説明" error="選択してください"><Select><option value="">未選択</option></Select></Field></>);
    const select = screen.getByRole('combobox', { name: '機器' });
    expect(screen.getAllByText('機器', { selector: 'label' })).toHaveLength(1);
    expect(select).toHaveAccessibleDescription('選択の説明 選択してください');
    expect(select).toHaveAttribute('aria-invalid', 'true');
});
