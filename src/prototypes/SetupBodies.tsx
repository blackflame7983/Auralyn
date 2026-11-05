// セットアップ各手順の中身。3案で共通にし、案ごとの違いは枠・進み方・選択の見せ方に絞る。
import type { ReactNode } from 'react';
import { MdCheck, MdExtension, MdCable, MdArrowForward, MdHeadphones } from 'react-icons/md';
import { goals, micDevices, MicIcon, ProtoMeter, ProtoSegment, useFakeLevel, type SetupDemo } from './shared';

type Look = 'card' | 'tile';

function Choice({ selected, onSelect, look, children, role = 'radio' }: { selected: boolean; onSelect: () => void; look: Look; children: ReactNode; role?: 'radio' }) {
    return <button type="button" role={role} aria-checked={selected} onClick={onSelect} data-selected={selected}
        className={`proto-choice group relative flex w-full items-center gap-3 text-left ${look === 'tile' ? 'proto-choice-tile flex-col justify-center gap-2 px-4 py-6 text-center' : 'px-4 py-3.5'}`}>
        {children}
        <span aria-hidden="true" className="proto-choice-check absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground"><MdCheck className="h-3.5 w-3.5" /></span>
    </button>;
}

export function GoalBody({ demo, look }: { demo: SetupDemo; look: Look }) {
    return <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">どこへ声を届けますか？</h2>
        <div role="radiogroup" aria-label="目的" className="grid grid-cols-2 gap-3">
            {goals.map(goal => <Choice key={goal.value} look={look} selected={demo.goal === goal.value} onSelect={() => demo.setGoal(goal.value)}>
                <span className={`proto-choice-icon grid shrink-0 place-items-center rounded-xl ${look === 'tile' ? 'h-14 w-14' : 'h-11 w-11'}`}><goal.icon aria-hidden="true" className={look === 'tile' ? 'h-8 w-8' : 'h-6 w-6'} /></span>
                <span className="min-w-0"><span className="block text-ui-control font-semibold">{goal.label}</span><span className="block text-ui-support text-muted-foreground">{goal.hint}</span></span>
            </Choice>)}
        </div>
        {demo.goal === 'listen' && <p className="text-ui-support text-muted-foreground">次の手順で、マイクとPCの音のどちらを聴くか選びます。</p>}
    </div>;
}

export function MicBody({ demo, look }: { demo: SetupDemo; look: Look }) {
    const level = useFakeLevel(true);
    const devices = demo.host === 'asio' ? ['Voicemeeter Insert Virtual ASIO', 'Focusrite USB ASIO'] : micDevices;
    return <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">使うマイクを選ぶ</h2>
            <div className="w-56"><ProtoSegment label="接続方式" value={demo.host} onChange={value => { demo.setHost(value); demo.setMic(value === 'asio' ? 'Voicemeeter Insert Virtual ASIO' : micDevices[0]); }} options={[{ value: 'wasapi', label: 'WASAPI' }, { value: 'asio', label: 'ASIO' }]} /></div>
        </div>
        <div role="radiogroup" aria-label="マイク" className={look === 'tile' ? 'grid grid-cols-3 gap-3' : 'space-y-2'}>
            {devices.map((device, index) => <Choice key={device} look={look} selected={demo.mic === device} onSelect={() => demo.setMic(device)}>
                <span className="proto-choice-icon grid h-10 w-10 shrink-0 place-items-center rounded-lg"><MicIcon aria-hidden="true" className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-ui-control font-semibold">{device}</span>{index === 0 && <span className="block text-ui-support text-muted-foreground">Windows の既定</span>}</span>
            </Choice>)}
        </div>
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-ui-support text-muted-foreground"><span>話して確かめる</span><span>{demo.mic}</span></div>
            <ProtoMeter level={level} height={12} label="入力レベル" />
        </div>
        {demo.host === 'asio' && <p className="text-ui-support text-muted-foreground">ASIO では、入力と出力が同じ機器になります。</p>}
    </div>;
}

export function RouteBody({ demo, look }: { demo: SetupDemo; look: Look }) {
    const obs = demo.goal === 'obs' || demo.goal === null;
    return <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">{obs ? 'OBSへの送り方' : '送り先'}</h2>
        <div role="radiogroup" aria-label="送り方" className="grid grid-cols-2 gap-3">
            <Choice look={look} selected={demo.route === 'plugin'} onSelect={() => demo.setRoute('plugin')}>
                <span className="proto-choice-icon grid h-11 w-11 shrink-0 place-items-center rounded-xl"><MdExtension aria-hidden="true" className="h-6 w-6" /></span>
                <span className="min-w-0"><span className="flex items-center gap-2 text-ui-control font-semibold">OBSプラグイン<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-bold text-primary">おすすめ</span></span><span className="block text-ui-support text-muted-foreground">ソース「Auralyn PCM」を追加</span></span>
            </Choice>
            <Choice look={look} selected={demo.route === 'cable'} onSelect={() => demo.setRoute('cable')}>
                <span className="proto-choice-icon grid h-11 w-11 shrink-0 place-items-center rounded-xl"><MdCable aria-hidden="true" className="h-6 w-6" /></span>
                <span className="min-w-0"><span className="block text-ui-control font-semibold">仮想ケーブル</span><span className="block text-ui-support text-muted-foreground">プラグインを使わない場合</span></span>
            </Choice>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3">
            <span className="flex items-center gap-2 text-ui-control"><MdHeadphones aria-hidden="true" className="h-5 w-5 text-muted-foreground" />自分で聴く出力先</span>
            <select className="rounded-md border border-input bg-card px-3 py-1.5 text-ui-support"><option>ヘッドホン (USB Audio)</option><option>スピーカー</option></select>
        </label>
    </div>;
}

export function DoneBody({ demo }: { demo: SetupDemo }) {
    const level = useFakeLevel(true);
    const nodes = [demo.mic, 'Auralyn', demo.route === 'plugin' ? 'Auralyn PCM' : 'CABLE Input', goals.find(goal => goal.value === demo.goal)?.label ?? 'OBSで配信'];
    return <div className="space-y-5">
        <h2 className="text-2xl font-semibold tracking-tight">準備ができました</h2>
        <ol className="flex flex-wrap items-center gap-2" aria-label="音の流れ">
            {nodes.map((node, index) => <li key={node + index} className="proto-done-node flex items-center gap-2" style={{ animationDelay: `${index * 60}ms` }}>
                <span className="rounded-lg bg-muted px-3 py-2 text-ui-support font-semibold">{node}</span>
                {index < nodes.length - 1 && <MdArrowForward aria-hidden="true" className="h-4 w-4 text-muted-foreground" />}
            </li>)}
        </ol>
        <div className="space-y-1.5"><span className="text-ui-support text-muted-foreground">いまの声</span><ProtoMeter level={level} height={12} label="入力レベル" /></div>
    </div>;
}

export function SetupBody({ demo, look }: { demo: SetupDemo; look: Look }) {
    if (demo.step === 'goal') return <GoalBody demo={demo} look={look} />;
    if (demo.step === 'mic') return <MicBody demo={demo} look={look} />;
    if (demo.step === 'route') return <RouteBody demo={demo} look={look} />;
    return <DoneBody demo={demo} />;
}
