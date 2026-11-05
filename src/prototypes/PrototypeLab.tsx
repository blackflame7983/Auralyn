// #301 の試作を実アプリのウィンドウ内で見比べる画面。開発時に ?proto=ab|a|b|c で開く（main.tsx）。
// 音声エンジン・保存設定には触れない。表示はすべて仮のデータ。
import { useEffect, useState } from 'react';
import './proto.css';
import { ProtoA } from './ProtoA';
import { ProtoB } from './ProtoB';
import { ProtoC } from './ProtoC';
import type { ProtoScreen, ProtoScreenProps } from './types';

// 採用案：A を基本にし、未設定のホームだけ B の流れにする（利用者の選択、2026-11-05）。
function ProtoAB(props: ProtoScreenProps) { return <ProtoA {...props} unsetFlow />; }

type Variant = 'ab' | 'a' | 'b' | 'c';
const variants: { value: Variant; label: string }[] = [{ value: 'ab', label: 'A＋B 採用案' }, { value: 'a', label: 'A ステージ' }, { value: 'b', label: 'B 音の流れ' }, { value: 'c', label: 'C タイル' }];
const screens: { value: ProtoScreen; label: string }[] = [{ value: 'unset', label: '未設定' }, { value: 'setup', label: 'セットアップ' }, { value: 'ready', label: '設定済み' }];

function readParams(): { variant: Variant; screen: ProtoScreen; reduced: boolean } {
    const params = new URLSearchParams(location.search);
    const variant = (['ab', 'a', 'b', 'c'] as const).find(value => value === params.get('proto')) ?? 'ab';
    const screen = (['unset', 'setup', 'ready'] as const).find(value => value === params.get('screen')) ?? 'unset';
    return { variant, screen, reduced: params.get('reduced') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches };
}

export default function PrototypeLab() {
    const initial = readParams();
    const [variant, setVariant] = useState<Variant>(initial.variant);
    const [screen, setScreen] = useState<ProtoScreen>(initial.screen);
    const [reduced, setReduced] = useState(initial.reduced);
    const [toolbar, setToolbar] = useState(true);
    useEffect(() => {
        const params = new URLSearchParams({ proto: variant, screen });
        if (reduced) params.set('reduced', '1');
        history.replaceState(null, '', `?${params.toString()}`);
    }, [variant, screen, reduced]);
    const View = variant === 'ab' ? ProtoAB : variant === 'a' ? ProtoA : variant === 'b' ? ProtoB : ProtoC;
    return <div className="proto-root flex h-screen flex-col overflow-hidden bg-background text-foreground" data-proto-reduced={reduced || undefined}>
        {/* 案を切り替えたら状態を作り直し、前の案の開閉状態を持ち越さない。試作の切替バーの分だけ高さを空ける。 */}
        <div className="relative min-h-0 flex-1"><View key={variant} screen={screen} setScreen={setScreen} /></div>
        {toolbar ? <div className="proto-lab-bar relative z-50 flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-t border-dashed border-warning/60 bg-popover px-3 text-ui-support">
            <span className="font-bold text-warning">試作</span>
            <Group items={variants} value={variant} onChange={setVariant} />
            <Group items={screens} value={screen} onChange={setScreen} />
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />動きを減らす</label>
            <button type="button" onClick={() => setToolbar(false)} className="ml-auto rounded px-2 text-muted-foreground hover:text-foreground">隠す</button>
            <a href="/" className="rounded px-2 text-muted-foreground underline hover:text-foreground">実アプリへ</a>
        </div> : <button type="button" onClick={() => setToolbar(true)} className="fixed bottom-3 right-3 z-50 rounded-lg border border-dashed border-warning/60 bg-popover px-2 py-1 text-ui-support text-warning">試作</button>}
    </div>;
}

function Group<T extends string>({ items, value, onChange }: { items: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
    return <div className="flex overflow-hidden rounded-lg border border-border">
        {items.map(item => <button key={item.value} type="button" aria-pressed={item.value === value} onClick={() => onChange(item.value)}
            className={`px-2.5 py-1 ${item.value === value ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
    </div>;
}
