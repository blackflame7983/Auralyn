// 方向G「オンエア卓」：配信卓の3列。左に行き先のレール、中央に「声がどう良くなったか」の加工前後モニター、右に本番中の操作を固定する。
// 設定はモーダルではなく中央のページで開き、右の安全操作は常に同じ場所に残る。表示は仮のデータ。
// ホーム以外のページ（音づくり・VST・接続・設定）は renewal/pages.tsx。
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { MdAdd, MdArrowForward, MdCast, MdMic, MdMusicNote, MdVolumeOff, MdVolumeUp, MdOpenInNew, MdSouth, MdCable, MdExtension, MdGraphicEq, MdHearing, MdHelpOutline, MdHome, MdLockOpen, MdPlayArrow, MdSettings } from 'react-icons/md';
import type { IconType } from 'react-icons';
import { setAccompanimentGain } from './renewal/signal';
import { ConnectPage, SettingsPage, SoundPage, VstPage } from './renewal/pages';
import { cutText, dbText, devices, drawBeforeAfter, drawHMeter, drawToneCurve, drawVMeter, MuteButton, Range, Scope, Seg, Toggle, useReadout, vstSlots, type RenewalPage, type RenewalProps } from './renewal/parts';

const outMeter = drawVMeter('out'); const inBar = drawHMeter('in'); const outBar = drawHMeter('out'); const accBar = drawHMeter('acc'); const mixBar = drawHMeter('mix');

export function ProtoG({ state, settings, purpose, onStart, onOpenSettings, page, onPage, compact = false, mix = false }: RenewalProps & { compact?: boolean }) {
    const live = state === 'live'; const unset = state === 'unset'; const music = purpose === 'music';
    const scale = useAutoScale(compact);
    const current: RenewalPage = page ?? (settings === 'audio' ? 'connect' : settings === 'appearance' ? 'appearance' : 'home');
    const go = (next: RenewalPage) => onPage ? onPage(next) : onOpenSettings(next === 'connect' ? 'audio' : next === 'home' ? null : 'appearance');
    const inSettings = current === 'obs' || current === 'appearance' || current === 'keys' || current === 'system';
    const rail: { icon: IconType; label: string; active: boolean; onClick?: () => void }[] = [
        { icon: MdHome, label: 'ホーム', active: current === 'home', onClick: () => go('home') },
        { icon: MdGraphicEq, label: '音づくり', active: current === 'sound', onClick: () => go('sound') }, { icon: MdExtension, label: 'VST', active: current === 'vst', onClick: () => go('vst') }, { icon: MdCable, label: '接続', active: current === 'connect', onClick: () => go('connect') },
        { icon: MdSettings, label: '設定', active: inSettings, onClick: () => go('appearance') },
    ];
    return <div className="oa-root" style={scale > 1 ? { zoom: scale } as CSSProperties : undefined}>
        <nav className="oa-rail" aria-label="画面">
            <span className="mb-3 text-[15px] font-bold tracking-tight">Aura<span className="text-primary">lyn</span></span>
            {rail.map(item => <button key={item.label} type="button" aria-current={item.active ? 'page' : undefined} onClick={item.onClick}><item.icon aria-hidden="true" className="h-6 w-6" />{item.label}</button>)}
            <button type="button" className="mt-auto"><MdHelpOutline aria-hidden="true" className="h-6 w-6" />ヘルプ</button>
        </nav>
        <div className="flex min-w-0 flex-col">
            <div className="oa-strip">
                <span className="oa-tally" data-state={state}>{live ? '実行中' : state === 'stopped' ? '停止中' : '未設定'}</span>
                {live ? <span className="rn-mono text-ui-control">00:42:17</span> : null}
                {unset ? null : <span className="truncate text-ui-support text-muted-foreground">{music ? `${devices.musicIn} → ${devices.musicOut}` : `${devices.mic} → ${devices.out} → ${devices.dest}`}</span>}
                <span className="ml-auto" />
                {!unset && !music ? <Seg label="モード" value="talk" onChange={() => undefined} options={[{ value: 'talk', label: '雑談' }, { value: 'sing', label: '歌' }]} /> : null}
                {live ? <button type="button" className="rn-outline"><MdHearing aria-hidden="true" className="h-4 w-4" />{music ? '聴き比べ' : 'ボイスチェック'}</button> : null}
            </div>
            {current === 'sound' ? <SoundPage live={live} /> : current === 'vst' ? <VstPage live={live} music={music} /> : current === 'connect' ? <ConnectPage live={live} />
                : inSettings ? <SettingsPage tab={current} onPage={go} />
                    : compact ? <CompactHome state={state} music={music} onStart={onStart} mix={mix && !music && state !== 'unset'} go={go} /> : <Home state={state} music={music} onStart={onStart} />}
        </div>
        {compact ? <CompactSafety state={state} /> : <Safety state={state} />}
    </div>;
}

