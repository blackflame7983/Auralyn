// 案A「ステージ」：画面の主役を1つにする。ホームは本番帯を大きな舞台にし、セットアップは高さ固定のダイアログで横に進む。
import type { CSSProperties } from 'react';
import { MdArrowForward, MdCast, MdMic } from 'react-icons/md';
import { ProtoHeader, ProtoMeter, ProtoSegment, ProtoStep, setupSteps, useFakeLevel, useSetupDemo } from './shared';
import { MixPanel, SoundRows, useSoundDemo } from './HomeParts';
import { SetupBody } from './SetupBodies';
import type { ProtoScreenProps } from './types';
import { useState } from 'react';

export function ProtoA({ screen, setScreen }: ProtoScreenProps) {
    const sound = useSoundDemo();
    const ready = screen === 'ready';
    return <div className="flex h-full flex-col">
        <ProtoHeader status={ready ? '音声処理中' : '音声未設定'} tone={ready ? 'live' : 'neutral'} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-[1180px] space-y-5">
                {ready ? <ReadyStage /> : <UnsetStage onStart={() => setScreen('setup')} />}
                <section className={`rounded-xl bg-card px-5 py-4 transition-opacity duration-(--motion-base) ${ready ? '' : 'opacity-40'}`} aria-disabled={!ready}>
                    <div className="flex items-baseline gap-3"><h2 className="text-ui-heading font-semibold">音調整</h2>{!ready && <span className="text-ui-support text-muted-foreground">設定が済むと使えます</span>}</div>
                    <SoundRows sound={sound} disabled={!ready} />
                </section>
                {ready && <MixPanel sound={sound} />}
            </div>
        </main>
        {screen === 'setup' && <SetupDialogA onClose={() => setScreen('unset')} onDone={() => setScreen('ready')} />}
    </div>;
}

function UnsetStage({ onStart }: { onStart: () => void }) {
    return <section className="live-strip relative isolate overflow-hidden rounded-2xl bg-card px-8 py-10">
        <div aria-hidden="true" className="live-aurora proto-aurora-dawn" data-lit="true" style={{ '--aurora-energy': 0 } as CSSProperties} />
        <p className="text-ui-support font-semibold text-primary">はじめに</p>
        <h1 className="mt-1 text-[1.75rem] font-semibold leading-tight tracking-tight">マイクと送り先を決めましょう</h1>
        <ol className="mt-5 flex flex-wrap gap-2" aria-label="手順">
            {setupSteps.slice(0, 3).map((step, index) => <li key={step.value} className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-ui-support">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-background text-[11px] font-bold">{index + 1}</span>{step.label}</li>)}
        </ol>
        <button type="button" onClick={onStart} className="proto-primary mt-7 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-ui-control font-semibold text-primary-foreground">
            セットアップを始める<MdArrowForward aria-hidden="true" className="proto-primary-arrow h-5 w-5" />
        </button>
    </section>;
}

function ReadyStage() {
    const level = useFakeLevel(true);
    const [mode, setMode] = useState<'sing' | 'talk'>('talk');
    const energy = Math.round(level * 20) / 20;
    return <section className="live-strip relative isolate overflow-hidden rounded-2xl bg-card px-7 py-6">
        <div aria-hidden="true" className="live-aurora" data-lit="true" style={{ '--aurora-energy': energy } as CSSProperties} />
        <div className="flex flex-wrap items-center gap-4">
            <p className="flex min-w-0 items-center gap-2 text-ui-control"><MdMic aria-hidden="true" className="h-5 w-5 text-muted-foreground" /><span className="font-semibold">マイク (2)</span>
                <MdArrowForward aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><MdCast aria-hidden="true" className="h-5 w-5 text-muted-foreground" /><span className="font-semibold">OBS</span><span className="text-muted-foreground">Auralyn PCM</span></p>
            <div className="ml-auto w-56"><ProtoSegment size="lg" label="歌・雑談" value={mode} onChange={setMode} options={[{ value: 'sing', label: '歌' }, { value: 'talk', label: '雑談' }]} /></div>
        </div>
        <div className="mt-6 space-y-2">
            <div className="flex items-center justify-between text-ui-support text-muted-foreground"><span>声</span><span>よい音量</span></div>
            <ProtoMeter level={level} height={18} label="入力レベル" />
        </div>
    </section>;
}

function SetupDialogA({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const demo = useSetupDemo();
    const last = demo.stepIndex === setupSteps.length - 1;
    return <div className="proto-overlay fixed inset-0 z-40 grid place-items-center bg-overlay/60 p-6" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        <div role="dialog" aria-modal="true" aria-label="セットアップ" className="proto-dialog grid h-[min(560px,calc(100vh-48px))] w-[min(820px,100%)] grid-cols-[200px_1fr] overflow-hidden rounded-2xl border border-border bg-popover">
            <nav aria-label="手順" className="relative bg-card px-4 py-6">
                <p className="px-2 pb-4 text-ui-support font-semibold text-muted-foreground">セットアップ</p>
                <ol className="relative space-y-1" style={{ '--rail-index': demo.stepIndex } as CSSProperties}>
                    <span aria-hidden="true" className="proto-rail-thumb" />
                    {setupSteps.map((step, index) => <li key={step.value} aria-current={index === demo.stepIndex ? 'step' : undefined}
                        className={`relative flex h-11 items-center gap-3 rounded-lg px-3 text-ui-control transition-colors duration-(--motion-base) ${index === demo.stepIndex ? 'font-semibold text-foreground' : index < demo.stepIndex ? 'text-foreground' : 'text-muted-foreground'}`}>
                        <span className={`grid h-6 w-6 place-items-center rounded-full text-[12px] font-bold transition-colors duration-(--motion-base) ${index <= demo.stepIndex ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{index + 1}</span>{step.label}
                    </li>)}
                </ol>
            </nav>
            <div className="flex min-h-0 flex-col">
                <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-8 py-7">
                    <ProtoStep stepKey={demo.step} direction={demo.direction}><SetupBody demo={demo} look="card" /></ProtoStep>
                </div>
                <footer className="flex items-center gap-3 border-t border-border px-8 py-4">
                    <button type="button" onClick={demo.stepIndex === 0 ? onClose : demo.back} className="rounded-lg px-4 py-2 text-ui-control text-muted-foreground hover:text-foreground">{demo.stepIndex === 0 ? 'あとで' : '戻る'}</button>
                    {!demo.canNext && <span className="ml-auto text-ui-support text-muted-foreground">目的を選んでください</span>}
                    <button type="button" disabled={!demo.canNext} onClick={last ? onDone : demo.next}
                        className={`proto-primary rounded-lg px-6 py-2.5 text-ui-control font-semibold ${demo.canNext ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{last ? '使い始める' : '次へ'}</button>
                </footer>
            </div>
        </div>
    </div>;
}
