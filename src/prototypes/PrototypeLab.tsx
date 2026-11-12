// #301 の試作を実アプリのウィンドウ内で見比べる画面。開発時に ?proto=ab|a|b|c|d で開く（main.tsx）。
// デザイン刷新（2026-11-12）の3方向は ?proto=e|f|g。画面は screen=live|stopped|unset|settings-audio|settings-appearance、用途は purpose=stream|music、bar=0 で切替バーを隠す。
// 音声エンジン・保存設定には触れない。表示はすべて仮のデータ。
import { useEffect, useState } from 'react';
import './proto.css';
import { ProtoA } from './ProtoA';
import { ProtoB } from './ProtoB';
import { ProtoC } from './ProtoC';
import { ProtoD } from './ProtoD';
import { ProtoE } from './ProtoE';
import { ProtoF } from './ProtoF';
import { ProtoG, ProtoG2 } from './ProtoG';
import { configureSignal } from './renewal/signal';
import type { HomeState, Purpose, RenewalPage } from './renewal/parts';
import type { ProtoScreen, ProtoScreenProps } from './types';

// 採用案：A を基本にし、未設定のホームだけ B の流れにする（利用者の選択、2026-11-05）。
function ProtoAB(props: ProtoScreenProps) { return <ProtoA {...props} unsetFlow />; }

type Variant = 'ab' | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'g2';
const variantValues = ['ab', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'g2'] as const;
const renewalViews = { e: ProtoE, f: ProtoF, g: ProtoG, g2: ProtoG2 };
type RenewalScreen = HomeState | 'sound' | 'vst' | 'settings-audio' | 'settings-obs' | 'settings-appearance' | 'settings-keys' | 'settings-system';
// G／G2 のページとの対応。E・F は 設定：オーディオ／外観 だけを持つ。
const pageOf: Record<RenewalScreen, RenewalPage> = { live: 'home', stopped: 'home', unset: 'home', sound: 'sound', vst: 'vst', 'settings-audio': 'connect', 'settings-obs': 'obs', 'settings-appearance': 'appearance', 'settings-keys': 'keys', 'settings-system': 'system' };
const screenOf: Record<RenewalPage, RenewalScreen> = { home: 'live', sound: 'sound', vst: 'vst', connect: 'settings-audio', obs: 'settings-obs', appearance: 'settings-appearance', keys: 'settings-keys', system: 'settings-system' };
const renewalScreens: { value: RenewalScreen; label: string }[] = [{ value: 'live', label: '処理中' }, { value: 'stopped', label: '停止中' }, { value: 'unset', label: '未設定' }, { value: 'sound', label: '音づくり' }, { value: 'vst', label: 'VST' }, { value: 'settings-audio', label: '接続（オーディオ）' }, { value: 'settings-obs', label: '設定：OBS' }, { value: 'settings-appearance', label: '設定：外観' }, { value: 'settings-keys', label: '設定：キー' }, { value: 'settings-system', label: '設定：システム' }];
const purposes: { value: Purpose; label: string }[] = [{ value: 'stream', label: '配信' }, { value: 'music', label: '音楽鑑賞' }];
const variants: { value: Variant; label: string }[] = [{ value: 'ab', label: 'A＋B' }, { value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }, { value: 'd', label: 'D' }, { value: 'e', label: 'E ラック' }, { value: 'f', label: 'F リスニングルーム' }, { value: 'g', label: 'G オンエア卓' }, { value: 'g2', label: 'G2 モニター控えめ' }];
const screens: { value: ProtoScreen; label: string }[] = [{ value: 'unset', label: '未設定' }, { value: 'setup', label: 'セットアップ' }, { value: 'ready', label: '設定済み' }];

function readParams(): { variant: Variant; screen: ProtoScreen; renewalScreen: RenewalScreen; purpose: Purpose; bar: boolean; mix: boolean; stopped: boolean; reduced: boolean } {
    const params = new URLSearchParams(location.search);
    const variant = variantValues.find(value => value === params.get('proto')) ?? 'ab';
    // 案D は本番中のホームの比較なので、画面の指定がなければ設定済みから開く。
    const screen = (['unset', 'setup', 'ready'] as const).find(value => value === params.get('screen')) ?? (variant === 'd' ? 'ready' : 'unset');
    const renewalScreen = renewalScreens.find(item => item.value === params.get('screen'))?.value ?? 'live';
    return { variant, screen, renewalScreen, purpose: params.get('purpose') === 'music' ? 'music' : 'stream', bar: params.get('bar') !== '0', mix: params.get('mix') === '1', stopped: params.get('home') === 'stopped', reduced: params.get('reduced') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches };
}