function Home({ state, music, onStart }: { state: RenewalProps['state']; music: boolean; onStart: () => void }) {
    const live = state === 'live'; const unset = state === 'unset';
    const [nr, setNr] = useState(true); const [tone, setTone] = useState(true); const [amount, setAmount] = useState(70);
    const stats = useReadout(frame => ({ cut: frame.noiseCut, level: frame.leveling, peak: dbText(Math.max(frame.outL, frame.outR)) }), { cut: 0, level: 0, peak: '−∞' });
    return <main className="oa-main">
        <section className="oa-monitor" aria-label={music ? '音のモニター' : '声のモニター'}>
            <div className="flex items-center gap-4">
                <h2 className="text-ui-control font-semibold">{music ? '音のモニター' : '声のモニター'}</h2>
                <span className="oa-legend" data-kind="raw">加工前</span><span className="oa-legend" data-kind="done">加工後</span>
            </div>
            <div className="relative min-h-0 flex-1">
                <Scope draw={drawBeforeAfter} label="加工前と加工後の音量の流れ" className="absolute inset-0 h-full w-full" />
                {live ? null : <div className="oa-overlay">
                    {unset ? <ol className="oa-steps">
                        <li data-next><span>1</span><div><b>送り先を決める</b><small>OBS・通話・自分で聴く</small></div><button type="button" className="rn-primary">決める<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button></li>
                        <li><span>2</span><div><b>マイクを選ぶ</b></div></li><li><span>3</span><div><b>出力先を選ぶ</b></div></li>
                    </ol> : <><button type="button" className="rn-primary rn-primary-lg" onClick={onStart}><MdPlayArrow aria-hidden="true" className="h-6 w-6" />音声を開始</button><span className="text-ui-support text-muted-foreground">保存済みの{music ? '再生元' : 'マイク'}と出力先で開始します。</span></>}
                </div>}
            </div>
        </section>
        <div className="oa-stats" data-dim={!live || undefined}>
            {music ? null : <><Stat label="ノイズを下げた量" value={live && nr ? cutText(stats.cut) : '—'} unit="dB" /><Stat label="大きい声を抑えた量" value={live && tone ? cutText(stats.level) : '—'} unit="dB" /></>}
            <Stat label="出力のピーク" value={live ? stats.peak : '—'} unit="dBFS" /><Stat label="遅延" value={live ? '5.3' : '—'} unit="ms" />
        </div>
        <div className="oa-chain" inert={unset} data-dim={unset || undefined}>
            {music ? null : <>
                <Card title="ノイズ低減" on={nr} onToggle={setNr}><Seg label="強さ" value="mid" onChange={() => undefined} options={[{ value: 'low', label: '弱' }, { value: 'mid', label: '標準' }, { value: 'high', label: '強' }]} /></Card>
                <Card title="声を整える" on={tone} onToggle={setTone}><Range value={amount} onChange={setAmount} label="声の整え具合" className="w-full" /><span className="rn-mono text-ui-support">{amount}%</span></Card>
            </>}
            <Card title="VST" action={<button type="button" className="rn-outline">編集</button>}>{vstSlots.map(slot => <span key={slot.name} className="oa-slot">{slot.name}</span>)}</Card>
        </div>
    </main>;
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) { return <div className="oa-stat"><span>{label}</span><b className="rn-mono">{value}<small>{unit}</small></b></div>; }
function Card({ title, on, onToggle, action, children }: { title: string; on?: boolean; onToggle?: (on: boolean) => void; action?: ReactNode; children: ReactNode }) {
    return <section className="oa-card" data-on={on ?? true} aria-label={title}>
        <div className="flex items-center gap-2"><h3 className="flex-1 text-ui-control font-semibold">{title}</h3>{onToggle ? <Toggle checked={!!on} onChange={onToggle} label={`${title}を使う`} /> : action}</div>
        <div className="flex min-h-9 flex-wrap items-center gap-2">{children}</div>
    </section>;
}

