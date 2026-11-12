// 方向G／G2 の「ホーム以外のページ」：音づくり・VST・接続・設定（OBS連携／外観／ホットキー／システム）。
// 現行の設定モーダル6区分の全項目に置き場所があるかを確かめるための試作。表示は仮のデータで、保存も適用もしない。
// 置き場所の対応は docs/verification/design-renewal-2026-11-12/settings-inventory.md。
import { useMemo, useState, type ReactNode } from 'react';
import { MdAdd, MdArrowForward, MdCheckCircle, MdDragIndicator, MdErrorOutline, MdHearing, MdKeyboard, MdOpenInNew, MdRefresh, MdTune } from 'react-icons/md';
import { useTheme } from '../../hooks/useTheme';
import { devices, drawHMeter, drawToneCurve, Range, Scope, Seg, themes, Toggle, vstSlots, type RenewalPage } from './parts';

const inBar = drawHMeter('in'); const outBar = drawHMeter('out');

export function Panel({ title, tone, note, action, children }: { title: string; tone?: 'live' | 'draft' | 'danger'; note?: string; action?: ReactNode; children: ReactNode }) {
    return <section className="oa-panel" data-tone={tone} aria-label={title}>
        <div className="flex min-h-7 items-center gap-2"><h3 className="text-ui-control font-semibold">{title}</h3>{note ? <span className="oa-badge" data-tone={tone}>{note}</span> : null}<span className="ml-auto" />{action}</div>
        {children}
    </section>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return <div className="oa-field"><span className="text-ui-control">{label}{hint ? <small>{hint}</small> : null}</span><div className="flex min-w-0 items-center justify-end gap-2">{children}</div></div>;
}
export function Select({ options, label }: { options: string[]; label: string }) { return <select aria-label={label} className="rn-select">{options.map(option => <option key={option}>{option}</option>)}</select>; }
function More({ title, summary, children }: { title: string; summary?: string; children: ReactNode }) {
    return <details className="oa-details"><summary><span>{title}</span>{summary ? <small>{summary}</small> : null}</summary><div className="flex flex-col gap-2 pt-2">{children}</div></details>;
}
function Tabs<T extends string>({ items, value, onChange, label }: { items: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
    return <nav className="oa-tabs" aria-label={label}>{items.map(item => <button key={item.value} type="button" aria-current={item.value === value ? 'page' : undefined} onClick={() => onChange(item.value)}>{item.label}</button>)}</nav>;
}
/** 画面を撮るために、開く小区分を ?tab= でも指定できるようにする。 */
function useTab<T extends string>(values: readonly T[]): [T, (value: T) => void] {
    return useState<T>(() => values.find(value => value === new URLSearchParams(location.search).get('tab')) ?? values[0]);
}
function PageHead({ title, lead, action }: { title: string; lead: string; action?: ReactNode }) {
    return <header className="oa-page-head"><div className="min-w-0"><h1>{title}</h1><p className="text-ui-support text-muted-foreground">{lead}</p></div>{action}</header>;
}

// ───────── 音づくり ─────────
const soundTabs = [{ value: 'basic', label: '基本' }, { value: 'modes', label: '歌・雑談' }, { value: 'singing', label: '歌向け' }, { value: 'guard', label: '音量の保護' }] as const;

export function SoundPage({ live }: { live: boolean }) {
    const [tab, setTab] = useTab(soundTabs.map(item => item.value));
    const [nr, setNr] = useState(true); const [strength, setStrength] = useState<'low' | 'mid' | 'high'>('mid');
    const [tone, setTone] = useState(true); const [amount, setAmount] = useState(70); const [preset, setPreset] = useState<'stream' | 'low' | 'clear'>('stream');
    const [deEss, setDeEss] = useState(false); const [deEssAmount, setDeEssAmount] = useState(50);
    const [reverb, setReverb] = useState(false); const [wet, setWet] = useState(18); const [draft, setDraft] = useState(false);
    const [guard, setGuard] = useState(false); const [truePeak, setTruePeak] = useState(false);
    const curve = useMemo(() => drawToneCurve(tone ? amount / 100 : 0), [tone, amount]);
    return <main className="oa-main oa-page">
        <PageHead title="音づくり" lead={tab === 'basic' ? '変えるとすぐ音に反映します。ホームのカードと同じ値です。' : tab === 'modes' ? 'いまの音を、歌と雑談に登録して切り替えます。' : '聴いて確かめてから適用します。適用するまで配信・通話の音は変わりません。'} />
        <Tabs items={soundTabs} value={tab} onChange={setTab} label="音づくりの種類" />
        {tab === 'basic' ? <div className="oa-cols">
            <Panel title="ノイズ低減" note="すぐ反映" action={<Toggle checked={nr} onChange={setNr} label="ノイズ低減を使う" />}>
                <Field label="強さ"><Seg label="強さ" value={strength} onChange={setStrength} options={[{ value: 'low', label: '弱' }, { value: 'mid', label: '標準' }, { value: 'high', label: '強' }]} /></Field>
                <div className="oa-note"><b>周囲の音の測定</b><span>測定済み（12分前）。いまのマイクと音量で有効です。</span><button type="button" className="rn-outline"><MdRefresh aria-hidden="true" className="h-4 w-4" />測り直す</button><small>効きやすい：空調・PCのファン　効きにくい：周囲の会話・BGM</small></div>
                <More title="詳細" summary="測定値で調整中">
                    <Field label="下げる量" hint="大きいほど静かに、声は変わりやすく"><Range value={62} onChange={() => undefined} label="下げる量" className="min-w-0 flex-1" /><span className="rn-mono text-ui-support">62%</span></Field>
                    <Field label="声の始まりを守る"><Toggle checked onChange={() => undefined} label="声の始まりを守る" /></Field>
                </More>
            </Panel>
            <Panel title="声を整える" note="すぐ反映" action={<Toggle checked={tone} onChange={setTone} label="声を整える機能を使う" />}>
                <Scope draw={curve} label="音色の形" className="h-20 w-full" />
                <Field label="声の種類"><Seg label="声の種類" value={preset} onChange={setPreset} options={[{ value: 'stream', label: '配信' }, { value: 'low', label: '低め' }, { value: 'clear', label: '明瞭' }]} /></Field>
                <Field label="整え具合"><Range value={amount} onChange={setAmount} label="声の整え具合" className="min-w-0 flex-1" /><span className="rn-mono w-10 text-right text-ui-support">{amount}%</span></Field>
                <Field label="サ行の刺さりを抑える" hint="強すぎると子音がこもります"><Toggle checked={deEss} onChange={setDeEss} label="サ行の刺さりを抑える" /></Field>
                {deEss ? <Field label="抑える量"><Range value={deEssAmount} onChange={setDeEssAmount} label="抑える量" className="min-w-0 flex-1" /><span className="rn-mono w-10 text-right text-ui-support">{deEssAmount}%</span></Field> : null}
            </Panel>
        </div> : tab === 'modes' ? <div className="flex flex-col gap-4">
            {[{ name: '歌モード', detail: '声を整える：明瞭 80%・残響 ON', vst: 'TDR Nova・LoudMax' }, { name: '雑談モード', detail: '声を整える：配信 70%・残響 OFF', vst: '内蔵設定のみ' }].map((mode, index) => <Panel key={mode.name} title={mode.name} note={index ? 'いま使用中' : '登録済み'} tone={index ? 'live' : undefined}
                action={<button type="button" className="rn-outline">いまの音を登録</button>}>
                <p className="text-ui-support text-muted-foreground">{mode.detail}</p>
                <Field label="一緒に切り替えるVST"><Select label={`${mode.name}と一緒に切り替えるVST`} options={[mode.vst, '内蔵設定のみ', 'すべてのVST']} /></Field>
            </Panel>)}
            <p className="text-ui-support text-muted-foreground">切り替えは、上の帯の「雑談／歌」か、ホットキーで行います。</p>
        </div> : tab === 'singing' ? <div className="oa-cols">
            <Panel title="残響を加える" tone={draft ? 'draft' : undefined} note={draft ? '未適用の変更' : '適用済み：OFF'} action={<Toggle checked={reverb} onChange={value => { setReverb(value); setDraft(true); }} label="残響を有効にする" />}>
                <Field label="響きの量"><Range value={wet} onChange={value => { setWet(value); setDraft(true); }} label="響きの量" className="min-w-0 flex-1" /><span className="rn-mono w-10 text-right text-ui-support">{wet}%</span></Field>
                <More title="数値を細かく調整"><Field label="残響の長さ（秒）"><input className="rn-input w-20" type="number" defaultValue={1.4} step={0.1} aria-label="残響の長さ（秒）" /></Field><Field label="高域の減衰（%）"><input className="rn-input w-20" type="number" defaultValue={40} aria-label="高域の減衰（%）" /></Field></More>
            </Panel>
            <Panel title="聴いて確かめてから適用" tone={draft ? 'draft' : undefined}>
                <p className="text-ui-support text-muted-foreground">{draft ? '変更は、まだ配信・通話の音に反映していません。' : '変更はありません。残響を調整すると、ここで試聴できます。'}</p>
                <button type="button" className="rn-outline justify-center" disabled={!draft}><MdHearing aria-hidden="true" className="h-4 w-4" />試しに聴く</button>
                <button type="button" className="rn-primary justify-center" disabled={!draft || !live} onClick={() => setDraft(false)}>この音をマイクへ適用</button>
                <div className="flex gap-2"><button type="button" className="rn-ghost" disabled={!draft} onClick={() => setDraft(false)}>下書きを戻す</button><button type="button" className="rn-ghost" disabled>直前の適用を戻す</button></div>
                <button type="button" className="rn-ghost justify-start">歌向けの音から始める</button>
            </Panel>
        </div> : <div className="oa-cols">
            <Panel title="大きな音を抑える" note={guard ? 'ON' : 'OFF（既定）'} action={<Toggle checked={guard} onChange={setGuard} label="大きな音を抑える" />}>
                <p className="text-ui-support text-muted-foreground">出力音量の後で、急に大きくなった音を抑えます。音割れを必ず防ぐものではありません。</p>
                <Field label="天井（dBFS）"><input className="rn-input w-20" type="number" defaultValue={-1} step={0.5} aria-label="天井（dBFS）" /></Field>
                <Field label="復帰時間（ms）"><input className="rn-input w-20" type="number" defaultValue={120} aria-label="復帰時間（ms）" /></Field>
                <Field label="直近で抑えた量"><span className="rn-mono text-ui-support">0.0 dB</span></Field>
                <More title="保護の範囲と設定の寿命"><p className="text-ui-support text-muted-foreground">アプリを再起動すると OFF に戻ります。プロファイルと歌・雑談には保存しません。</p></More>
            </Panel>
            <Panel title="配信用の最終リミッター" note={truePeak ? 'ON' : 'OFF（既定）'} action={<Toggle checked={truePeak} onChange={setTruePeak} label="配信用の最終リミッターを使う" />}>
                <p className="text-ui-support text-muted-foreground">自分用と配信用に分けているときだけ、配信用の最後で働きます。ON にすると配信用が約1.2 ms 遅れます。</p>
                <Field label="天井（dBFS）"><input className="rn-input w-20" type="number" defaultValue={-1} step={0.5} aria-label="配信用の天井（dBFS）" /></Field>
                <Field label="復帰時間（ms）"><input className="rn-input w-20" type="number" defaultValue={120} aria-label="配信用の復帰時間（ms）" /></Field>
                <More title="先読みと設定の寿命"><p className="text-ui-support text-muted-foreground">切り替えの間、短い無音が入ります。アプリを再起動すると OFF に戻ります。</p></More>
            </Panel>
        </div>}
    </main>;
}

// ───────── VST ─────────
export function VstPage({ live, music }: { live: boolean; music: boolean }) {
    const [on, setOn] = useState([true, true, false]); const [selected, setSelected] = useState(0);
    const before = music ? ['再生元'] : ['マイク', 'ノイズ低減', '声を整える'];
    return <main className="oa-main oa-page">
        <PageHead title="VST" lead="上から順に音が通ります。入れ替えは、音を止めずにできます。" action={<button type="button" className="rn-primary"><MdAdd aria-hidden="true" className="h-5 w-5" />VSTを追加</button>} />
        <ol className="oa-flow" aria-label="音が通る順">{[...before, ...vstSlots.map(slot => slot.name), '出力'].map((name, index, list) => <li key={name} data-vst={index >= before.length && index < list.length - 1 || undefined} data-off={index >= before.length && index < list.length - 1 && !on[index - before.length] || undefined}>{name}</li>)}</ol>
        <div className="oa-cols oa-cols-wide">
            <ul className="oa-rack" aria-label="VSTの並び">{vstSlots.map((slot, index) => <li key={slot.name} data-on={on[index]} data-selected={selected === index || undefined}>
                <button type="button" className="oa-rack-grip" aria-label={`${slot.name}の順番を変える`}><MdDragIndicator aria-hidden="true" className="h-5 w-5" /></button>
                <span className="rn-mono oa-rack-no">{index + 1}</span>
                <button type="button" className="oa-rack-name" onClick={() => setSelected(index)} aria-pressed={selected === index}><b>{slot.name}</b><small>{slot.kind}・{slot.maker}</small></button>
                <span className="oa-rack-state">{!on[index] ? 'OFF' : live ? '処理中' : '待機'}</span>
                <button type="button" className="rn-outline" aria-label={`${slot.name}の画面を開く`}><MdOpenInNew aria-hidden="true" className="h-4 w-4" /><span className="oa-wide-only" aria-hidden="true">画面を開く</span></button>
                <Toggle checked={on[index]} onChange={value => setOn(list => list.map((item, i) => i === index ? value : item))} label={`${slot.name}を使う`} />
            </li>)}
                <li className="oa-rack-add"><button type="button" className="rn-ghost"><MdAdd aria-hidden="true" className="h-4 w-4" />ここにVSTを追加</button></li>
            </ul>
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title={vstSlots[selected].name} note={vstSlots[selected].kind}>
                    <Field label="申告された遅延"><span className="rn-mono text-ui-support">{selected === 2 ? '1.3 ms' : '0 ms'}</span></Field>
                    <div className="flex flex-wrap gap-2"><button type="button" className="rn-outline">上へ</button><button type="button" className="rn-outline">下へ</button><button type="button" className="rn-ghost">外す</button></div>
                </Panel>
                <Panel title="プリセット">
                    <Field label="VSTの並びと設定"><Select label="VSTプリセット" options={['配信用（標準）', '歌枠', '通話']} /></Field>
                    <div className="flex flex-wrap gap-2"><button type="button" className="rn-outline">保存</button><button type="button" className="rn-ghost">テンプレートから作る</button></div>
                </Panel>
            </div>
        </div>
    </main>;
}

// ───────── 接続（現行の設定「オーディオ」） ─────────
export function ConnectPage({ live }: { live: boolean }) {
    const [host, setHost] = useState<'wasapi' | 'asio'>('wasapi'); const [stability, setStability] = useState<'fast' | 'std' | 'safe'>('std'); const [rate, setRate] = useState<'48' | '44'>('48');
    const [mic, setMic] = useState(devices.mic); const [split, setSplit] = useState(false); const [mixHome, setMixHome] = useState(false);
    const changed = mic !== devices.mic || split;
    return <main className="oa-main oa-page">
        <PageHead title="接続" lead="音が通る道を決めます。変えた内容は、保存するまで反映しません。" action={<button type="button" className="rn-outline"><MdRefresh aria-hidden="true" className="h-4 w-4" />機器を再検出</button>} />
        <div className="oa-cols oa-cols-save">
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title="入力">
                    <Field label="入力元"><Select label="入力元" options={['マイク・仮想ケーブル', 'アプリの音声']} /></Field>
                    <Field label="入力の用途"><Select label="入力の用途" options={['声（ノイズ低減を使う）', '音楽（声向けの処理は省略）']} /></Field>
                    <Field label="マイク"><select aria-label="マイク" className="rn-select" value={mic} onChange={event => setMic(event.target.value)}>{[devices.mic, 'マイク (USB Audio)'].map(name => <option key={name}>{name}</option>)}</select></Field>
                    <More title="仮想ケーブルを使う場合・マイクの許可"><p className="text-ui-support text-muted-foreground">入力を開始できないときは、Windows のマイクの許可を確認します。</p><button type="button" className="rn-outline self-start">Windowsのマイク設定を開く</button></More>
                </Panel>
                <Panel title="出力" action={<span className="text-ui-support text-muted-foreground">送り先：{devices.dest}</span>}>
                    <Field label="出力先"><Select label="出力先" options={[devices.out, 'CABLE Input']} /></Field>
                    <Field label="自分用と配信用に分ける" hint="ヘッドホンとOBSへ同時に送ります"><Toggle checked={split} onChange={setSplit} label="自分用と配信用に分ける" /></Field>
                    {split ? <Field label="配信用の出力先"><Select label="配信用の出力先" options={['CABLE Input', 'VoiceMeeter Input']} /></Field> : null}
                    <Field label="配信ミックスをホームに出す" hint="オケと声を混ぜて配信へ送ります"><Toggle checked={mixHome} onChange={setMixHome} label="配信ミックスをホームに出す" /></Field>
                </Panel>
                <Panel title="接続方式と音切れ" note={`${host.toUpperCase()}・${stability === 'std' ? '標準' : stability === 'fast' ? '遅延を少なく' : '途切れにくく'}・${rate === '48' ? '48 kHz' : '44.1 kHz'}`}>
                    <Field label="接続方式"><Seg label="接続方式" value={host} onChange={setHost} options={[{ value: 'wasapi', label: 'WASAPI' }, { value: 'asio', label: 'ASIO' }]} /></Field>
                    <Field label="音の途切れにくさ"><Seg label="音の途切れにくさ" value={stability} onChange={setStability} options={[{ value: 'fast', label: '遅延を少なく' }, { value: 'std', label: '標準' }, { value: 'safe', label: '途切れにくく' }]} /></Field>
                    <Field label="周波数" hint="ほかのアプリと合わせる"><Seg label="周波数" value={rate} onChange={setRate} options={[{ value: '48', label: '48 kHz' }, { value: '44', label: '44.1 kHz' }]} /></Field>
                    <More title="数値で指定・歌いながら聴く設定"><Field label="バッファ（サンプル）"><input className="rn-input w-24" type="number" defaultValue={480} aria-label="バッファ（サンプル）" /></Field><button type="button" className="rn-outline self-start">いまの設定から候補を作る</button></More>
                </Panel>
                <Panel title="入出力プリセット">
                    <Field label="保存済み"><Select label="入出力プリセット" options={['選択してください', '自宅（配信）', '通話']} /></Field>
                    <Field label="保存する名前"><input className="rn-input min-w-0 flex-1" type="text" placeholder="例：自宅（配信）" aria-label="保存する名前" /><button type="button" className="rn-outline" disabled>保存</button></Field>
                </Panel>
            </div>
            <Panel title={changed ? '変更の内容' : 'いまの接続'} tone={changed ? 'draft' : 'live'}>
                <div className="oa-now"><small>マイク</small><b>{mic}</b>{changed ? null : <Scope draw={inBar} label="入力レベル" className="h-4 w-full" />}</div>
                <div className="oa-now"><small>出力先</small><b>{devices.out}</b>{changed ? null : <Scope draw={outBar} label="出力レベル" className="h-4 w-full" />}</div>
                {split ? <div className="oa-now"><small>配信用</small><b>CABLE Input</b></div> : null}
                <div className="oa-now oa-now-dest"><small>送り先</small><b>{devices.dest}</b></div>
                <p className="text-ui-support text-muted-foreground">{changed ? '保存すると、音が一瞬途切れます。' : live ? '変更はありません。' : '音は止まっています。'}</p>
                <button type="button" className="rn-primary w-full justify-center" disabled={!changed}>保存して{live ? '再起動' : '開始'}</button>
                {changed ? <button type="button" className="rn-ghost justify-center" onClick={() => { setMic(devices.mic); setSplit(false); }}>変更を取り消す</button> : <button type="button" className="rn-ghost justify-center">送り先で音を確認</button>}
            </Panel>
        </div>
    </main>;
}

// ───────── 設定（OBS連携／外観／ホットキー／システム） ─────────
const settingTabs = [{ value: 'appearance', label: '外観' }, { value: 'keys', label: 'ホットキー' }, { value: 'obs', label: 'OBS連携' }, { value: 'system', label: 'システム' }] as const;
type SettingTab = typeof settingTabs[number]['value'];
const hotkeys = [
    { group: 'よく使う操作', items: [['緊急ミュート（切替）', 'Ctrl + Alt + M'], ['VSTを外して比較（切替）', 'Ctrl + Alt + B'], ['歌モード', ''], ['雑談モード', '']] },
    { group: 'その他の操作', items: [['緊急ミュート（オン）', ''], ['緊急ミュート（解除）', ''], ['VSTを外して比較（開始）', ''], ['VSTを外して比較（終了）', ''], ['出力音量を1%上げる', ''], ['出力音量を1%下げる', ''], ['ノイズ低減を切り替える', '']] },
] as const;

export function SettingsPage({ tab, onPage }: { tab: SettingTab; onPage: (page: RenewalPage) => void }) {
    const { theme, setTheme } = useTheme();
    const [aurora, setAurora] = useState(true); const [detail, setDetail] = useState(false);
    const [autostart, setAutostart] = useState(false); const [connected, setConnected] = useState(false); const [link, setLink] = useState(false);
    return <main className="oa-main oa-page">
        <PageHead title="設定" lead={tab === 'obs' ? 'OBS を Auralyn から確認・操作するための連携です。音の通り道は「接続」で決めます。' : tab === 'appearance' ? '表示の変更は、すぐに反映します。' : tab === 'keys' ? 'ほかのアプリを使っていても効くキーです。保存すると有効になります。' : 'アプリの動作と、設定の管理です。'} />
        <Tabs items={settingTabs} value={tab} onChange={onPage} label="設定の種類" />
        {tab === 'obs' ? <div className="oa-cols">
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title="OBSとの接続" tone={connected ? 'live' : undefined} note={connected ? '接続中' : '未接続'}>
                    <Field label="ホスト名"><input className="rn-input min-w-0 flex-1" type="text" defaultValue="localhost" aria-label="OBSホスト名" /></Field>
                    <Field label="ポート"><input className="rn-input w-24" type="number" defaultValue={4455} aria-label="OBSポート" /></Field>
                    <Field label="パスワード"><input className="rn-input min-w-0 flex-1" type="password" aria-label="OBSパスワード" autoComplete="off" /></Field>
                    <button type="button" className="rn-primary self-start" onClick={() => setConnected(value => !value)}>{connected ? '切断' : '接続'}</button>
                    <More title="OBS側の準備"><p className="text-ui-support text-muted-foreground">OBS 28 以降の「ツール → WebSocketサーバー設定」を有効にします。</p></More>
                </Panel>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title="OBSの設定を確認・変更">
                    <p className="text-ui-support text-muted-foreground">{connected ? '配信・録画を止めてから適用します。変更の前に、内容を一覧で確認できます。' : 'OBS に接続すると使えます。'}</p>
                    <div className="flex flex-wrap gap-2"><button type="button" className="rn-outline" disabled={!connected}>変更予定を確認する</button><button type="button" className="rn-ghost">連携ガイド</button></div>
                    <More title="過去の変更履歴"><p className="text-ui-support text-muted-foreground">履歴はアプリを終了するまで残ります。</p><button type="button" className="rn-outline self-start">履歴を再取得</button></More>
                </Panel>
                <Panel title="シーンの連動" action={<Toggle checked={link} onChange={setLink} label="シーンの連動を有効にする" />}>
                    <Field label="連動のしかた"><Select label="OBSシーンの連動方式" options={['歌・雑談モードへ切り替える', '同名プリセットを読む（VSTを読み直す）', '連動なし']} /></Field>
                    <button type="button" className="rn-outline self-start" disabled={!link}>連動の設定を保存</button>
                </Panel>
            </div>
        </div> : tab === 'appearance' ? <div className="flex flex-col gap-4">
            <Panel title="テーマ"><div className="grid grid-cols-3 gap-3">
                {themes.map(item => <button key={item.value} type="button" aria-pressed={theme === item.value} onClick={() => setTheme(item.value as 'dark' | 'light' | 'gaming')} className="rn-theme">
                    <span data-theme-preview={item.value} className="rn-theme-preview"><i /><i /><i /><b /></span>
                    <span className="text-ui-control font-semibold">{item.label}</span><span className="text-ui-support text-muted-foreground">{item.hint}</span>
                </button>)}
            </div></Panel>
            <Panel title="表示">
                <Field label="ホームの表示" hint="音声の設定と送り先は変わりません"><Select label="ホームの表示" options={['配信・通話向け', '音楽鑑賞向け']} /></Field>
                <Field label="表示言語"><Select label="表示言語" options={['日本語', 'English']} /></Field>
                <Field label="数値の詳細を表示" hint="遅延・dBFS・ノイズ低減の強さ（%）"><Toggle checked={detail} onChange={setDetail} label="数値の詳細を表示" /></Field>
                <Field label="音の流れに色を付ける" hint="動きを減らす設定では静止します"><Toggle checked={aurora} onChange={setAurora} label="音の流れに色を付ける" /></Field>
            </Panel>
        </div> : tab === 'keys' ? <div className="flex min-h-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2"><button type="button" className="rn-outline"><MdKeyboard aria-hidden="true" className="h-4 w-4" />推奨のキーをまとめて入力</button><span className="text-ui-support text-muted-foreground">Stream Deck の System → Hotkey でも使えます。</span></div>
            {hotkeys.map(section => <Panel key={section.group} title={section.group}>
                <ul className="oa-keys">{section.items.map(([name, key]) => <li key={name}><span className="min-w-0 flex-1 truncate text-ui-control">{name}</span>
                    {key ? <kbd>{key}</kbd> : <span className="text-ui-support text-muted-foreground">未設定</span>}
                    <button type="button" className="rn-outline" aria-label={`${name}のキーを入力`}>キーを入力</button><button type="button" className="rn-ghost oa-wide-only" aria-label={`${name}のキーを一覧から選ぶ`}>一覧</button></li>)}</ul>
            </Panel>)}
            <div className="oa-savebar"><span className="text-ui-support text-muted-foreground">変更はありません。</span><span className="ml-auto" /><button type="button" className="rn-ghost" disabled>取り消す</button><button type="button" className="rn-primary" disabled>キー設定を保存</button></div>
        </div> : <div className="oa-cols">
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title="起動と更新">
                    <Field label="Windows起動時に自動実行" hint="保存済みの設定があると音声処理も始まります"><Toggle checked={autostart} onChange={setAutostart} label="Windows起動時に自動実行" /></Field>
                    <Field label="更新を自動で確認"><Toggle checked onChange={() => undefined} label="更新を自動で確認" /></Field>
                    <Field label="更新を自動でダウンロード"><Toggle checked={false} onChange={() => undefined} label="更新を自動でダウンロード" /></Field>
                </Panel>
                <Panel title="やり直す">
                    <Field label="セットアップ" hint="マイクと出力先を選び直します"><button type="button" className="rn-outline" onClick={() => onPage('connect')}>開く<MdArrowForward aria-hidden="true" className="h-4 w-4" /></button></Field>
                    <Field label="音声処理の再起動" hint="再起動中は音が途切れます"><button type="button" className="rn-outline"><MdRefresh aria-hidden="true" className="h-4 w-4" />再起動</button></Field>
                    <Field label="読み込みを止めたVST" hint="次のスキャンで確認し直します"><button type="button" className="rn-outline">リセット</button></Field>
                </Panel>
                <Panel title="上級者向け">
                    <More title="音声処理の設定" summary="通常は変更不要"><Field label="CPUアフィニティ固定"><Toggle checked={false} onChange={() => undefined} label="CPUアフィニティ固定" /></Field><Field label="リアルタイム優先度（危険）"><Toggle checked={false} onChange={() => undefined} label="リアルタイム優先度" /></Field><Field label="時間最優先オーディオスレッド（危険）"><Toggle checked={false} onChange={() => undefined} label="時間最優先オーディオスレッド" /></Field><button type="button" className="rn-outline self-start">処理設定を登録</button></More>
                    <More title="診断情報" summary="稼働統計・遅延の内訳・往復遅延の測定"><p className="text-ui-support text-muted-foreground">表の数が多いため、別の画面で開きます。</p><button type="button" className="rn-outline self-start"><MdTune aria-hidden="true" className="h-4 w-4" />診断情報を開く</button></More>
                </Panel>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
                <Panel title="設定の移行">
                    <p className="text-ui-support text-muted-foreground">通常版と MSIX 版の間で設定を移します。VST 本体と OBS のパスワードは含みません。</p>
                    <div className="flex flex-wrap gap-2"><button type="button" className="rn-outline">設定を書き出す</button><button type="button" className="rn-outline">移行ファイルを確認</button></div>
                </Panel>
                <Panel title="データリセット" tone="danger">
                    <p className="text-ui-support text-muted-foreground">オーディオ設定、プリセット、外観などを初期状態に戻します。元に戻せません。</p>
                    <button type="button" className="rn-danger self-start"><MdErrorOutline aria-hidden="true" className="h-4 w-4" />すべて初期化</button>
                </Panel>
                <Panel title="Auralyn" note="バージョン 1.1.0">
                    <p className="flex items-center gap-1.5 text-ui-support text-muted-foreground"><MdCheckCircle aria-hidden="true" className="h-4 w-4" />最新版です。</p>
                    <div className="flex flex-wrap gap-2"><button type="button" className="rn-ghost">公式サイト</button><button type="button" className="rn-ghost">アプリ情報 / ライセンス</button><button type="button" className="rn-ghost">開発を支援</button></div>
                </Panel>
            </div>
        </div>}
    </main>;
}
