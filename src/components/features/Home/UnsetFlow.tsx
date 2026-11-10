import { Button } from '@/components/ui/button';
import type { IconType } from 'react-icons';
import { MdArrowForward, MdCast, MdGraphicEq, MdMic, MdMusicNote, MdSettingsInputComponent } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import type { PreparationUse } from '@/lib/preparation';
import { deviceDisplayName } from '@/lib/audioRouting';

type NodeState = 'empty' | 'next' | 'set';
type NodeKey = 'input' | 'shape' | 'output' | 'destination';

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// 未設定のホームは、音の流れと次の1歩だけを出す（DESIGN.md 5.7、#297）。
// 区間は音の順（入力→整える→送り方→送り先）に並べ、決める順（送り先→入力→送り方）の先頭だけを「次に決める所」にする。
export function UnsetFlow({ usage, input, output, music = false, onSetup }: {
    usage?: PreparationUse | null; input?: string; output?: string; music?: boolean; onSetup: () => void;
}) {
    const t = useMessages();
    const next: NodeKey = !usage && !music ? 'destination' : !input ? 'input' : 'output';
    const state = (key: NodeKey, decided: boolean): NodeState => decided ? 'set' : key === next ? 'next' : 'empty';
    const nodes: { key: NodeKey; icon: IconType; label: MessageKey; value?: string; state: NodeState }[] = [
        { key: 'input', icon: music ? MdMusicNote : MdMic, label: music ? 'unsetFlow.source' : 'unsetFlow.mic', value: input ? deviceDisplayName(input) : undefined, state: state('input', Boolean(input)) },
        { key: 'shape', icon: MdGraphicEq, label: 'unsetFlow.shape', value: 'Auralyn', state: 'set' },
        { key: 'output', icon: MdSettingsInputComponent, label: 'unsetFlow.output', value: output ? deviceDisplayName(output) : undefined, state: state('output', Boolean(output)) },
        { key: 'destination', icon: MdCast, label: 'unsetFlow.destination', value: music ? t('prep.local') : usage ? t(destinations[usage]) : undefined, state: state('destination', music || Boolean(usage)) },
    ];
    const action: MessageKey = next === 'destination' ? 'unsetFlow.chooseDestination' : next === 'input' ? music ? 'unsetFlow.chooseSource' : 'unsetFlow.chooseMic' : 'unsetFlow.chooseOutput';
    const stateLabel: Record<NodeState, MessageKey> = { set: 'unsetFlow.stateSet', next: 'unsetFlow.stateNext', empty: 'unsetFlow.stateEmpty' };
    return <section aria-label={t('unsetFlow.label')} className="unset-flow mb-4 space-y-4 rounded-card bg-card gaming:bg-card/70 px-5 py-5 min-[1100px]:px-6">
        <ol className="unset-flow-list">
            {nodes.map((node, index) => <li key={node.key} className="contents">
                {/* どの区間を押してもセットアップを開く。決める順は案内に任せ、区間ごとの別画面を作らない。 */}
                <Button variant="ghost" size="default" type="button" onClick={onSetup} data-state={node.state} aria-current={node.state === 'next' ? 'step' : undefined}
                    aria-label={`${t(node.label)} ${node.value ?? (node.state === 'next' ? t('unsetFlow.next') : t('unsetFlow.empty'))}、${t(stateLabel[node.state])}`}
                    className="unset-flow-node min-w-0 gap-3 text-left h-auto whitespace-normal justify-start">
                    <span className="unset-flow-icon grid h-8 w-8 shrink-0 place-items-center rounded-full"><node.icon aria-hidden="true" className="h-4 w-4" /></span>
                    <span className="min-w-0">
                        <span className="block text-ui-support text-muted-foreground">{t(node.label)}</span>
                        <span className="home-card-name block truncate" title={node.value}>{node.value ?? (node.state === 'next' ? t('unsetFlow.next') : <span aria-hidden="true">—</span>)}</span>
                    </span>
                </Button>
                {index < nodes.length - 1 && <span aria-hidden="true" className="unset-flow-link" data-lit={node.state === 'set' && nodes[index + 1].state === 'set'} />}
            </li>)}
        </ol>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            {next === 'destination' && <p className="text-ui-control text-muted-foreground">{t('unsetFlow.hint')}</p>}
            <Button variant="default" size="default" type="button" onClick={onSetup} className="home-action unset-flow-primary ml-auto gap-2">
                {t(action)}<MdArrowForward aria-hidden="true" className="unset-flow-arrow h-5 w-5" />
            </Button>
        </div>
    </section>;
}