function Safety({ state }: { state: RenewalProps['state'] }) {
    const [volume, setVolume] = useState(100); const [bypass, setBypass] = useState(false);
    const peak = useReadout(frame => dbText(Math.max(frame.outL, frame.outR)), '−∞');
    return <aside className="oa-safety" aria-label="本番中の操作">
        <MuteButton big />
        <span className="oa-safety-label">出力</span>
        <div className="flex min-h-0 flex-1 justify-center gap-4"><Scope draw={outMeter} label="出力レベル" className="h-full w-[62px]" /><Range vertical value={volume} onChange={setVolume} label="出力音量" /></div>
        <div className="flex items-baseline justify-between"><span className="rk-readout">{state === 'live' ? peak : '−∞'}<small>dBFS</small></span><span className="rn-mono text-ui-support text-muted-foreground">音量 {volume}%</span></div>
        <button type="button" role="switch" aria-checked={bypass} onClick={() => setBypass(value => !value)} className="rk-bypass h-12"><i aria-hidden="true" />{bypass ? 'VSTオフで比較中' : 'VSTを外して比較'}</button>
        <button type="button" className="rn-ghost justify-center"><MdLockOpen aria-hidden="true" className="h-4 w-4" />操作をロック</button>
    </aside>;
}

/** 大きい窓では、画面全体を同じ比率で拡大する（最大1.5倍）。中身が窓の中央の小さな島になるのを避ける。
 *  基準は 1700×960。これより小さい窓では拡大しない。メーターの段の数は増えるが、形は変えない。 */
function useAutoScale(enabled: boolean): number {
    const [scale, setScale] = useState(1);
    useEffect(() => {
        if (!enabled) { setScale(1); return; }
        const update = () => setScale(Math.round(Math.min(1.5, Math.max(1, Math.min(innerWidth / 1700, innerHeight / 960))) * 100) / 100);
        update(); addEventListener('resize', update);
        return () => removeEventListener('resize', update);
    }, [enabled]);
    return scale;
}

/** G2：モニターを細い帯にし、主役を「いまの状態」と音調整の3枚に戻す。ミキサーではなく、声を整える道具に見せる。 */
export function ProtoG2(props: RenewalProps) { return <ProtoG {...props} compact />; }

