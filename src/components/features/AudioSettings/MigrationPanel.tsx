import { clientErrorNotice } from '@/lib/clientError';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { collectSettings, flushSession, type MigrationSummary } from '@/api/migration';

export function MigrationPanel() {
    const t = useMessages();
    const [summary, setSummary] = useState<MigrationSummary | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [applied, setApplied] = useState(false);
    const [message, setMessage] = useState<SettingsNotice>('');
    const run = async (work: () => Promise<void>) => {
        if (busy) return;
        setBusy(true); setMessage('');
        try { await work(); } catch (error) { setMessage(clientErrorNotice(error)); }
        finally { setBusy(false); }
    };
    const apply = async (restore: boolean) => {
        await flushSession();
        await invoke('apply_settings', { ui: collectSettings(), restore });
        setApplied(true);
        await relaunch();
    };
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">{t('settings.MigrationPanel.244')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.MigrationPanel.245')}</p>
        <div className="flex flex-wrap gap-2">
            <button disabled={busy || applied} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(async () => {
                await flushSession();
                if (await invoke('export_settings', { ui: collectSettings() })) setMessage(notice('settings.MigrationPanel.246'));
            })}>{t('settings.MigrationPanel.247')}</button>
            <button disabled={busy || applied} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(async () => {
                setConfirmed(false);
                setSummary(await invoke<MigrationSummary | null>('preview_settings'));
            })}>{t('settings.MigrationPanel.248')}</button>
        </div>
        {summary && <div className="space-y-2 text-sm">
            <p>{t('settings.migration.counts', { version: summary.appVersion, settings: summary.settings.length, files: summary.files.length })}</p>
            {summary.audio && <p className="break-all">{t('settings.MigrationPanel.253')}{summary.audio.host} {t('settings.MigrationPanel.254')}{summary.audio.input || t('settings.MigrationPanel.255')} {t('settings.MigrationPanel.256')}{summary.audio.output || t('settings.MigrationPanel.257')} ／{summary.audio.sampleRate || t('settings.MigrationPanel.258')}Hz・{summary.audio.bufferSize || t('settings.MigrationPanel.259')}{t('settings.MigrationPanel.260')}</p>}
            {!!summary.plugins?.length && <ul className="max-h-24 overflow-auto break-all text-xs">{summary.plugins.map((plugin, i) => <li key={i}>{plugin}</li>)}</ul>}
            <ul className="max-h-32 overflow-auto break-all text-xs">{summary.files.map(file => <li key={file}>{file}</li>)}</ul>
            <p className="text-xs">{t('settings.MigrationPanel.261')}</p>
        </div>}
        <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" checked={confirmed} disabled={busy || applied} onChange={e => setConfirmed(e.target.checked)} />
            <span>{t('settings.MigrationPanel.262')}</span>
        </label>
        <div className="flex flex-wrap gap-2">
            <button disabled={busy || applied || !confirmed || !summary} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void run(() => apply(false))}>{t('settings.MigrationPanel.263')}</button>
            <button disabled={busy || applied || !confirmed} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(() => apply(true))}>{t('settings.MigrationPanel.264')}</button>
            {applied && <button disabled={busy} className="rounded border px-3 py-2 text-sm" onClick={() => void run(relaunch)}>{t('settings.MigrationPanel.265')}</button>}
        </div>
        {message && <p role="status" className="break-words text-sm">{renderNotice(t, message)}</p>}
    </section>;
}
