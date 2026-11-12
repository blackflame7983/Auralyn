// 方向F「リスニングルーム」：静かな部屋に、音の光が一つ。オーロラを飾りではなく出力の帯域表示にして画面の主役にする。
// 操作は下の1行（音の流れ）と下端のドックに絞り、設定は右からのシートで開いて音の光を見たまま変えられる。表示は仮のデータ。
import { useState, type ReactNode } from 'react';
import { MdArrowForward, MdClose, MdExtension, MdFilterAlt, MdGraphicEq, MdHeadphones, MdHelpOutline, MdMic, MdPlayArrow, MdSettings } from 'react-icons/md';
import type { IconType } from 'react-icons';
import { useTheme } from '../hooks/useTheme';
import { cutText, dbText, devices, drawAuroraSpectrum, drawHMeter, MuteButton, Range, Scope, Seg, themes, Toggle, useReadout, vstSlots, type RenewalProps } from './renewal/parts';

const outMeter = drawHMeter('out');
type Stage = 'source' | 'nr' | 'tone' | 'vst';

export function ProtoF({ state, settings, purpose, onStart, onOpenSettings }: RenewalProps) {
    const live = state === 'live'; const unset = state === 'unset'; const music = purpose === 'music';
    const [open, setOpen] = useState<Stage | null>(null);
    const [volume, setVolume] = useState(100); const [bypass, setBypass] = useState(false);
    const [nr, setNr] = useState(true); const [tone, setTone] = useState(70); const [nrLevel, setNrLevel] = useState<'low' | 'mid' | 'high'>('mid');
    const peak = useReadout(frame => dbText(Math.max(frame.outL, frame.outR)), '−∞');
    const cut = useReadout(frame => frame.noiseCut, 0);
    const stages: { value: Stage; icon: IconType; label: string; text: string; on: boolean }[] = [
        { value: 'source', icon: music ? MdHeadphones : MdMic, label: music ? '再生元' : 'マイク', text: music ? devices.musicIn : devices.mic, on: true },
        ...(music ? [] : [{ value: 'nr' as const, icon: MdFilterAlt, label: 'ノイズ低減', text: nr ? '標準' : 'OFF', on: nr }, { value: 'tone' as const, icon: MdGraphicEq, label: '声を整える', text: `${tone}%`, on: tone > 0 }]),
        { value: 'vst', icon: MdExtension, label: 'VST', text: `${vstSlots.length} 個`, on: !bypass },
    ];
    return <div className="lr-root relative flex h-full flex-col overflow-hidden">
        <div className="lr-hero">
            <Scope draw={drawAuroraSpectrum} label="出力の帯域" className="absolute inset-x-0 bottom-0 h-[78%] w-full" />
            <div className="lr-top">
                <span className="text-[17px] font-bold tracking-tight">Aura<span className="text-primary">lyn</span></span>
                <span className="ml-auto" /><MuteButton />
                <button type="button" className="rn-icon" aria-label="設定" aria-pressed={settings !== null} onClick={() => onOpenSettings(settings ? null : 'audio')}><MdSettings aria-hidden="true" className="h-5 w-5" /></button>
                <button type="button" className="rn-icon" aria-label="ヘルプ"><MdHelpOutline aria-hidden="true" className="h-5 w-5" /></button>
            </div>
            <div className="lr-caption">
                {unset ? <>
                    <p className="lr-eyebrow">はじめに</p>
                    <h1 className="lr-title lr-sentence"><button type="button">どのマイク</button>の音を整えて、<button type="button" data-next>どこ</button>へ送る。</h1>
                    <button type="button" className="rn-primary mt-5">送り先を決める<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button>
                </> : live ? <>
                    <p className="lr-eyebrow"><i aria-hidden="true" />実行中{music ? ` · ${devices.musicIn}` : ` · 送り先 ${devices.dest}`}</p>
                    <h1 className="lr-title">{music ? devices.musicOut : '雑談モード'}</h1>
                    {music ? null : <div className="mt-3"><Seg label="モード" value="talk" onChange={() => undefined} options={[{ value: 'talk', label: '雑談' }, { value: 'sing', label: '歌' }]} /></div>}
                </> : <>
                    <p className="lr-eyebrow">停止中</p>
                    <h1 className="lr-title">音は止まっています</h1>
                    <div className="mt-5 flex items-center gap-3"><button type="button" className="rn-primary" onClick={onStart}><MdPlayArrow aria-hidden="true" className="h-5 w-5" />音声を開始</button><span className="text-ui-support text-muted-foreground">保存済みの{music ? '再生元' : 'マイク'}と出力先で開始します。</span></div>
                </>}
            </div>
            {live ? <dl className="lr-readout">
                <div><dt>出力</dt><dd>{peak}<small>dBFS</small></dd></div>
                {music ? null : <div><dt>ノイズ</dt><dd>{nr ? cutText(cut) : '—'}<small>dB</small></dd></div>}
            </dl> : null}
        </div>
        <div className="lr-flow" inert={unset} data-dim={unset || undefined}>
            {stages.map((stage, index) => <span key={stage.value} className="contents">
                {index ? <span aria-hidden="true" className="lr-link" data-on={live} /> : null}
                <button type="button" className="lr-stage" aria-expanded={open === stage.value} data-on={stage.on && !unset} onClick={() => setOpen(value => value === stage.value ? null : stage.value)}>
                    <stage.icon aria-hidden="true" className="h-5 w-5 shrink-0" /><span className="min-w-0"><small>{stage.label}</small><b>{unset ? '—' : stage.text}</b></span>
                </button>
            </span>)}
        </div>
        <div className="rn-collapse" data-open={open !== null}><div><div className="lr-panel">
            {open === 'source' ? <Line label={music ? '入力音量' : 'マイク音量'}><Range value={100} onChange={() => undefined} label="入力音量" className="w-64" /></Line> : null}
            {open === 'nr' ? <Line label="ノイズ低減"><Toggle checked={nr} onChange={setNr} label="ノイズ低減を使う" /><Seg label="強さ" value={nrLevel} onChange={setNrLevel} options={[{ value: 'low', label: '弱' }, { value: 'mid', label: '標準' }, { value: 'high', label: '強' }]} /></Line> : null}
            {open === 'tone' ? <Line label="声の整え具合"><Range value={tone} onChange={setTone} label="声の整え具合" className="w-64" /><span className="rn-mono text-ui-support">{tone}%</span></Line> : null}
            {open === 'vst' ? <div className="flex flex-wrap gap-2">{vstSlots.map(slot => <span key={slot.name} className="lr-vst"><b>{slot.name}</b><small>{slot.kind}</small></span>)}<button type="button" className="rn-outline">VSTを編集</button></div> : null}
        </div></div></div>
        <footer className="lr-dock">
            <button type="button" role="switch" aria-checked={bypass} onClick={() => setBypass(value => !value)} className="rk-bypass lr-bypass"><i aria-hidden="true" />{bypass ? 'VSTオフで比較中' : 'VSTを外して比較'}</button>
            <Scope draw={outMeter} label="出力レベル" className="h-4 min-w-0 flex-1" />
            <span className="whitespace-nowrap text-ui-support text-muted-foreground">出力音量</span>
            <Range value={volume} onChange={setVolume} label="出力音量" className="w-44" />
            <span className="rn-mono w-11 text-right text-ui-support">{volume}%</span>
        </footer>
        {settings ? <Sheet tab={settings} onTab={onOpenSettings} /> : null}
    </div>;
}