function CompactHome({ state, music, onStart, mix, go }: { state: RenewalProps['state']; music: boolean; onStart: () => void; mix: boolean; go: (page: RenewalPage) => void }) {
    const live = state === 'live'; const unset = state === 'unset';
    const [nr, setNr] = useState(true); const [tone, setTone] = useState(true); const [amount, setAmount] = useState(70);
    const [vst, setVst] = useState([true, true, true]);
    const [preset, setPreset] = useState<'stream' | 'low' | 'clear'>('stream');
    const curve = useMemo(() => drawToneCurve(tone ? amount / 100 : 0), [tone, amount]);
    return <main className="oa-main oa-main-g2">
        <div className="oa-hero">
            {unset ? <><div><p className="oa-hero-eyebrow">はじめに</p><h1>送り先を決めましょう</h1><p className="text-ui-support text-muted-foreground">1 送り先 → 2 マイク → 3 出力先 の順に決めます。</p></div>
                <button type="button" className="rn-primary rn-primary-lg">送り先を決める<MdArrowForward aria-hidden="true" className="h-5 w-5" /></button></>
                : live ? <div><p className="oa-hero-eyebrow">{music ? devices.musicIn : `送り先 ${devices.dest}`}</p><h1>{music ? devices.musicOut : '雑談モード'}</h1></div>
                    : <><div><p className="oa-hero-eyebrow">停止中</p><h1>音は止まっています</h1><p className="text-ui-support text-muted-foreground">保存済みの{music ? '再生元' : 'マイク'}と出力先で開始します。</p></div>
                        <button type="button" className="rn-primary rn-primary-lg" onClick={onStart}><MdPlayArrow aria-hidden="true" className="h-6 w-6" />音声を開始</button></>}
        </div>
        <div className="oa-wide"><div className="oa-wide-main">
        <section className="oa-ribbon" aria-label={music ? '音の流れ' : '声の流れ'} data-dim={!live || undefined}>
            <Scope draw={drawBeforeAfter} label="加工前と加工後の音量の流れ" className="h-full w-full" />
            <div className="oa-ribbon-legend"><span className="oa-legend" data-kind="raw">加工前</span><span className="oa-legend" data-kind="done">加工後</span></div>
        </section>
        {mix ? <MixPanel live={live} /> : null}
        <div className="oa-chain oa-chain-lg" inert={unset} data-dim={unset || undefined}>
            {music ? null : <>
                <Card title="ノイズ低減" on={nr} onToggle={setNr}>
                    <p className="w-full text-ui-support text-muted-foreground">{nr ? '周囲の音を測って調整済み' : 'OFF'}</p>
                    <Seg label="強さ" value="mid" onChange={() => undefined} options={[{ value: 'low', label: '弱' }, { value: 'mid', label: '標準' }, { value: 'high', label: '強' }]} />
                    <div className="oa-more oa-note"><b>周囲の音の測定</b><span>測定済み（12分前）。いまのマイクと音量で有効です。</span><button type="button" className="rn-outline">測り直す</button><small>効きやすい：空調・PCのファン　効きにくい：周囲の会話・BGM</small></div>
                    <button type="button" className="oa-more rn-ghost oa-deeper" onClick={() => go('sound')}>詳しく調整<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button>
                </Card>
                <Card title="声を整える" on={tone} onToggle={setTone}>
                    <Scope draw={curve} label="音色の形" className="oa-curve w-full" />
                    <Range value={amount} onChange={setAmount} label="声の整え具合" className="min-w-0 flex-1" /><span className="rn-mono text-ui-support">{amount}%</span>
                    <div className="oa-more w-full"><Seg label="声の種類" value={preset} onChange={setPreset} options={[{ value: 'stream', label: '配信' }, { value: 'low', label: '低め' }, { value: 'clear', label: '明瞭' }]} /><p className="mt-2 text-ui-support text-muted-foreground">選ぶとすぐ反映します。</p></div>
                    <button type="button" className="oa-more rn-ghost oa-deeper" onClick={() => go('sound')}>詳しく調整<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button>
                </Card>
            </>}
            <Card title="VST" action={<button type="button" className="rn-outline" onClick={() => go('vst')}>編集</button>}>
                <ul className="flex w-full flex-col gap-1">{vstSlots.map((slot, index) => <li key={slot.name} className="oa-vst-row" data-on={vst[index]}>
                    <span className="min-w-0 flex-1 truncate"><b>{slot.name}</b><small>{slot.kind}</small></span>
                    <button type="button" className="oa-more rn-icon" aria-label={`${slot.name}の画面を開く`}><MdOpenInNew aria-hidden="true" className="h-4 w-4" /></button>
                    <Toggle checked={vst[index]} onChange={value => setVst(list => list.map((item, i) => i === index ? value : item))} label={`${slot.name}を使う`} />
                </li>)}</ul>
                <div className="oa-more flex w-full gap-2"><button type="button" className="rn-outline"><MdAdd aria-hidden="true" className="h-4 w-4" />VSTを追加</button><button type="button" className="rn-ghost">テンプレート</button></div>
            </Card>
        </div>
        </div><Connect state={state} music={music} go={go} /></div>
    </main>;
}