export default function PrototypeLab() {
    const initial = readParams();
    const [variant, setVariant] = useState<Variant>(initial.variant);
    const [screen, setScreen] = useState<ProtoScreen>(initial.screen);
    const [reduced, setReduced] = useState(initial.reduced);
    const [toolbar, setToolbar] = useState(initial.bar);
    const [renewalScreen, setRenewalScreen] = useState<RenewalScreen>(initial.renewalScreen);
    const [purpose, setPurpose] = useState<Purpose>(initial.purpose);
    const [mix, setMix] = useState(initial.mix);
    const renewal = variant === 'e' || variant === 'f' || variant === 'g' || variant === 'g2' ? renewalViews[variant] : null;
    // ホーム以外のページは、直前のホームの状態（処理中／停止中）を引き継いで表示する。
    const [lastHome, setLastHome] = useState<HomeState>(initial.stopped ? 'stopped' : 'live');
    const isHome = renewalScreen === 'live' || renewalScreen === 'stopped' || renewalScreen === 'unset';
    useEffect(() => { if (renewalScreen === 'live' || renewalScreen === 'stopped') setLastHome(renewalScreen); }, [renewalScreen]);
    const homeState: HomeState = isHome ? renewalScreen as HomeState : lastHome;
    // 擬似信号は試作全体で1つ。処理中の画面でだけ動かす。
    useEffect(() => { configureSignal({ running: renewal !== null && homeState === 'live', source: purpose === 'music' ? 'music' : 'voice', reduced }); }, [renewal, homeState, purpose, reduced]);
    useEffect(() => {
        const params = new URLSearchParams({ proto: variant, screen: renewal ? renewalScreen : screen });
        if (renewal && purpose === 'music') params.set('purpose', 'music');
        if (reduced) params.set('reduced', '1');
        if (renewal && mix) params.set('mix', '1');
        if (!initial.bar) params.set('bar', '0');
        const tab = new URLSearchParams(location.search).get('tab'); if (tab && !isHome) params.set('tab', tab);
        if (!isHome && lastHome === 'stopped') params.set('home', 'stopped');
        // ブラウザだけで開くとき（Tauri なし）は ?mock= の模擬応答が要る。再読み込みしても残す。
        const mock = new URLSearchParams(location.search).get('mock');
        if (mock) params.set('mock', mock);
        history.replaceState(null, '', `?${params.toString()}`);
    }, [variant, screen, reduced, renewal, renewalScreen, purpose, mix, initial.bar, isHome, lastHome]);
    const Renewal = renewal;
    const View = variant === 'ab' ? ProtoAB : variant === 'a' ? ProtoA : variant === 'b' ? ProtoB : variant === 'd' ? ProtoD : ProtoC;
    return <div className="proto-root flex h-screen flex-col overflow-hidden bg-background text-foreground" data-proto-reduced={reduced || undefined}>
        {/* 案を切り替えたら状態を作り直し、前の案の開閉状態を持ち越さない。試作の切替バーの分だけ高さを空ける。 */}
        <div className="relative min-h-0 flex-1">{Renewal
            ? <Renewal key={`${variant}-${purpose}`} state={homeState} purpose={purpose} mix={mix} page={pageOf[renewalScreen]} onPage={next => setRenewalScreen(next === 'home' ? lastHome : screenOf[next])} settings={renewalScreen === 'settings-audio' ? 'audio' : renewalScreen === 'settings-appearance' ? 'appearance' : null}
                onStart={() => setRenewalScreen('live')} onOpenSettings={tab => setRenewalScreen(tab ? `settings-${tab}` : 'live')} />
            : <View key={variant} screen={screen} setScreen={setScreen} />}</div>
        {toolbar ? <div className="proto-lab-bar relative z-50 flex h-11 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-dashed border-warning/60 bg-popover px-3 text-ui-support">
            <span className="font-bold text-warning">試作</span>
            <Group items={variants} value={variant} onChange={setVariant} />
            {renewal ? <><Group items={renewalScreens} value={renewalScreen} onChange={setRenewalScreen} /><Group items={purposes} value={purpose} onChange={setPurpose} /><label className="flex items-center gap-1.5"><input type="checkbox" checked={mix} onChange={event => setMix(event.target.checked)} />配信ミックス（G2）</label></> : <Group items={screens} value={screen} onChange={setScreen} />}
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />動きを減らす</label>
            <button type="button" onClick={() => setToolbar(false)} className="ml-auto rounded px-2 text-muted-foreground hover:text-foreground">隠す</button>
            <a href={`/?mock=${homeState === 'live' ? 'live-home' : homeState === 'stopped' ? 'stopped-home' : 'first-run'}`} className="rounded px-2 text-muted-foreground underline hover:text-foreground">現行の画面（模擬）</a>
            <a href="/" className="rounded px-2 text-muted-foreground underline hover:text-foreground">実アプリへ</a>
        </div> : !initial.bar ? null : <button type="button" onClick={() => setToolbar(true)} className="fixed bottom-3 right-3 z-50 rounded-lg border border-dashed border-warning/60 bg-popover px-2 py-1 text-ui-support text-warning">試作</button>}
    </div>;
}

function Group<T extends string>({ items, value, onChange }: { items: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
    return <div className="flex overflow-hidden rounded-lg border border-border">
        {items.map(item => <button key={item.value} type="button" aria-pressed={item.value === value} onClick={() => onChange(item.value)}
            className={`px-2.5 py-1 ${item.value === value ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
    </div>;
}
