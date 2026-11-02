import { useEffect, useRef, useState } from 'react';
import { audioApi } from '@/api/audio';
import { type InputSourceRequest, type ProcessInputCandidate } from '@/lib/inputSource';

export function ProcessInputPanel({ value, onChange, disabled, isAsio, status }: {
    value: InputSourceRequest; onChange: (value: InputSourceRequest) => void; disabled: boolean; isAsio: boolean;
    status?: { failed: boolean; waitingForAudio: boolean };
}) {
    const [apps, setApps] = useState<ProcessInputCandidate[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const revision = useRef(0);
    const latest = useRef(value); latest.current = value;
    useEffect(() => () => { revision.current++; }, []);
    const refresh = async () => {
        const request = ++revision.current;
        setBusy(true); setError('');
        try {
            const result = await audioApi.processInputSources();
            if (request !== revision.current) return;
            setApps(result);
            const current = latest.current;
            if (current.candidateId && current.source.kind === 'process_loopback') {
                const config = current.source.config;
                const selected = result.find(app => app.id === current.candidateId && app.appKey === config.appKey);
                if (!selected) onChange({ source: current.source });
                else if (!selected.routes.some(route => route.id === config.rawEndpointId)) {
                    onChange({ ...current, source: { ...current.source, config: { ...current.source.config, rawEndpointId: '' } } });
                }
            }
        } catch (e) { if (request === revision.current) setError(String(e)); }
        finally { if (request === revision.current) setBusy(false); }
    };
    const processConfig = value.source.kind === 'process_loopback' ? value.source.config : undefined;
    const process = !!processConfig;
    const selected = apps.find(app => app.id === value.candidateId);
    const selectApp = (id: string) => {
        const app = apps.find(app => app.id === id);
        if (!app) return;
        onChange({ source: { kind: 'process_loopback', config: { appKey: app.appKey, appName: app.name,
            rawEndpointId: app.routes[0]?.id ?? '', purpose: value.source.config.purpose } }, candidateId: id });
    };
    const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
    return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">入力元と用途</legend>
        <label className="block text-sm">入力元
            <select className={field} value={process ? 'process' : 'device'} onChange={e => {
                if (e.target.value === 'device') onChange({ source: { kind: 'device', config: { purpose: value.source.config.purpose } } });
                else { onChange({ source: { kind: 'process_loopback', config: { appKey: '', appName: '', rawEndpointId: '', purpose: value.source.config.purpose } } }); void refresh(); }
            }}>
                <option value="device">マイク・仮想ケーブル</option>
                <option value="process" disabled={isAsio}>アプリの音声（WASAPI）</option>
            </select>
        </label>
        {process && <>
            {status && <p role="status" className="text-sm">{status.failed ? 'アプリ音声の取得が停止しています。入力を選び直してください。' : status.waitingForAudio ? 'アプリの音声を待っています。' : 'アプリ音声を取得しています。'}</p>}
            <p className="text-xs text-muted-foreground">再生アプリを別の出力先へ送り、その出力先をWindowsでミュートしてください。アプリ自体をミュートすると取得音も消えます。別の出力先を用意できない場合は仮想ケーブルを使ってください。</p>
            {isAsio && <p role="alert" className="text-sm text-destructive">アプリ入力を使うにはWASAPIを選んでください。</p>}
            <label className="block text-sm">再生中のアプリ
                <select className={field} value={selected?.id ?? ''} onChange={e => selectApp(e.target.value)}>
                    <option value="">{processConfig?.appName ? `${processConfig?.appName} を選び直す` : 'アプリを選択'}</option>
                    {apps.map((app, i) => <option key={app.id} value={app.id}>{app.name}{apps.filter(a => a.name === app.name).length > 1 ? `（候補 ${i + 1}）` : ''}</option>)}
                </select>
            </label>
            <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-md border border-input px-3 py-2 text-sm">{busy ? '取得中…' : 'アプリ一覧を更新'}</button>
            <p className="text-xs text-muted-foreground">音声を再生してから一覧を更新してください。選択したアプリとその子プロセスが対象です。Chromeのタブ単位では選べません。</p>
            {selected && <label className="block text-sm">原音の出力先
                <select className={field} value={processConfig?.rawEndpointId} onChange={e => {
                    if (value.source.kind === 'process_loopback') onChange({ ...value, source: { ...value.source, config: { ...value.source.config, rawEndpointId: e.target.value } } });
                }}>
                    {!selected.routes.some(route => route.id === processConfig?.rawEndpointId) && <option value="">原音の出力先を選択</option>}
                    {selected.routes.map(route => <option key={route.id} value={route.id}>{route.name}（{route.muted ? 'ミュート済み' : 'ミュートが必要'}）</option>)}
                </select>
            </label>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </>}
        <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">仮想ケーブルを使う場合の接続</summary>
            <p className="mt-2">「マイク・仮想ケーブル」を選び、再生アプリの出力をケーブルの再生側へ、Auralynの入力をケーブルの録音側へ設定します。VB-CABLEでは、それぞれCABLE InputとCABLE Outputです。未導入の場合は先に仮想ケーブルの準備が必要です。加工後の出力を同じ入力ケーブルへ戻すと音が循環するため、返し用の別機器を選んでください。</p>
        </details>
        <label className="block text-sm">入力の用途
            <select className={field} value={value.source.config.purpose} onChange={e => {
                const purpose = e.target.value as 'voice' | 'music';
                onChange({ ...value, source: value.source.kind === 'process_loopback'
                    ? { kind: 'process_loopback', config: { ...value.source.config, purpose } }
                    : { kind: 'device', config: { purpose } } });
            }}>
                <option value="voice">声（ノイズ低減・ノイズ学習を使用）</option>
                <option value="music">音楽（VSTを使用、声向けの処理は省略）</option>
            </select>
        </label>
        <p className="text-xs text-muted-foreground">入力元や用途を変えるときは、音声を停止してから適用してください。原音との比較には同じ返し経路を使います。VSTのバイパスはVSTだけが対象で、声のノイズ低減は音作りの設定で切り替えます。</p>
    </fieldset>;
}
