// 案C「タイル」：文字を減らし、大きなアイコンと面で操作を見分ける。
// ホームは機能ごとのタイル、セットアップはウィンドウ全体を使う一画面ずつの手順にする。
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { MdArrowBack, MdArrowForward, MdCast, MdFilterAlt, MdMic, MdQueueMusic, MdRecordVoiceOver, MdSpatialAudio, MdClose } from 'react-icons/md';
import { ProtoCollapse, ProtoHeader, ProtoMeter, ProtoSegment, ProtoStep, ProtoSwitch, setupSteps, useFakeLevel, useSetupDemo } from './shared';
import { MixPanel, noiseOptions, useSoundDemo, voiceOptions, type SoundDemo } from './HomeParts';
import { SetupBody } from './SetupBodies';
import type { ProtoScreenProps } from './types';

export function ProtoC({ screen, setScreen }: ProtoScreenProps) {
    const sound = useSoundDemo();
    if (screen === 'setup') return <FullSetup onDone={() => setScreen('ready')} onCancel={() => setScreen('unset')} />;
    const ready = screen === 'ready';
    return <div className="flex h-full flex-col">
        <ProtoHeader status={ready ? '音声処理中' : '音声未設定'} tone={ready ? 'live' : 'neutral'} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-[1180px] space-y-4">
                {ready ? <VoiceTile /> : <button type="button" onClick={() => setScreen('setup')} className="proto-tile proto-tile-cta live-strip relative isolate flex w-full items-center gap-5 overflow-hidden px-7 py-7 text-left">
                    <div aria-hidden="true" className="live-aurora proto-aurora-dawn" data-lit="true" />
                    <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground"><MdMic aria-hidden="true" className="h-9 w-9" /></span>
                    <span className="min-w-0"><span className="block text-[1.5rem] font-semibold tracking-tight">マイクをつなぐ</span><span className="block text-ui-support text-muted-foreground">約1分・3つ選ぶだけ</span></span>
                    <MdArrowForward aria-hidden="true" className="proto-primary-arrow ml-auto h-8 w-8 text-primary" />
                </button>}
                <Tiles sound={sound} disabled={!ready} />
                {ready && <ProtoCollapse open={sound.mixOpen}><MixPanel sound={sound} /></ProtoCollapse>}
            </div>
        </main>
    </div>;
}

function VoiceTile() {
    const level = useFakeLevel(true);
    const [mode, setMode] = useState<'sing' | 'talk'>('talk');
    return <section className="proto-tile live-strip relative isolate overflow-hidden px-6 py-5">
        <div aria-hidden="true" className="live-aurora" data-lit="true" style={{ '--aurora-energy': Math.round(level * 20) / 20 } as CSSProperties} />
        <div className="flex items-center gap-4">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-muted"><MdMic aria-hidden="true" className="h-6 w-6" /></span>
            <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2 text-ui-control"><span className="font-semibold">マイク (2)</span><MdArrowForward aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><MdCast aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><span className="font-semibold">OBS</span></div>
                <ProtoMeter level={level} height={14} label="入力レベル" />
            </div>
            <div className="w-48"><ProtoSegment size="lg" label="歌・雑談" value={mode} onChange={setMode} options={[{ value: 'sing', label: '歌' }, { value: 'talk', label: '雑談' }]} /></div>
        </div>
    </section>;
}

function Tiles({ sound, disabled }: { sound: SoundDemo; disabled: boolean }) {
    const tiles = [
        { key: 'noise', icon: MdFilterAlt, label: 'ノイズ低減', on: sound.noise !== 'off', control: <ProtoSegment label="ノイズ低減" value={sound.noise} onChange={sound.setNoise} options={noiseOptions} /> },
        { key: 'voice', icon: MdRecordVoiceOver, label: '声を整える', on: sound.voice !== 'off', control: <ProtoSegment label="声を整える" value={sound.voice} onChange={sound.setVoice} options={voiceOptions} /> },
        { key: 'reverb', icon: MdSpatialAudio, label: '残響', on: sound.reverb, control: <ProtoSwitch label="残響" checked={sound.reverb} onChange={sound.setReverb} /> },
        { key: 'mix', icon: MdQueueMusic, label: '配信ミックス', on: sound.mixOpen, control: <button type="button" onClick={() => sound.setMixOpen(!sound.mixOpen)} className="rounded-lg border border-border px-3 py-1.5 text-ui-support font-semibold">{sound.mixOpen ? '閉じる' : '開く'}</button> },
    ];
    return <div className={`grid grid-cols-2 gap-4 transition-opacity duration-(--motion-base) min-[1100px]:grid-cols-4 ${disabled ? 'pointer-events-none opacity-40' : ''}`} aria-disabled={disabled}>
        {tiles.map(tile => <section key={tile.key} data-on={tile.on && !disabled} className="proto-tile proto-feature-tile flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center gap-3">
                <span className="proto-tile-icon grid h-11 w-11 place-items-center rounded-xl"><tile.icon aria-hidden="true" className="h-6 w-6" /></span>
                <span className="text-ui-control font-semibold">{tile.label}</span>
            </div>
            <div className="mt-auto">{tile.control}</div>
        </section>)}
    </div>;
}

function FullSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
    const demo = useSetupDemo();
    const last = demo.stepIndex === setupSteps.length - 1;
    return <div className="proto-fullsetup flex h-full flex-col bg-background">
        <div className="proto-progress h-1 bg-muted" aria-hidden="true"><div className="proto-progress-fill h-full origin-left bg-primary" style={{ transform: `scaleX(${(demo.stepIndex + 1) / setupSteps.length})` }} /></div>
        <header className="flex h-14 items-center gap-3 px-6">
            <span className="text-ui-support font-semibold text-muted-foreground">{demo.stepIndex + 1} / {setupSteps.length}　{setupSteps[demo.stepIndex].label}</span>
            <button type="button" onClick={onCancel} aria-label="閉じる" className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"><MdClose className="h-5 w-5" /></button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto max-w-[720px] px-6 py-6"><ProtoStep stepKey={demo.step} direction={demo.direction}><SetupBody demo={demo} look="tile" /></ProtoStep></div>
        </div>
        <footer className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-6 pb-8">
            {demo.stepIndex > 0 && <button type="button" onClick={demo.back} className="inline-flex items-center gap-1 rounded-lg px-4 py-3 text-ui-control text-muted-foreground hover:text-foreground"><MdArrowBack aria-hidden="true" className="h-5 w-5" />戻る</button>}
            <button type="button" disabled={!demo.canNext} onClick={last ? onDone : demo.next}
                className={`proto-primary ml-auto inline-flex min-w-[12rem] items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-ui-control font-semibold ${demo.canNext ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {demo.canNext ? last ? '使い始める' : '次へ' : '送り先を選んでください'}{demo.canNext && <MdArrowForward aria-hidden="true" className="proto-primary-arrow h-5 w-5" />}
            </button>
        </footer>
    </div>;
}