/** 幅に余裕がある窓でだけ出す「接続」。小さい窓ではレールの「接続」から開く想定。 */
function Connect({ state, music, go }: { state: RenewalProps['state']; music: boolean; go: (page: RenewalPage) => void }) {
    const unset = state === 'unset'; const live = state === 'live';
    const hops = music
        ? [{ label: '再生元', value: devices.musicIn, note: live ? '音が届いています' : '停止中' }, { label: '整える', value: 'Auralyn', note: live ? '実行中' : '停止中' }, { label: '聴く機器', value: devices.musicOut, note: live ? '出力しています' : '停止中' }]
        : [{ label: 'マイク', value: devices.mic, note: live ? '音が届いています' : '停止中' }, { label: '整える', value: 'Auralyn', note: live ? '実行中' : '停止中' }, { label: '出力先', value: devices.out, note: live ? '出力しています' : '停止中' }, { label: '送り先', value: devices.dest, note: '受け側は未確認' }];
    return <section className="oa-connect" aria-label="接続" data-dim={unset || undefined} inert={unset}>
        <h3 className="text-ui-control font-semibold">接続</h3>
        <ol>{hops.map((hop, index) => <li key={hop.label} data-warn={hop.note === '受け側は未確認' || undefined} data-on={live && hop.note !== '受け側は未確認'}>
            {index ? <MdSouth aria-hidden="true" className="oa-connect-arrow" /> : null}
            <small>{hop.label}</small><b>{unset ? '—' : hop.value}</b><span>{unset ? '未設定' : hop.note}</span>
        </li>)}</ol>
        <button type="button" className="rn-outline justify-center" onClick={() => go('connect')}>接続を変更</button>
        <button type="button" className="rn-ghost justify-center">音のトラブルを診断</button>
    </section>;
}

