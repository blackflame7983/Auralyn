// #301 の見た目と動きの試作で共通に使う部品。開発時だけ読み込み、本番の画面・音声処理には関わらない。
// 文言は比較のための仮のもので、i18n へは載せない（採用案を実装するときに文言キーへ移す）。
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { MdCast, MdHeadphones, MdHeadsetMic, MdMic, MdMicOff, MdSettings, MdHelpOutline, MdTune } from 'react-icons/md';

/** 試作のメーター用の擬似レベル（0〜1）。話し声らしく揺らす。running が false なら 0。 */
export function useFakeLevel(running: boolean): number {
    const [level, setLevel] = useState(0);
    useEffect(() => {
        if (!running) { setLevel(0); return; }
        let frame = 0; let last = 0; let id = 0;
        const tick = (now: number) => {
            id = requestAnimationFrame(tick);
            if (now - last < 33) return;
            last = now; frame += 1;
            const phrase = (Math.sin(frame / 23) + 1) / 2;
            const syllable = Math.abs(Math.sin(frame / 3.1)) * 0.35;
            setLevel(Math.min(1, 0.18 + phrase * 0.45 + syllable * phrase));
        };
        id = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(id);
    }, [running]);
    return level;
}

/** 横向きのメーター。幅は scaleX で変え、レイアウトを動かさない。 */
export function ProtoMeter({ level, height = 10, label }: { level: number; height?: number; label: string }) {
    return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
        className="relative w-full overflow-hidden rounded-full bg-muted" style={{ height }}>
        <div className="proto-meter-fill absolute inset-0 origin-left rounded-full" style={{ transform: `scaleX(${Math.max(0.002, level)})` }} />
    </div>;
}

/** 選択の印が確定した位置へ滑るセグメント。各選択肢は同じ幅にし、印は translateX だけで動かす。 */
export function ProtoSegment<T extends string>({ options, value, onChange, label, size = 'md' }: {
    options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string; size?: 'md' | 'lg';
}) {
    const found = options.findIndex(option => option.value === value);
    const index = Math.max(0, found);
    // 選択肢にない値（一覧からだけ選べる項目など）のときは、印を出さない。
    return <div role="radiogroup" aria-label={label} data-empty={found < 0 || undefined}
        className={`proto-segment relative grid rounded-lg bg-muted p-1 ${size === 'lg' ? 'text-ui-control' : 'text-ui-support'}`}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, '--seg-count': options.length, '--seg-index': index } as CSSProperties}>
        <span aria-hidden="true" className="proto-segment-thumb" />
        {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}
            className={`relative z-[1] rounded-md px-3 font-semibold transition-colors duration-(--motion-fast) ${size === 'lg' ? 'py-2' : 'py-1.5'} ${option.value === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {option.label}
        </button>)}
    </div>;
}

export function ProtoSwitch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={`proto-switch relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-(--motion-fast) ${checked ? 'bg-primary' : 'bg-accent'}`}>
        <span className="proto-switch-knob ml-1 h-5 w-5 rounded-full bg-foreground" data-on={checked} />
    </button>;
}

/** 高さの変わる中身を、grid の行の 0fr→1fr で開閉する。中身の再配置で下の要素が跳ねない。 */
export function ProtoCollapse({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
    return <div id={id} className="proto-collapse" data-open={open} inert={!open}>
        <div className="min-h-0 overflow-hidden">{children}</div>
    </div>;
}

/** 手順の切替。key が変わるたびに、進む向きに合わせて入場させる。 */
export function ProtoStep({ stepKey, direction, axis = 'x', children }: { stepKey: string; direction: 1 | -1; axis?: 'x' | 'y'; children: ReactNode }) {
    return <div key={stepKey} className="proto-step" data-dir={direction} data-axis={axis}>{children}</div>;
}

export function ProtoHeader({ status, tone }: { status: string; tone: 'neutral' | 'live' | 'warn' }) {
    return <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
        <span className="text-lg font-bold tracking-tight">Aura<span className="text-primary">lyn</span></span>
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-ui-support font-semibold">
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone === 'live' ? 'proto-live-dot bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-muted-foreground'}`} />{status}
        </span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 text-ui-support font-bold"><MdMicOff aria-hidden="true" className="h-4 w-4" />緊急ミュート</span>
        <span className="inline-flex items-center gap-1.5 px-2 text-ui-support text-muted-foreground"><MdSettings aria-hidden="true" className="h-5 w-5" />設定</span>
        <span className="inline-flex items-center gap-1.5 px-2 text-ui-support text-muted-foreground"><MdHelpOutline aria-hidden="true" className="h-5 w-5" />ヘルプ</span>
    </header>;
}

export type Goal = 'obs' | 'call' | 'listen' | 'other';
export const goals: { value: Goal; label: string; hint: string; icon: IconType }[] = [
    { value: 'obs', label: 'OBSで配信', hint: '配信に声を乗せる', icon: MdCast },
    { value: 'call', label: '通話', hint: 'Discord などで話す', icon: MdHeadsetMic },
    { value: 'listen', label: '自分で聴く', hint: 'マイクかPCの音を聴く', icon: MdHeadphones },
    { value: 'other', label: 'その他', hint: '録音・ほかのアプリ', icon: MdTune },
];
export const micDevices = ['マイク (2)', 'マイク (1)', 'ライン入力 (USB Audio)'];
export const MicIcon = MdMic;

export type SetupStep = 'goal' | 'mic' | 'route' | 'done';
export const setupSteps: { value: SetupStep; label: string }[] = [
    { value: 'goal', label: '送り先' }, { value: 'mic', label: 'マイク' }, { value: 'route', label: '送り方' }, { value: 'done', label: '確認' },
];

/** セットアップの試作の状態。3案で同じ手順を使い、違いは見せ方だけにする。 */
export function useSetupDemo() {
    const [stepIndex, setStepIndex] = useState(0);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [goal, setGoal] = useState<Goal | null>(null);
    const [host, setHost] = useState<'wasapi' | 'asio'>('wasapi');
    const [mic, setMic] = useState<string>(micDevices[0]);
    const [route, setRoute] = useState<'plugin' | 'cable'>('plugin');
    const step = setupSteps[stepIndex].value;
    const canNext = step !== 'goal' || goal !== null;
    const go = (delta: 1 | -1) => { setDirection(delta); setStepIndex(index => Math.min(setupSteps.length - 1, Math.max(0, index + delta))); };
    const reset = () => { setDirection(-1); setStepIndex(0); setGoal(null); };
    return { step, stepIndex, direction, goal, setGoal, host, setHost, mic, setMic, route, setRoute, canNext, next: () => go(1), back: () => go(-1), reset };
}
export type SetupDemo = ReturnType<typeof useSetupDemo>;
