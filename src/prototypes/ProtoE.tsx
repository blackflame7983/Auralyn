// 方向E「ラック」：暗い部屋で光る機材。入力メーター → 機材の段（ラック）→ 出力メーターとフェーダーを、1枚のチャンネルストリップとして並べる。
// 設定を開いても両端のメーターと本番中の操作は消えない。表示は仮のデータ。
import { useState, type ReactNode } from 'react';
import { MdAdd, MdArrowForward, MdEast, MdHelpOutline, MdOpenInNew, MdPlayArrow, MdSettings, MdClose, MdHearing } from 'react-icons/md';
import { useTheme } from '../hooks/useTheme';
import { cutText, dbText, devices, drawToneCurve, drawVMeter, MuteButton, Range, Scope, Seg, themes, Toggle, useReadout, vstSlots, type RenewalProps } from './renewal/parts';

const inMeter = drawVMeter('in'); const outMeter = drawVMeter('out');

export function ProtoE({ state, settings, purpose, onStart, onOpenSettings }: RenewalProps) {
    const live = state === 'live'; const music = purpose === 'music';
    const [mode, setMode] = useState<'talk' | 'sing'>('talk');
    return <div className="rk-root flex h-full flex-col">
        <header className="rk-top">
            <span className="text-[17px] font-bold tracking-tight">Aura<span className="text-primary">lyn</span></span>
            <span className="rk-state" data-state={state}><i aria-hidden="true" />{live ? '実行中' : state === 'stopped' ? '停止中' : '未設定'}</span>
            {live ? <span className="rn-mono text-ui-support text-muted-foreground">48 kHz · 5.3 ms</span> : null}
            {state !== 'unset' && !music ? <Seg label="モード" value={mode} onChange={setMode} options={[{ value: 'talk', label: '雑談' }, { value: 'sing', label: '歌' }]} /> : null}
            <span className="ml-auto" />
            <MuteButton />
            <button type="button" className="rn-ghost" aria-pressed={settings !== null} onClick={() => onOpenSettings(settings ? null : 'audio')}><MdSettings aria-hidden="true" className="h-5 w-5" />設定</button>
            <button type="button" className="rn-ghost"><MdHelpOutline aria-hidden="true" className="h-5 w-5" />ヘルプ</button>
        </header>
        <div className="rk-body">
            <InColumn state={state} music={music} />
            {settings ? <RackSettings tab={settings} onTab={onOpenSettings} /> : <Chain state={state} music={music} onStart={onStart} />}
            <OutColumn state={state} music={music} />
        </div>
    </div>;
}

function InColumn({ state, music }: { state: RenewalProps['state']; music: boolean }) {
    const peak = useReadout(frame => dbText(Math.max(frame.inL, frame.inR)), '−∞');
    return <aside className="rk-col" aria-label="入力">
        <span className="rk-col-label">IN</span>
        <span className="rk-col-device" title={music ? devices.musicIn : devices.mic}>{state === 'unset' ? '—' : music ? devices.musicIn : devices.mic}</span>
        <Scope draw={inMeter} label="入力レベル" className="min-h-0 w-full flex-1" />
        <span className="rk-readout">{peak}<small>dBFS</small></span>
        <button type="button" className="rk-chip" disabled={state === 'unset'}>{music ? '入力' : 'マイク'} 100%</button>
    </aside>;
}

function OutColumn({ state, music }: { state: RenewalProps['state']; music: boolean }) {
    const [volume, setVolume] = useState(100); const [bypass, setBypass] = useState(false);
    const peak = useReadout(frame => dbText(Math.max(frame.outL, frame.outR)), '−∞');
    return <aside className="rk-col rk-col-out" aria-label="出力">
        <span className="rk-col-label">OUT</span>
        <span className="rk-col-device" title={music ? devices.musicOut : devices.out}>{state === 'unset' ? '—' : music ? devices.musicOut : devices.out}</span>
        <div className="flex min-h-0 w-full flex-1 justify-center gap-3">
            <Scope draw={outMeter} label="出力レベル" className="h-full w-[58px]" />
            <Range vertical value={volume} onChange={setVolume} label="出力音量" />
        </div>
        <span className="rk-readout">{peak}<small>dBFS</small></span>
        <span className="rn-mono text-ui-support text-muted-foreground">出力音量 {volume}%</span>
        <button type="button" role="switch" aria-checked={bypass} onClick={() => setBypass(value => !value)} className="rk-bypass">
            <i aria-hidden="true" />{bypass ? 'VSTオフで比較中' : 'VSTを外して比較'}
        </button>
    </aside>;
}

