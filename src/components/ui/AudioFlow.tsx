import { MdArrowForward, MdCallSplit, MdComputer, MdErrorOutline, MdMic, MdMusicNote, MdVolumeUp } from 'react-icons/md';
import type { IconType } from 'react-icons';

export interface AudioFlowNode {
    label: string;
    value?: string;
    warning?: string;
}

export interface AudioFlowProps {
    label: string;
    unknownLabel: string;
    input: AudioFlowNode;
    output: AudioFlowNode;
    receiver: AudioFlowNode;
    branches?: AudioFlowNode[];
    inputKind?: 'microphone' | 'playback';
    processingWarning?: string;
}

function FlowNode({ node, icon: Icon, unknownLabel }: { node: AudioFlowNode; icon: IconType; unknownLabel: string }) {
    return <div className="min-w-0 text-sm">
        <div className="flex items-center gap-1.5 font-medium"><Icon aria-hidden="true" className="shrink-0" />{node.label}</div>
        <p className="mt-1 break-words text-muted-foreground">{node.value || unknownLabel}</p>
        {node.warning && <p className="mt-1 flex items-start gap-1 text-warning"><MdErrorOutline aria-hidden="true" className="mt-0.5 shrink-0" />{node.warning}</p>}
    </div>;
}

/** 選択済みの経路を示す。受信先での受信状態は推測しない。 */
export function AudioFlow({ label, unknownLabel, input, output, receiver, branches = [], inputKind = 'microphone', processingWarning }: AudioFlowProps) {
    const nodes = [
        { node: input, icon: inputKind === 'playback' ? MdMusicNote : MdMic },
        { node: { label: 'Auralyn', value: ' ', warning: processingWarning }, icon: MdComputer },
        ...(branches.length ? [] : [{ node: output, icon: MdVolumeUp }, { node: receiver, icon: MdComputer }]),
    ];
    return <section aria-label={label} className="space-y-3">
        <ol className="flex flex-wrap items-start gap-x-3 gap-y-3">
            {nodes.map(({ node, icon }, index) => <li key={index} className="flex min-w-0 items-start gap-3">
                {index > 0 && <MdArrowForward aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground" />}
                <FlowNode node={node} icon={icon} unknownLabel={unknownLabel} />
            </li>)}
            {branches.length > 0 && <li className="min-w-0 space-y-4" data-flow-outputs>
                <div className="flex items-start gap-3"><MdArrowForward aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground" /><FlowNode node={output} icon={MdVolumeUp} unknownLabel={unknownLabel} /></div>
                <ul className="space-y-3">{branches.map((node, index) => <li key={index} className="flex flex-wrap items-start gap-3" data-flow-branch>
                    <span className="sr-only">Auralyn</span><MdCallSplit aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground" />
                    <FlowNode node={node} icon={MdVolumeUp} unknownLabel={unknownLabel} /><MdArrowForward aria-hidden="true" className="mt-1 shrink-0 text-muted-foreground" /><FlowNode node={receiver} icon={MdComputer} unknownLabel={unknownLabel} />
                </li>)}</ul>
            </li>}
        </ol>
    </section>;
}
