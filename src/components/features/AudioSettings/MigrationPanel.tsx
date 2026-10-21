import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { collectSettings, flushSession, type MigrationSummary } from '@/api/migration';

export function MigrationPanel() {
    const [summary, setSummary] = useState<MigrationSummary | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [applied, setApplied] = useState(false);
    const [message, setMessage] = useState('');
    const run = async (work: () => Promise<void>) => {
        if (busy) return;
        setBusy(true); setMessage('');
        try { await work(); } catch (error) { setMessage(String(error)); }
        finally { setBusy(false); }
    };
    const apply = async (restore: boolean) => {
        await flushSession();
        await invoke('apply_settings', { ui: collectSettings(), restore });
        setApplied(true);
        await relaunch();
    };
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">通常版・MSIX版の設定移行</h3>
        <p className="text-xs text-muted-foreground">移行元で書き出し、移行先で内容を確認して取り込みます。VST本体・ドライバー・OBSのパスワード・自動起動登録は含みません。</p>
        <div className="flex flex-wrap gap-2">
            <button disabled={busy || applied} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(async () => {
                await flushSession();
                if (await invoke('export_settings', { ui: collectSettings() })) setMessage('設定を書き出しました。移行先でこのファイルを選んでください。');
            })}>設定を書き出す</button>
            <button disabled={busy || applied} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(async () => {
                setConfirmed(false);
                setSummary(await invoke<MigrationSummary | null>('preview_settings'));
            })}>移行ファイルを確認</button>
        </div>
        {summary && <div className="space-y-2 text-sm">
            <p>作成した版: {summary.appVersion} ／設定{summary.settings.length}件・ファイル{summary.files.length}件</p>
            {summary.audio && <p className="break-all">音声: {summary.audio.host} ／入力: {summary.audio.input || '既定'} ／出力: {summary.audio.output || '既定'} ／{summary.audio.sampleRate || '既定'}Hz・{summary.audio.bufferSize || '既定'}フレーム</p>}
            {!!summary.plugins?.length && <ul className="max-h-24 overflow-auto break-all text-xs">{summary.plugins.map((plugin, i) => <li key={i}>{plugin}</li>)}</ul>}
            <ul className="max-h-32 overflow-auto break-all text-xs">{summary.files.map(file => <li key={file}>{file}</li>)}</ul>
            <p className="text-xs">同名のプロファイルと対象の表示・音声設定を置き換えます。ほかのプロファイルは保持します。</p>
        </div>}
        <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={confirmed} disabled={busy || applied} onChange={e => setConfirmed(e.target.checked)} />
            <span>現在の音声を停止して再起動することを確認しました。取り込み後は入力・出力先・VSTを確認して「保存して開始」を押すまで音声を開始しません。「移行前に戻す」は、その後の対象設定の変更も移行前へ戻します。</span>
        </label>
        <div className="flex flex-wrap gap-2">
            <button disabled={busy || applied || !confirmed || !summary} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void run(() => apply(false))}>取り込んで再起動</button>
            <button disabled={busy || applied || !confirmed} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(() => apply(true))}>移行前に戻す</button>
            {applied && <button disabled={busy} className="rounded border px-3 py-2 text-sm" onClick={() => void run(relaunch)}>再起動を再試行</button>}
        </div>
        {message && <p role="status" className="break-words text-sm">{message}</p>}
    </section>;
}
