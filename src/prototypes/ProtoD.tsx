// 案D「オーロラの本番帯」：GPT のイメージ案（2026-11-07）から、状態の見せ方・ブランドの光・音調整の畳み方を取り入れた試作。
// 本番中に読むものを「いまの状態とモード」「声とオケ」「音調整の1行」「送り先の1行」に絞る。
// 未設定とセットアップは採用案（A＋B）のまま。音声エンジン・保存設定には触れない。
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import type { IconType } from 'react-icons';
import {
    MdCable, MdCast, MdExtension, MdFilterAlt, MdHeadphones, MdHearing, MdHelpOutline, MdLock, MdLockOpen,
    MdMic, MdMicOff, MdOpenInNew, MdQueueMusic, MdRecordVoiceOver, MdSettings, MdTune, MdVolumeUp,
} from 'react-icons/md';
import { ProtoA } from './ProtoA';
import { ProtoCollapse, ProtoMeter, ProtoSegment, ProtoSwitch, useFakeLevel } from './shared';
import { noiseOptions, voiceOptions, useSoundDemo, type SoundDemo } from './HomeParts';
import type { ProtoScreenProps } from './types';

export function ProtoD(props: ProtoScreenProps) {
    // 未設定とセットアップは採用案の流れを使い、違いを本番中のホームに絞って比べる。
    if (props.screen !== 'ready') return <ProtoA {...props} unsetFlow />;
    return <ReadyHome />;
}

type Mode = 'sing' | 'talk';
type Tool = 'noise' | 'voice' | 'vst' | 'compare' | 'mix' | 'route';

function ReadyHome() {
    const sound = useSoundDemo();
    const [running, setRunning] = useState(true);
    const [mode, setMode] = useState<Mode>('talk');
    const [locked, setLocked] = useState(false);
    const [backingMuted, setBackingMuted] = useState(true);
    const [bypass, setBypass] = useState(false);
    const [open, setOpen] = useState<Tool | null>(null);
    const voiceLevel = useFakeLevel(running);
    const backingLevel = useFakeLevel(running && !backingMuted) * 0.7;
    return <div className="flex h-full flex-col">
        <HeaderD />
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
            <div className="mx-auto max-w-[1180px] space-y-3">
                {/* 音調整を開いている間は本番帯を低くし、作業する場所を優先する（DESIGN.md の「作業中はコンパクトへ戻す」）。 */}
                <Stage compact={open !== null} running={running} level={voiceLevel} mode={mode} setMode={setMode} locked={locked} setLocked={setLocked} onToggleRunning={() => setRunning(value => !value)} />
                <Channels voiceLevel={voiceLevel} backingLevel={backingLevel} backingMuted={backingMuted} setBackingMuted={setBackingMuted} />
                <Tools sound={sound} open={open} setOpen={setOpen} bypass={bypass} />
            </div>
        </main>
        <FooterD bypass={bypass} setBypass={setBypass} />
    </div>;
}

function HeaderD() {
    return <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <span className="text-lg font-bold tracking-tight">Aura<span className="text-primary">lyn</span></span>
        {/* 緊急ミュートは今の規則どおりヘッダーに常設する（イメージ案はフッター）。 */}
        <button type="button" className="ml-auto inline-flex items-center gap-2 rounded-full border border-destructive-text/70 px-4 py-1.5 text-ui-support font-bold text-destructive-text hover:bg-destructive/10">
            <MdMicOff aria-hidden="true" className="h-4 w-4" />緊急ミュート
        </button>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ui-support text-muted-foreground hover:text-foreground"><MdSettings aria-hidden="true" className="h-5 w-5" />設定</button>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ui-support text-muted-foreground hover:text-foreground"><MdHelpOutline aria-hidden="true" className="h-5 w-5" />ヘルプ</button>
    </header>;
}