function Chain({ state, music, onStart }: { state: RenewalProps['state']; music: boolean; onStart: () => void }) {
    const live = state === 'live'; const unset = state === 'unset';
    const [nr, setNr] = useState(true); const [nrLevel, setNrLevel] = useState<'low' | 'mid' | 'high'>('mid');
    const [tone, setTone] = useState(true); const [amount, setAmount] = useState(70);
    const [vst, setVst] = useState([true, true, true]);
    const cut = useReadout(frame => frame.noiseCut, 0);
    return <main className="rk-chain" data-dim={!live || undefined}>
        <div className="rk-route">
            {unset ? <>
                <RouteNode label="マイク" value="—" /><MdEast aria-hidden="true" className="rk-arrow" /><RouteNode label="整える" value="Auralyn" done /><MdEast aria-hidden="true" className="rk-arrow" />
                <RouteNode label="出力先" value="—" /><MdEast aria-hidden="true" className="rk-arrow" /><RouteNode label="送り先" value="ここを決める" next />
                <button type="button" className="rn-primary ml-auto">送り先を決める<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button>
            </> : <>
                <RouteNode label={music ? '再生元' : 'マイク'} value={music ? devices.musicIn : devices.mic} done /><MdEast aria-hidden="true" className="rk-arrow" data-on={live} />
                <RouteNode label="整える" value="Auralyn" done /><MdEast aria-hidden="true" className="rk-arrow" data-on={live} />
                <RouteNode label={music ? '聴く機器' : '出力先'} value={music ? devices.musicOut : devices.out} done />
                {music ? null : <><MdEast aria-hidden="true" className="rk-arrow" data-on={live} /><RouteNode label="送り先" value={devices.dest} done /></>}
                {live ? <button type="button" className="rn-outline ml-auto"><MdHearing aria-hidden="true" className="h-4 w-4" />{music ? '聴き比べ' : 'ボイスチェック'}</button>
                    : <button type="button" className="rn-primary ml-auto" onClick={onStart}><MdPlayArrow aria-hidden="true" className="h-5 w-5" />音声を開始</button>}
            </>}
        </div>
        <div className="rk-rack" inert={unset}>
            {music ? null : <>
                <Unit index="01" name="ノイズ低減" sub={unset ? '設定後に使えます' : nr ? '周囲の音を測って調整済み' : 'OFF'} on={nr && !unset} onToggle={unset ? undefined : setNr}
                    control={<Seg label="強さ" value={nrLevel} onChange={setNrLevel} options={[{ value: 'low', label: '弱' }, { value: 'mid', label: '標準' }, { value: 'high', label: '強' }]} />}
                    viz={<span className="rk-figure">{live && nr ? cutText(cut) : '—'}<small>dB 低減中</small></span>} />
                <Unit index="02" name="声を整える" sub={unset ? '設定後に使えます' : tone ? `配信向け · ${amount}%` : 'OFF'} on={tone && !unset} onToggle={unset ? undefined : setTone}
                    control={<Range value={amount} onChange={setAmount} label="声の整え具合" className="w-full" />}
                    viz={<Scope draw={drawToneCurve(tone ? amount / 100 : 0)} label="音色の形" className="h-10 w-full" />} />
            </>}
            {unset ? <Unit index={music ? '01' : '03'} name="VST" sub="設定後に使えます" on={false} control={null} viz={null} /> : vstSlots.map((slot, index) => <Unit key={slot.name}
                index={String(index + (music ? 1 : 3)).padStart(2, '0')} name={slot.name} sub={`${slot.maker} · ${slot.kind}`} on={vst[index]} onToggle={value => setVst(list => list.map((item, i) => i === index ? value : item))}
                control={<button type="button" className="rn-outline"><MdOpenInNew aria-hidden="true" className="h-4 w-4" />画面を開く</button>}
                viz={<span className="rk-tag">VST3</span>} />)}
            {unset ? null : <button type="button" className="rk-add"><MdAdd aria-hidden="true" className="h-5 w-5" />VSTを追加</button>}
        </div>
    </main>;
}

function RouteNode({ label, value, done, next }: { label: string; value: string; done?: boolean; next?: boolean }) {
    return <span className="rk-node" data-done={done || undefined} data-next={next || undefined}><small>{label}</small><b>{value}</b></span>;
}

function Unit({ index, name, sub, on, onToggle, control, viz }: { index: string; name: string; sub: string; on: boolean; onToggle?: (on: boolean) => void; control: ReactNode; viz: ReactNode }) {
    return <section className="rk-unit" data-on={on} aria-label={name}>
        <span className="rk-unit-index rn-mono">{index}</span>
        <div className="min-w-0"><h3 className="truncate text-ui-control font-semibold">{name}</h3><p className="truncate text-ui-support text-muted-foreground">{sub}</p></div>
        <div className="rk-unit-control">{control}</div>
        <div className="rk-unit-viz">{viz}</div>
        {onToggle ? <Toggle checked={on} onChange={onToggle} label={`${name}を使う`} /> : <span className="w-11" />}
    </section>;
}