function Line({ label, children }: { label: string; children: ReactNode }) { return <div className="flex items-center gap-4"><span className="w-32 text-ui-control font-medium">{label}</span>{children}</div>; }

const tabs = [{ value: 'audio', label: 'オーディオ' }, { value: 'sound', label: '音づくり' }, { value: 'obs', label: 'OBS連携' }, { value: 'appearance', label: '外観' }, { value: 'keys', label: 'ホットキー' }, { value: 'system', label: 'システム' }] as const;

function Sheet({ tab, onTab }: { tab: 'audio' | 'appearance'; onTab: RenewalProps['onOpenSettings'] }) {
    const { theme, setTheme } = useTheme();
    const [aurora, setAurora] = useState(true); const [detail, setDetail] = useState(false);
    return <aside className="lr-sheet" aria-label="設定">
        <div className="flex items-center"><h2 className="text-[28px] font-semibold tracking-tight">設定</h2><button type="button" className="rn-icon ml-auto" aria-label="設定を閉じる" onClick={() => onTab(null)}><MdClose aria-hidden="true" className="h-5 w-5" /></button></div>
        <nav className="lr-tabs" aria-label="設定の種類">{tabs.map(item => <button key={item.value} type="button" aria-current={item.value === tab ? 'page' : undefined} onClick={() => (item.value === 'audio' || item.value === 'appearance') && onTab(item.value)}>{item.label}</button>)}</nav>
        {tab === 'audio' ? <>
            <List title="音の通り道">
                <Item label="入力元" value="マイク・仮想ケーブル" /><Item label="マイク" value={devices.mic} /><Item label="出力先" value={devices.out} /><Item label="送り先" value={devices.dest} />
            </List>
            <List title="接続">
                <Item label="接続方式" value="WASAPI" /><Item label="音の途切れにくさ" value="標準" /><Item label="周波数" value="48,000 Hz" />
            </List>
            <p className="text-ui-support text-muted-foreground">機器を変えると、音が一瞬途切れます。</p>
        </> : <>
            <List title="テーマ">
                {themes.map(item => <button key={item.value} type="button" aria-pressed={theme === item.value} onClick={() => setTheme(item.value as 'dark' | 'light' | 'gaming')} className="lr-item lr-theme">
                    <span data-theme-preview={item.value} className="rn-theme-preview w-24"><i /><i /><i /><b /></span>
                    <span className="min-w-0 flex-1 text-left"><b className="block text-ui-control font-semibold">{item.label}</b><small className="text-ui-support text-muted-foreground">{item.hint}</small></span>
                </button>)}
            </List>
            <List title="表示">
                <Item label="ホームの表示" value="配信・通話向け" />
                <div className="lr-item"><span className="flex-1 text-ui-control">音の光を表示</span><Toggle checked={aurora} onChange={setAurora} label="音の光を表示" /></div>
                <div className="lr-item"><span className="flex-1 text-ui-control">数値の詳細を表示</span><Toggle checked={detail} onChange={setDetail} label="数値の詳細を表示" /></div>
                <Item label="表示言語" value="日本語" />
            </List>
        </>}
    </aside>;
}

function List({ title, children }: { title: string; children: ReactNode }) { return <section><h3 className="lr-list-title">{title}</h3><div className="lr-list">{children}</div></section>; }
function Item({ label, value }: { label: string; value: string }) { return <button type="button" className="lr-item"><span className="flex-1 text-left text-ui-control">{label}</span><span className="truncate text-ui-control text-muted-foreground">{value}</span><MdArrowForward aria-hidden="true" className="h-4 w-4 text-muted-foreground" /></button>; }