/** 本番帯：いまの状態とモードを主役にし、奥にオーロラを灯す。高さは窓の高さに合わせて伸び縮みする。 */
function Stage({ compact, running, level, mode, setMode, locked, setLocked, onToggleRunning }: {
    compact: boolean; running: boolean; level: number; mode: Mode; setMode: (mode: Mode) => void; locked: boolean; setLocked: (locked: boolean) => void; onToggleRunning: () => void;
}) {
    const energy = running ? Math.round(level * 20) / 20 : 0;
    return <section aria-label="本番" className="proto-d-stage relative isolate overflow-hidden rounded-2xl bg-card px-6" data-running={running} data-compact={compact}
        style={{ '--aurora-energy': energy } as CSSProperties}>
        <AuroraRibbons />
        <div className="relative flex h-full flex-col items-center justify-center gap-2 py-4 text-center">
            <p className="flex items-center gap-3 text-ui-support">
                <span className="inline-flex items-center gap-2 font-semibold">
                    <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${running ? 'proto-live-dot bg-success' : 'bg-muted-foreground'}`} />
                    {running ? '音声処理中' : '停止中'}
                </span>
                {/* 停止は本番中によく触る比較スイッチから離し、状態の隣に小さく置く。 */}
                <button type="button" onClick={onToggleRunning} className="rounded-md px-2 py-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    {running ? '音声を停止' : '音声を開始'}
                </button>
            </p>
            <h2 className="proto-d-mode font-semibold leading-none tracking-tight" aria-live="polite">{mode === 'sing' ? '歌' : '雑談'}<span className="sr-only">モード</span></h2>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                <div className="w-48"><ProtoSegment size="lg" label="歌・雑談" value={mode} onChange={value => { if (!locked) setMode(value); }} options={[{ value: 'sing', label: '歌' }, { value: 'talk', label: '雑談' }]} /></div>
                <button type="button" aria-pressed={locked} onClick={() => setLocked(!locked)}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-ui-support font-semibold transition-colors duration-(--motion-fast) ${locked ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                    {locked ? <MdLock aria-hidden="true" className="h-4 w-4" /> : <MdLockOpen aria-hidden="true" className="h-4 w-4" />}
                    操作ロック{locked ? '中' : ''}
                </button>
            </div>
        </div>
    </section>;
}

/**
 * 光のカーテン。ぼかしフィルターを使わず、細い線の束とグラデーションで描く（DESIGN.md 5.1）。
 * 緑から青緑が中心で、上端にだけ淡い赤紫（BRANDING.md）。動きは transform だけで、動きを減らす設定では止める。
 */
function AuroraRibbons() {
    const id = useId().replace(/:/g, '');
    const ribbons = [
        { d: 'M-80 150 C 140 60, 300 210, 520 120 S 860 40, 1080 130 S 1320 200, 1480 90', strands: 9, spread: 5, delay: '0s' },
        { d: 'M-60 190 C 180 120, 360 250, 600 170 S 940 110, 1180 190 S 1380 230, 1500 160', strands: 7, spread: 6, delay: '-7s' },
        { d: 'M-40 110 C 220 170, 420 40, 700 100 S 1020 170, 1260 80 S 1420 60, 1520 110', strands: 6, spread: 4, delay: '-13s' },
    ];
    return <div aria-hidden="true" className="proto-d-aurora pointer-events-none absolute inset-0 -z-10">
        <svg className="h-full w-full" viewBox="0 0 1440 260" preserveAspectRatio="xMidYMid slice">
            <defs>
                <linearGradient id={`${id}-v`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0.55" />
                    <stop offset="28%" stopColor="hsl(var(--aurora-green))" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-teal))" stopOpacity="0.15" />
                </linearGradient>
                <linearGradient id={`${id}-h`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="white" stopOpacity="0" />
                    <stop offset="22%" stopColor="white" stopOpacity="1" />
                    <stop offset="78%" stopColor="white" stopOpacity="1" />
                    <stop offset="100%" stopColor="white" stopOpacity="0" />
                </linearGradient>
                <mask id={`${id}-m`}><rect width="1440" height="260" fill={`url(#${id}-h)`} /></mask>
            </defs>
            <g mask={`url(#${id}-m)`}>
                {ribbons.map((ribbon, index) => <g key={index} className="proto-d-ribbon" style={{ animationDelay: ribbon.delay }}>
                    {/* ぼかしの代わりに、太く薄い線を重ねて光のにじみを作る。 */}
                    <path d={ribbon.d} fill="none" stroke={`url(#${id}-v)`} strokeWidth={64} strokeOpacity={0.2} strokeLinecap="round" />
                    <path d={ribbon.d} fill="none" stroke={`url(#${id}-v)`} strokeWidth={28} strokeOpacity={0.32} strokeLinecap="round" />
                    {/* 細い線の束で、カーテンの縦の筋を見せる。 */}
                    {Array.from({ length: ribbon.strands }, (_, strand) => <path key={strand} d={ribbon.d}
                        transform={`translate(0 ${(strand - ribbon.strands / 2) * ribbon.spread})`}
                        fill="none" stroke={`url(#${id}-v)`} strokeWidth={strand % 3 === 0 ? 2 : 1.1}
                        strokeOpacity={0.5 + (strand % 4) * 0.15} vectorEffect="non-scaling-stroke" />)}
                </g>)}
            </g>
        </svg>
    </div>;
}

/** 声とオケ：メーター・音量・ミュートを同じ行に置き、状態とそれを解く操作を同じ色でそろえる。 */
function Channels({ voiceLevel, backingLevel, backingMuted, setBackingMuted }: {
    voiceLevel: number; backingLevel: number; backingMuted: boolean; setBackingMuted: (muted: boolean) => void;
}) {
    const [voiceMuted, setVoiceMuted] = useState(false);
    const [micGain, setMicGain] = useState(100);
    const [backingGain, setBackingGain] = useState(70);
    return <section aria-label="声とオケ" className="grid rounded-xl bg-card md:grid-cols-2 md:divide-x md:divide-border">
        <Channel icon={MdMic} name="声" source="マイク (2)" level={voiceMuted ? 0 : voiceLevel} muted={voiceMuted} onMute={setVoiceMuted}
            gainLabel="マイク音量" gain={micGain} setGain={setMicGain} />
        <Channel icon={MdQueueMusic} name="オケ" source="アプリの音" level={backingLevel} muted={backingMuted} onMute={setBackingMuted}
            gainLabel="オケの音量" gain={backingGain} setGain={setBackingGain} />
    </section>;
}

function Channel({ icon: Icon, name, source, level, muted, onMute, gainLabel, gain, setGain }: {
    icon: IconType; name: string; source: string; level: number; muted: boolean; onMute: (muted: boolean) => void; gainLabel: string; gain: number; setGain: (gain: number) => void;
}) {
    const gainId = useId();
    return <div className="space-y-3 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
            <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="text-ui-control font-semibold">{name}</span>
            <span className="min-w-0 truncate text-ui-support text-muted-foreground" title={source}>{source}</span>
            {muted && <span className="ml-auto shrink-0 text-ui-support font-semibold text-warning">ミュート中</span>}
        </div>
        <div className={muted ? 'opacity-40' : undefined}><ProtoMeter level={level} height={10} label={`${name}のレベル`} /></div>
        <div className="flex items-center gap-3">
            <label htmlFor={gainId} className="shrink-0 text-ui-support text-muted-foreground">{gainLabel}</label>
            <input id={gainId} type="range" min={0} max={200} value={gain} onChange={event => setGain(Number(event.target.value))} className="min-w-0 flex-1 accent-[hsl(var(--primary))]" />
            <span className="w-11 shrink-0 text-right text-ui-support tabular-nums">{gain}%</span>
            <button type="button" aria-pressed={muted} onClick={() => onMute(!muted)}
                className={`w-20 shrink-0 rounded-lg border px-3 py-1.5 text-ui-support font-semibold transition-colors duration-(--motion-fast) ${muted ? 'border-warning text-warning hover:bg-warning/10' : 'border-border text-foreground hover:bg-accent'}`}>
                {muted ? '解除' : 'ミュート'}<span className="sr-only">（{name}）</span>
            </button>
        </div>
    </div>;
}

/** 音調整を1行のアイコン列に畳む。状態は色の点だけでなく文字でも示し、押すとその場で操作が開く。 */
function Tools({ sound, open, setOpen, bypass }: { sound: SoundDemo; open: Tool | null; setOpen: (tool: Tool | null) => void; bypass: boolean }) {
    const panelId = useId();
    const noiseLabel = noiseOptions.find(option => option.value === sound.noise)?.label ?? '';
    const voiceLabel = voiceOptions.find(option => option.value === sound.voice)?.label ?? '';
    const tools: { key: Tool; icon: IconType; label: string; state: string; tone: 'on' | 'off' | 'warn' }[] = [
        { key: 'noise', icon: MdFilterAlt, label: 'ノイズ低減', state: sound.noise === 'off' ? 'オフ' : noiseLabel, tone: sound.noise === 'off' || bypass ? 'off' : 'on' },
        { key: 'voice', icon: MdRecordVoiceOver, label: '声を整える', state: sound.voice === 'off' ? 'オフ' : voiceLabel, tone: sound.voice === 'off' || bypass ? 'off' : 'on' },
        { key: 'vst', icon: MdExtension, label: 'VST', state: bypass ? '比較中（外す）' : '2件', tone: bypass ? 'warn' : 'on' },
        { key: 'compare', icon: MdHearing, label: '聴き比べ', state: '録音して比べる', tone: 'off' },
        { key: 'mix', icon: MdTune, label: '配信ミックス', state: `オケ ${sound.backing}%`, tone: 'on' },
        { key: 'route', icon: MdCast, label: '送り先', state: 'OBS・未確認', tone: 'warn' },
    ];
    return <section aria-label="音調整" className="rounded-xl bg-card">
        <ul className="grid grid-cols-3 md:grid-cols-6">
            {tools.map(tool => <li key={tool.key} className="min-w-0">
                <button type="button" aria-expanded={open === tool.key} aria-controls={panelId} onClick={() => setOpen(open === tool.key ? null : tool.key)}
                    className="proto-d-tool flex h-full w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left" data-open={open === tool.key}>
                    <tool.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                        <span className="block text-ui-control font-semibold">{tool.label}</span>
                        <span className="flex items-center gap-1.5 text-ui-support text-muted-foreground">
                            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${tool.tone === 'on' ? 'bg-success' : tool.tone === 'warn' ? 'bg-warning' : 'bg-muted-foreground/50'}`} />
                            <span className="truncate">{tool.state}</span>
                        </span>
                    </span>
                </button>
            </li>)}
        </ul>
        <ProtoCollapse open={open !== null} id={panelId}>
            <div className="border-t border-border px-5 py-4">{open && <ToolPanel tool={open} sound={sound} />}</div>
        </ProtoCollapse>
        <RouteLine />
    </section>;
}

function ToolPanel({ tool, sound }: { tool: Tool; sound: SoundDemo }) {
    const row = (label: string, control: ReactNode) => <div className="flex flex-wrap items-center gap-4"><span className="text-ui-control font-semibold">{label}</span><div className="ml-auto w-full max-w-sm">{control}</div></div>;
    if (tool === 'noise') return row('ノイズ低減の強さ', <ProtoSegment label="ノイズ低減" value={sound.noise} onChange={sound.setNoise} options={noiseOptions} />);
    if (tool === 'voice') return row('声の整え方', <ProtoSegment label="声を整える" value={sound.voice} onChange={sound.setVoice} options={voiceOptions} />);
    if (tool === 'mix') return <div className="space-y-3">
        <label className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-ui-control"><span>オケの音量</span>
            <input type="range" min={0} max={100} value={sound.backing} onChange={event => sound.setBacking(Number(event.target.value))} className="accent-[hsl(var(--primary))]" />
            <span className="text-right text-ui-support tabular-nums">{sound.backing}%</span></label>
        <div className="flex items-center justify-between text-ui-control"><span>歌モニター</span><ProtoSwitch label="歌モニター" checked={sound.monitor} onChange={sound.setMonitor} /></div>
    </div>;
    const text: Record<Exclude<Tool, 'noise' | 'voice' | 'mix'>, string> = {
        vst: 'ここに VST の一覧と「VST を編集」が開きます（試作）。',
        compare: 'ここに「録音して聴き比べる」が開きます（試作）。',
        route: 'ここに送り先の確認と「音のトラブルを診断」が開きます（試作）。',
    };
    return <p className="text-ui-support text-muted-foreground">{text[tool]}</p>;
}

/** 送り先：配信用と自分用を1行で示し、まだ確かめていないことを確かめる操作と一緒に出す。 */
function RouteLine() {
    return <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-5 py-3 text-ui-support">
        <span className="inline-flex min-w-0 items-center gap-2"><MdCable aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">配信用</span><span className="font-semibold">仮想ケーブル → OBS</span></span>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-warning px-3 py-1 font-semibold text-warning hover:bg-warning/10">
            OBS に届いているか確かめる<MdOpenInNew aria-hidden="true" className="h-4 w-4" />
        </button>
        <span className="inline-flex min-w-0 items-center gap-2 md:ml-auto"><MdHeadphones aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">自分用</span><span className="font-semibold">ヘッドホン</span></span>
    </div>;
}

function FooterD({ bypass, setBypass }: { bypass: boolean; setBypass: (value: boolean) => void }) {
    const [volume, setVolume] = useState(100);
    const volumeId = useId();
    return <footer className="flex h-14 shrink-0 items-center gap-5 border-t border-border px-5">
        <label className="flex items-center gap-3 text-ui-control">
            <span className="inline-flex items-center gap-2" id={volumeId}><MdVolumeUp aria-hidden="true" className="h-5 w-5 text-muted-foreground" />出力音量</span>
            <input type="range" min={0} max={100} value={volume} aria-labelledby={volumeId} onChange={event => setVolume(Number(event.target.value))} className="w-40 accent-[hsl(var(--primary))]" />
            <span className="w-11 text-right text-ui-support tabular-nums">{volume}%</span>
        </label>
        <span className="ml-auto flex items-center gap-3 text-ui-control">
            <span className={bypass ? 'font-semibold text-warning' : undefined}>VST を外して比較{bypass ? '中' : ''}</span>
            <ProtoSwitch label="VST を外して比較" checked={bypass} onChange={setBypass} />
        </span>
    </footer>;
}