const tabs = [{ value: 'audio', label: 'オーディオ' }, { value: 'sound', label: '音づくり' }, { value: 'obs', label: 'OBS連携' }, { value: 'appearance', label: '外観' }, { value: 'keys', label: 'ホットキー' }, { value: 'system', label: 'システム' }] as const;

function RackSettings({ tab, onTab }: { tab: 'audio' | 'appearance'; onTab: RenewalProps['onOpenSettings'] }) {
    return <main className="rk-settings">
        <nav className="rk-tabs" aria-label="設定">
            <h2 className="mb-2 px-3 text-ui-heading font-semibold">設定</h2>
            {tabs.map(item => <button key={item.value} type="button" aria-current={item.value === tab ? 'page' : undefined} onClick={() => (item.value === 'audio' || item.value === 'appearance') && onTab(item.value)}>{item.label}</button>)}
            <button type="button" className="mt-auto" onClick={() => onTab(null)}><MdClose aria-hidden="true" className="h-4 w-4" />設定を閉じる</button>
        </nav>
        <div className="rk-form">{tab === 'audio' ? <AudioRows /> : <AppearanceRows />}</div>
    </main>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return <div className="rk-row"><div><span className="text-ui-control font-medium">{label}</span>{hint ? <p className="text-ui-support text-muted-foreground">{hint}</p> : null}</div><div className="rk-row-control">{children}</div></div>;
}
function Select({ options, label }: { options: string[]; label: string }) { return <select aria-label={label} className="rn-select">{options.map(option => <option key={option}>{option}</option>)}</select>; }

function AudioRows() {
    const [host, setHost] = useState<'wasapi' | 'asio'>('wasapi'); const [stability, setStability] = useState<'fast' | 'std' | 'safe'>('std');
    return <>
        <h3 className="rk-group">入出力</h3>
        <Row label="入力元"><Select label="入力元" options={['マイク・仮想ケーブル', 'アプリの音声']} /></Row>
        <Row label="マイク"><Select label="マイク" options={[devices.mic, 'マイク (USB Audio)']} /></Row>
        <Row label="出力先" hint="OBS では、この機器を音声入力に選びます"><Select label="出力先" options={[devices.out, 'CABLE Input']} /></Row>
        <Row label="自分用と配信用に分ける"><Toggle checked={false} onChange={() => undefined} label="自分用と配信用に分ける" /></Row>
        <h3 className="rk-group">接続</h3>
        <Row label="接続方式" hint="ASIO は入出力が同じ機器になります"><Seg label="接続方式" value={host} onChange={setHost} options={[{ value: 'wasapi', label: 'WASAPI' }, { value: 'asio', label: 'ASIO' }]} /></Row>
        <Row label="音の途切れにくさ"><Seg label="音の途切れにくさ" value={stability} onChange={setStability} options={[{ value: 'fast', label: '遅延を少なく' }, { value: 'std', label: '標準' }, { value: 'safe', label: '途切れにくく' }]} /></Row>
        <Row label="周波数" hint="ほかのアプリと合わせます"><Select label="周波数" options={['48,000 Hz', '44,100 Hz']} /></Row>
        <div className="rk-apply"><span className="text-ui-support text-muted-foreground">接続の変更はありません。保存すると音が一瞬途切れます。</span><button type="button" className="rn-primary" disabled>接続を保存して再起動</button></div>
    </>;
}

function AppearanceRows() {
    const { theme, setTheme } = useTheme(); const [detail, setDetail] = useState(true); const [aurora, setAurora] = useState(true);
    return <>
        <h3 className="rk-group">テーマ</h3>
        <div className="grid grid-cols-3 gap-3 py-3">
            {themes.map(item => <button key={item.value} type="button" aria-pressed={theme === item.value} onClick={() => setTheme(item.value as 'dark' | 'light' | 'gaming')} className="rn-theme">
                <span data-theme-preview={item.value} className="rn-theme-preview"><i /><i /><i /><b /></span>
                <span className="text-ui-control font-semibold">{item.label}</span><span className="text-ui-support text-muted-foreground">{item.hint}</span>
            </button>)}
        </div>
        <h3 className="rk-group">表示</h3>
        <Row label="表示言語"><Select label="表示言語" options={['日本語', 'English']} /></Row>
        <Row label="ホームの表示" hint="音声の設定と送り先は変わりません"><Select label="ホームの表示" options={['配信・通話向け', '音楽鑑賞']} /></Row>
        <Row label="数値の詳細を表示" hint="遅延・dBFS などの数値を出します"><Toggle checked={detail} onChange={setDetail} label="数値の詳細を表示" /></Row>
        <Row label="メーターの光を表示"><Toggle checked={aurora} onChange={setAurora} label="メーターの光を表示" /></Row>
    </>;
}