/** 配信ミックス：声・オケ・配信へ送る音を、同じ目盛りで縦に並べる。見比べるための表示なので、ここだけミキサーの語彙を使う。 */
function MixPanel({ live }: { live: boolean }) {
    const [volume, setVolume] = useState(70); const [muted, setMuted] = useState(false);
    useEffect(() => { setAccompanimentGain(muted ? 0 : volume / 100); return () => setAccompanimentGain(1); }, [volume, muted]);
    const levels = useReadout(frame => ({ voice: Math.max(frame.outL, frame.outR), acc: Math.max(frame.accL, frame.accR), mix: Math.max(frame.mixL, frame.mixR) }), { voice: 0, acc: 0, mix: 0 });
    const balance = !live ? '—' : muted || levels.acc <= 0.001 ? 'オケなし' : levels.acc > levels.voice + 0.06 ? 'オケが大きめ' : levels.voice > levels.acc + 0.2 ? '声が大きめ' : 'ちょうどよい';
    const zone = !live ? '—' : levels.mix > 0.95 ? '大きすぎ' : levels.mix > 0.66 ? '適正' : '小さめ';
    return <section className="oa-mix" aria-label="配信ミックス" data-dim={!live || undefined}>
        <div className="flex items-center gap-3"><h3 className="text-ui-control font-semibold">配信ミックス</h3><span className="oa-mix-balance" data-balance={balance}>{balance}</span><span className="ml-auto text-ui-support text-muted-foreground">声とオケを混ぜて、配信へ送ります</span></div>
        <div className="oa-mix-row"><span><MdMic aria-hidden="true" className="h-4 w-4" />声</span><Scope draw={outBar} label="声のレベル" className="h-4 w-full" /><span className="oa-mix-side text-muted-foreground">整えた後の声</span></div>
        <div className="oa-mix-row"><span><MdMusicNote aria-hidden="true" className="h-4 w-4" />オケ</span><Scope draw={accBar} label="オケのレベル" className="h-4 w-full" />
            <span className="oa-mix-side"><button type="button" className="rn-icon" aria-pressed={muted} aria-label="オケをミュート" onClick={() => setMuted(value => !value)}>{muted ? <MdVolumeOff aria-hidden="true" className="h-5 w-5" /> : <MdVolumeUp aria-hidden="true" className="h-5 w-5" />}</button>
                <Range value={volume} onChange={setVolume} label="オケの音量" className="min-w-0 flex-1" /><span className="rn-mono w-10 text-right text-ui-support">{muted ? 'ミュート' : `${volume}%`}</span></span></div>
        <div className="oa-mix-row oa-mix-sum"><span><MdCast aria-hidden="true" className="h-4 w-4" />配信へ</span><Scope draw={mixBar} label="配信へ送る音のレベル" className="h-4 w-full" /><span className="oa-mix-side"><b className="oa-zone" data-zone={zone}>{zone}</b><span className="rn-mono ml-auto text-ui-support text-muted-foreground">{live ? dbText(levels.mix) : '−∞'} dBFS</span></span></div>
        <div className="oa-mix-row oa-mix-scale" aria-hidden="true"><span /><div><i style={{ left: '0%' }}>−60</i><i style={{ left: '40%' }}>−36</i><i style={{ left: '70%' }}>−18</i><i style={{ left: '90%' }}>−6</i><i style={{ left: '100%' }}>0</i></div><span /></div>
    </section>;
}

function CompactSafety({ state }: { state: RenewalProps['state'] }) {
    const [volume, setVolume] = useState(100); const [bypass, setBypass] = useState(false); const [mic, setMic] = useState(100);
    const out = useReadout(frame => Math.max(frame.outL, frame.outR), 0);
    const zone = state !== 'live' || out <= 0.001 ? '—' : out > 0.95 ? '大きすぎ' : out > 0.66 ? '適正' : '小さめ';
    return <aside className="oa-safety" aria-label="本番中の操作">
        <MuteButton big />
        <div className="mt-2 flex flex-col gap-2">
            <span className="oa-safety-label">入力</span>
            <Scope draw={inBar} label="入力レベル" className="h-5 w-full" />
            <span className="text-ui-support text-muted-foreground">マイク音量 {mic}%</span>
            <Range value={mic} onChange={setMic} label="マイク音量" className="w-full" />
        </div>
        <div className="mt-auto flex flex-col gap-2">
            <div className="flex items-baseline justify-between"><span className="oa-safety-label">出力</span><span className="oa-zone" data-zone={zone}>{zone}</span></div>
            <Scope draw={outBar} label="出力レベル" className="h-5 w-full" />
            <div className="flex items-baseline justify-between text-ui-support text-muted-foreground"><span>出力音量 {volume}%</span><span className="rn-mono">{state === 'live' ? dbText(out) : '−∞'} dBFS</span></div>
            <Range value={volume} onChange={setVolume} label="出力音量" className="w-full" />
        </div>
        <button type="button" role="switch" aria-checked={bypass} onClick={() => setBypass(value => !value)} className="rk-bypass h-12"><i aria-hidden="true" />{bypass ? 'VSTオフで比較中' : 'VSTを外して比較'}</button>
        <button type="button" className="rn-ghost justify-center"><MdLockOpen aria-hidden="true" className="h-4 w-4" />操作をロック</button>
    </aside>;
}
