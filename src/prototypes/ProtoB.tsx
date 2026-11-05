// 案B「音の流れ」：マイク→Auralyn→送り方→送り先の線を画面の背骨にする。
// セットアップはダイアログを開かず、流れの線がそのまま手順になる。決まった区間から光が通る。
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { IconType } from 'react-icons';
import { MdCast, MdExtension, MdGraphicEq, MdMic, MdArrowForward } from 'react-icons/md';
import { goals, ProtoHeader, ProtoMeter, ProtoSegment, ProtoStep, setupSteps, useFakeLevel, useSetupDemo, type SetupDemo } from './shared';
import { MixPanel, SoundRows, useSoundDemo } from './HomeParts';
import { SetupBody } from './SetupBodies';
import type { ProtoScreenProps } from './types';

type NodeState = 'empty' | 'next' | 'set';
interface FlowNode { key: string; icon: IconType; label: string; value?: string; state: NodeState }

function Flow({ nodes, flowing, onNode }: { nodes: FlowNode[]; flowing: boolean; onNode?: (key: string) => void }) {
    return <ol aria-label="音の流れ" className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-2">
        {nodes.map((node, index) => <li key={node.key} className="contents">
            <button type="button" onClick={() => onNode?.(node.key)} data-state={node.state} aria-current={node.state === 'next' ? 'step' : undefined}
                className="proto-flow-node flex min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left">
                <span className="proto-flow-icon grid h-10 w-10 shrink-0 place-items-center rounded-full"><node.icon aria-hidden="true" className="h-5 w-5" /></span>
                <span className="min-w-0"><span className="block text-ui-support text-muted-foreground">{node.label}</span>
                    <span className="block truncate text-ui-control font-semibold">{node.value ?? (node.state === 'next' ? 'ここを決める' : '—')}</span></span>
            </button>
            {index < nodes.length - 1 && <span aria-hidden="true" className="proto-flow-link" data-lit={node.state === 'set' && nodes[index + 1].state === 'set'} data-flowing={flowing} />}
        </li>)}
    </ol>;
}

function nodesFor(demo: SetupDemo | null, ready: boolean): FlowNode[] {
    const goal = demo?.goal ? goals.find(item => item.value === demo.goal)?.label : ready ? 'OBSで配信' : undefined;
    const passed = (step: number) => ready || (demo ? demo.stepIndex > step : false);
    const next = (step: number) => !ready && (demo ? demo.stepIndex === step : step === 0);
    const state = (step: number): NodeState => passed(step) ? 'set' : next(step) ? 'next' : 'empty';
    return [
        { key: 'mic', icon: MdMic, label: 'マイク', value: passed(1) ? demo?.mic ?? 'マイク (2)' : undefined, state: state(1) },
        { key: 'auralyn', icon: MdGraphicEq, label: '整える', value: 'Auralyn', state: passed(1) ? 'set' : 'empty' },
        { key: 'route', icon: MdExtension, label: '送り方', value: passed(2) ? (demo?.route === 'cable' ? '仮想ケーブル' : 'Auralyn PCM') : undefined, state: state(2) },
        { key: 'goal', icon: MdCast, label: '送り先', value: passed(0) ? goal : undefined, state: state(0) },
    ];
}

export function ProtoB({ screen, setScreen }: ProtoScreenProps) {
    const sound = useSoundDemo();
    const ready = screen === 'ready';
    return <div className="flex h-full flex-col">
        <ProtoHeader status={ready ? '音声処理中' : '音声未設定'} tone={ready ? 'live' : 'neutral'} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-[1180px] space-y-5">
                {screen === 'setup' ? <InlineSetup onDone={() => setScreen('ready')} onCancel={() => setScreen('unset')} /> : ready ? <ReadyFlow /> : <section className="space-y-4 rounded-2xl bg-card px-6 py-6">
                    <Flow nodes={nodesFor(null, false)} flowing={false} onNode={() => setScreen('setup')} />
                    <div className="flex items-center gap-4">
                        <p className="text-ui-control text-muted-foreground">送り先から順に決めると、線に音が通ります。</p>
                        <button type="button" onClick={() => setScreen('setup')} className="proto-primary ml-auto inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-ui-control font-semibold text-primary-foreground">送り先を決める<MdArrowForward aria-hidden="true" className="proto-primary-arrow h-5 w-5" /></button>
                    </div>
                </section>}
                {screen !== 'setup' && <>
                    <section className={`rounded-xl bg-card px-5 py-4 transition-opacity duration-(--motion-base) ${ready ? '' : 'opacity-40'}`} aria-disabled={!ready}>
                        <h2 className="text-ui-heading font-semibold">音調整</h2>
                        <SoundRows sound={sound} disabled={!ready} />
                    </section>
                    {ready && <MixPanel sound={sound} />}
                </>}
            </div>
        </main>
    </div>;
}

function ReadyFlow() {
    const level = useFakeLevel(true);
    const [mode, setMode] = useState<'sing' | 'talk'>('talk');
    return <section className="live-strip relative isolate space-y-5 overflow-hidden rounded-2xl bg-card px-6 py-6">
        <div aria-hidden="true" className="live-aurora !m-0" data-lit="true" style={{ '--aurora-energy': Math.round(level * 20) / 20 } as CSSProperties} />
        <Flow nodes={nodesFor(null, true)} flowing />
        <div className="grid grid-cols-[auto_1fr_14rem] items-center gap-4">
            <span className="text-ui-support text-muted-foreground">声</span>
            <ProtoMeter level={level} height={14} label="入力レベル" />
            <ProtoSegment label="歌・雑談" value={mode} onChange={setMode} options={[{ value: 'sing', label: '歌' }, { value: 'talk', label: '雑談' }]} />
        </div>
    </section>;
}

function InlineSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
    const demo = useSetupDemo();
    const last = demo.stepIndex === setupSteps.length - 1;
    return <section aria-label="セットアップ" className="space-y-5 rounded-2xl bg-card px-6 py-6">
        <Flow nodes={nodesFor(demo, last)} flowing={last} />
        <div className="proto-progress h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="proto-progress-fill h-full origin-left rounded-full bg-primary" style={{ transform: `scaleX(${(demo.stepIndex + 1) / setupSteps.length})` }} />
        </div>
        <div className="relative h-[340px] overflow-y-auto overflow-x-hidden">
            <ProtoStep stepKey={demo.step} direction={demo.direction} axis="y"><SetupBody demo={demo} look="card" /></ProtoStep>
        </div>
        <footer className="flex items-center gap-3">
            <button type="button" onClick={demo.stepIndex === 0 ? onCancel : demo.back} className="rounded-lg px-4 py-2 text-ui-control text-muted-foreground hover:text-foreground">{demo.stepIndex === 0 ? 'あとで' : '戻る'}</button>
            <span className="ml-auto text-ui-support text-muted-foreground">{demo.canNext ? `${demo.stepIndex + 1} / ${setupSteps.length}` : '目的を選んでください'}</span>
            <button type="button" disabled={!demo.canNext} onClick={last ? onDone : demo.next}
                className={`proto-primary rounded-lg px-6 py-2.5 text-ui-control font-semibold ${demo.canNext ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{last ? '使い始める' : '次へ'}</button>
        </footer>
    </section>;
}
