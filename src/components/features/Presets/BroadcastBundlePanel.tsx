import { audioApi, type PreparationSnapshot } from '@/api/audio';
import { type PreparationContext, readPreparationContext } from '@/lib/preparation';
import { formatObsText } from '@/lib/obsUiText';
import type { MessageKey } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { bundleApi, BundleClientError, type BundleFilter, type BundleOperation, type BundleObsSelection, type BundlePreview, type BundleRecovery, type BundleResult } from '../../../api/bundles';
import type { ProfileSaveCategories } from '../../../api/presets';

interface Props { checkedOnly?: boolean; onOperation?: (request: BundleOperation) => Promise<BundleResult | null>; onObsSettings?: () => void }
// バックエンドが返す保存カテゴリ名を、用語集どおりの表示名へ対応付ける。未知の名前はそのまま出す。
const planCategoryKeys: Record<string, MessageKey> = { 'VST構成': 'presets.copy.107', '入出力・音量': 'presets.copy.108', 'ノイズ低減': 'presets.copy.109', '内蔵処理': 'presets.copy.110' };
const categoryLabels: [keyof ProfileSaveCategories, MessageKey][] = [['includePlugins', 'presets.copy.107'], ['includeAudioConfig', 'presets.copy.108'], ['includeNoiseControl', 'presets.copy.109'], ['includeBuiltinFx', 'presets.copy.110']];
const categoryKeys: Record<string, MessageKey> = { plugins: 'presets.copy.113', audioConfig: 'presets.copy.114', noiseControl: 'presets.copy.115', builtinFx: 'presets.copy.116' };
type PanelMessage = { kind: 'success' | 'error'; notice: SettingsNotice; rawDetail?: string };

export function BroadcastBundlePanel({ onOperation, onObsSettings, checkedOnly = false }: Props) {
    const t = useMessages();
    const categoryName = (value: string) => Object.prototype.hasOwnProperty.call(categoryKeys, value) ? t(categoryKeys[value]) : value;
    const [checkedExpected, setCheckedExpected] = useState<PreparationSnapshot | null>(null);
    const [checkedContext, setCheckedContext] = useState<PreparationContext | null>(null);
    const [checkedAcknowledged, setCheckedAcknowledged] = useState(false);
    const list = () => checkedOnly ? bundleApi.checkedList() : bundleApi.list();
    const [names, setNames] = useState<string[]>([]);
    const [listReady, setListReady] = useState(false);
    const [name, setName] = useState('');
    const [selected, setSelected] = useState('');
    const [categories, setCategories] = useState<ProfileSaveCategories>({ includePlugins: true, includeAudioConfig: checkedOnly, includeNoiseControl: true, includeBuiltinFx: true });
    const [includeObs, setIncludeObs] = useState(false);
    const [sources, setSources] = useState<string[]>([]);
    const [obs, setObs] = useState<BundleObsSelection[]>([]);
    const [filters, setFilters] = useState<Map<string, BundleFilter[]>>(new Map());
    const [plan, setPlan] = useState<BundlePreview | null>(null);
    const [result, setResult] = useState<BundleResult | null>(null);
    const [recovery, setRecovery] = useState<BundleRecovery | null>(null);
    const [recoveryReady, setRecoveryReady] = useState(false);
    const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
    const [planIsRecovery, setPlanIsRecovery] = useState(false);
    const [message, setMessage] = useState<PanelMessage | null>(null);
    const [busy, setBusy] = useState(false);
    const [overwrite, setOverwrite] = useState(false);
    const version = useRef(0);
    const listVersion = useRef(0);
    const alive = useRef(true);
    const pending = useRef(false);
    const invalidate = () => { version.current += 1; setPlan(null); setPlanIsRecovery(false); setCheckedExpected(null); setCheckedAcknowledged(false); setOverwrite(false); };
    useEffect(() => {
        alive.current = true;
        const current = ++listVersion.current;
        void Promise.all([list(), bundleApi.history(), bundleApi.recovery()]).then(([items, history, original]) => {
            if (!alive.current || current !== listVersion.current) return;
            setNames(items); setResult(history); setRecovery(original); setRecoveryReady(true); setListReady(true);
        }).catch(() => { if (alive.current && current === listVersion.current) setMessage({ kind: 'error', notice: notice('presets.copy.117') }); });
        const subscriptions = ['audio-conditions-changed', 'audio-stopped', 'audio-stream-error', 'audio-error', 'obs://timing-invalidated'].map(event => listen(event, () => {
            if (!alive.current) return;
            version.current += 1; setPlan(null); setCheckedExpected(null); setCheckedAcknowledged(false);
            // 自分の適用通知でも変更予定は失効するが、操作結果・Undo履歴は捨てない。
        }));
        const contextChanged = () => { version.current++; setCheckedExpected(null); setCheckedContext(null); setCheckedAcknowledged(false); setPlan(null); };
        window.addEventListener('preparation-purpose-changed', contextChanged);
        window.addEventListener('preparation-external-change', contextChanged);
        const hidden = () => { if (document.hidden) { version.current += 1; setPlan(null); setCheckedExpected(null); setCheckedAcknowledged(false); } };
        document.addEventListener('visibilitychange', hidden);
        return () => {
            alive.current = false; version.current += 1; listVersion.current += 1;
            document.removeEventListener('visibilitychange', hidden);
            window.removeEventListener('preparation-purpose-changed', contextChanged);
            window.removeEventListener('preparation-external-change', contextChanged);
            subscriptions.forEach(p => { void p.then(unlisten => unlisten()).catch(() => {}); });
        };
    }, []);
    const run = async (work: () => Promise<void>) => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setMessage(null);
        try { await work(); }
        catch (error) { if (alive.current) setMessage(error instanceof BundleClientError
            ? { kind: 'error', notice: notice(error.messageKey) }
            : { kind: 'error', notice: notice('presets.copy.118'), rawDetail: typeof error === 'string' ? error : error instanceof Error ? error.message : undefined }); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
    };
    const refresh = () => run(async () => { invalidate(); setListReady(false); setRecoveryReady(false); const current = ++listVersion.current; const [items, history, original] = await Promise.all([list(), bundleApi.history(), bundleApi.recovery()]); if (alive.current && current === listVersion.current) { setNames(items); setResult(history); setRecovery(original); setRecoveryReady(true); setListReady(true); } });
    const preview = () => run(async () => {
        invalidate(); const current = version.current;
        const next = await bundleApi.preview(selected);
        if (alive.current && current === version.current) setPlan(next);
    });
    const previewRecovery = () => run(async () => {
        invalidate(); const current = version.current;
        const next = await bundleApi.recoveryPreview();
        if (alive.current && current === version.current) { setPlan(next); setPlanIsRecovery(true); }
    });
    const operate = (operation: BundleOperation) => run(async () => {
        if (!onOperation) throw new BundleClientError('presets.copy.119');
        setPlan(null);
        setRecoveryReady(false);
        try {
            const next = await onOperation(operation);
            if (alive.current && next) setResult(next);
            if (!next) throw new BundleClientError('presets.copy.120');
        } finally {
            const original = await bundleApi.recovery();
            if (alive.current) { setRecovery(original); setRecoveryReady(true); setRecoveryConfirmed(false); }
        }
    });
    const updateObs = (source: string, change: Partial<BundleObsSelection>) => { invalidate(); setObs(items => items.map(item => item.source === source ? { ...item, ...change } : item)); };
    const existingName = names.find(item => item.toLowerCase() === name.trim().toLowerCase());
    return <section aria-label={t('presets.copy.121')} className="min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
        <p>{t('presets.copy.122')}</p>
        <p className="text-xs text-muted-foreground">{t('presets.copy.123')}</p>
        <fieldset disabled={busy} className="space-y-2 border rounded p-3"><legend>{t('presets.copy.124')}</legend>
            <label className="block">{t('presets.copy.125')}<input className="block w-full border rounded bg-background p-2" value={name} onChange={e => { invalidate(); setName(e.target.value); }} maxLength={120} /></label>
            <div className="grid grid-cols-2 gap-2">{categoryLabels.map(([key, label]) => <label key={key}><input type="checkbox" disabled={checkedOnly} checked={categories[key]} onChange={e => { invalidate(); setCategories(c => ({ ...c, [key]: e.target.checked })); }} /> {t(label)}</label>)}</div>
            <p className="text-xs">{t('presets.copy.126')}</p>
            <label className="block"><input type="checkbox" checked={includeObs} disabled={checkedOnly} onChange={e => { invalidate(); setIncludeObs(e.target.checked); }} /> {t('presets.copy.127')}</label>
            {includeObs && <div className="space-y-2">
                <p className="text-xs">{t('presets.copy.128')}</p>
                {onObsSettings && <button type="button" className="border rounded p-2" onClick={onObsSettings}>{t('presets.copy.129')}</button>}
                <button type="button" className="border rounded p-2" onClick={() => void run(async () => { invalidate(); const items = await bundleApi.sources(); if (alive.current) { setSources(items); setObs([]); setFilters(new Map()); } })}>{t('presets.copy.130')}</button>
                {sources.map(source => {
                    const item = obs.find(s => s.source === source);
                    return <div key={source} className="border rounded p-2 space-y-1"><label><input type="checkbox" checked={!!item} onChange={e => { invalidate(); setObs(items => e.target.checked ? [...items, { source, volume: true, muted: true, monitor: false, filters: [] }] : items.filter(s => s.source !== source)); }} /> {source}</label>
                        {item && <div className="pl-4 space-y-1">{([['volume', 'presets.copy.131'], ['muted', 'presets.copy.132'], ['monitor', 'presets.copy.133']] as const).map(([key, label]) => <label className="mr-3" key={key}><input type="checkbox" aria-label={t('presets.copy.134', { arg0: source, arg1: t(label) })} checked={item[key]} onChange={e => updateObs(source, { [key]: e.target.checked })} /> {t(label)}</label>)}
                        <button type="button" className="block border rounded p-1" onClick={() => void run(async () => { invalidate(); const current = version.current; const choices = await bundleApi.filters(source); if (alive.current && current === version.current) { setFilters(old => new Map(old).set(source, choices)); updateObs(source, { filters: [] }); } })}>{source}{t('presets.copy.135')}</button>
                        {filters.get(source)?.length === 0 && <p className="text-xs">{t('presets.copy.136')}</p>}
                        {filters.get(source)?.map(filter => <label key={filter.name} className="block text-xs"><input type="checkbox" checked={item.filters.includes(filter.name)} onChange={e => updateObs(source, { filters: e.target.checked ? [...item.filters, filter.name] : item.filters.filter(n => n !== filter.name) })} /> {filter.name}（{filter.kind}{t('presets.copy.137')}{filter.enabled ? t('presets.copy.138') : t('presets.copy.139')}{t('presets.copy.140')}</label>)}</div>}
                    </div>;
                })}
            </div>}
            {checkedOnly && <div className="space-y-2">
                <p className="text-xs">{t('recovery.checkedScope')}</p>
                <button type="button" className="border rounded p-2" onClick={() => void run(async () => {
                    const current = version.current; const context = readPreparationContext();
                    const stats = await audioApi.getEngineRuntimeStats(); const expected = stats.preparation;
                    if (stats.latencyMetadata?.streamRunning !== true || !expected || expected.controlsPending || expected.muted || expected.outputGain === 0 || !context.usage) throw new Error(t('recovery.readFailed'));
                    if (alive.current && current === version.current) { setCheckedExpected(expected); setCheckedContext(context); setCheckedAcknowledged(false); }
                })}>{t('recovery.readConditions')}</button>
                <label className="flex gap-2"><input type="checkbox" disabled={!checkedExpected} checked={checkedAcknowledged} onChange={e => setCheckedAcknowledged(e.target.checked)} />{t('recovery.checkedAck')}</label>
            </div>}
            {existingName !== undefined && <label className="block"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> {t('presets.copy.141')}</label>}
            <button type="button" className="border rounded p-2" disabled={(checkedOnly && (!checkedExpected || !checkedAcknowledged)) || !listReady || !name.trim() || !Object.values(categories).some(Boolean) || (includeObs && obs.length === 0) || (existingName !== undefined && !overwrite)} onClick={() => void run(async () => {
                if (!listReady) return; const saveName = existingName ?? name.trim(); const confirmedOverwrite = existingName !== undefined && overwrite; if (checkedOnly && JSON.stringify(readPreparationContext()) !== JSON.stringify(checkedContext)) throw new Error(t('recovery.readFailed')); const checked = checkedOnly && checkedExpected && checkedContext ? { expected: checkedExpected, usage: checkedContext.usage, location: checkedContext.location } : undefined; invalidate(); if (checked) await bundleApi.save(saveName, categories, null, confirmedOverwrite, checked); else await bundleApi.save(saveName, categories, includeObs ? obs : null, confirmedOverwrite);
                const items = await list(); if (alive.current) { setNames(items); setMessage({ kind: 'success', notice: notice('presets.copy.142') }); }
            })}>{t('presets.copy.143')}</button>
        </fieldset>
        <fieldset disabled={busy} className="space-y-2 border rounded p-3"><legend>{t('presets.copy.144')}</legend>
            <label className="block">{t('presets.copy.145')}<select className="block w-full border rounded bg-background p-2" value={selected} onChange={e => { invalidate(); setSelected(e.target.value); }}><option value="">{t('presets.copy.146')}</option>{names.map(n => <option key={n}>{n}</option>)}</select></label>
            <button type="button" className="border rounded p-2 mr-2" onClick={() => void refresh()}>{t('presets.copy.147')}</button>
            <button type="button" className="border rounded p-2" disabled={!selected} onClick={() => void preview()}>{t('presets.copy.148')}</button>
        </fieldset>
        {recovery && <section aria-label={t('bundle.recoveryTitle')} className="space-y-2 border rounded p-3">
            <h3 className="font-semibold">{t('bundle.recoveryTitle')}</h3>
            <p>{t(recovery.readable ? 'bundle.recoveryExplanation' : 'bundle.recoveryUnreadable')}</p>
            {recovery.readable && <button type="button" className="border rounded p-2" disabled={busy} onClick={() => void previewRecovery()}>{t('bundle.recoveryPreview')}</button>}
            <label className="flex gap-2"><input type="checkbox" checked={recoveryConfirmed} onChange={e => setRecoveryConfirmed(e.target.checked)} />{t('bundle.recoveryConfirmAdopt')}</label>
            <button type="button" className="border rounded p-2 disabled:opacity-50" disabled={busy || !recoveryConfirmed} onClick={() => void run(async () => {
                await bundleApi.resolveRecovery(recovery.id);
                if (alive.current) { setRecovery(null); setResult(null); setRecoveryConfirmed(false); invalidate(); }
            })}>{t('bundle.recoveryAdopt')}</button>
        </section>}
        {plan && <div className="border rounded p-3 space-y-2" aria-label={t('presets.copy.149')}>{plan.confirmation && <p className="text-xs">{t('recovery.historical', { time: new Date(plan.confirmation.checkedAtUnixMs).toLocaleString() })}</p>}<p>{plan.name}：{plan.categories.map(name => Object.prototype.hasOwnProperty.call(planCategoryKeys, name) ? t(planCategoryKeys[name]) : name).join('・')}{t('presets.copy.150')}</p><p className="text-xs">{t('presets.copy.151')}</p>
            <table className="w-full text-xs text-left"><caption>{t('presets.copy.152')}</caption><thead><tr><th>{t('presets.copy.153')}</th><th>{t('presets.copy.154')}</th><th>{t('presets.copy.155')}</th><th>{t('presets.copy.156')}</th></tr></thead><tbody>{plan.auralyn.map((row,i) => <tr key={i}><th scope="row">{formatObsText(t, row.labelText, row.label)}</th><td className="break-all">{formatObsText(t, row.beforeText, row.before)}</td><td className="break-all">{formatObsText(t, row.afterText, row.after)}</td><td>{{same: t('presets.copy.157'), changed: t('presets.copy.158'), notSelected: t('presets.copy.159'), unknown: t('presets.copy.160')}[row.status]}</td></tr>)}</tbody></table>

            {plan.obs.length > 0 && <ul>{plan.obs.map((c,i) => <li key={i}>{c.source}：{formatObsText(t, c.labelText, c.label)} {formatObsText(t, c.beforeText, c.beforeDisplay ?? c.before)} → {formatObsText(t, c.afterText, c.afterDisplay ?? c.after)}</li>)}</ul>}
            {planIsRecovery && <p>{t('bundle.recoveryApplyHint')}</p>}
            <button type="button" className="border rounded p-2" disabled={busy || !onOperation || !recoveryReady || (!planIsRecovery && (!!recovery || !!(result?.undoPending && !result.complete)))} onClick={() => void operate({ action: planIsRecovery ? 'recovery_apply' : 'apply', id: plan.id })}>{t(planIsRecovery ? 'bundle.recoveryApply' : 'presets.copy.161')}</button></div>}
        {result && <div className="border rounded p-3 space-y-2" aria-label={t('presets.copy.162')}><p>{formatObsText(t, result.auralynText, result.auralyn)}</p>{result.summary && <ul>
            {result.summary.appliedCategories.map(category => <li key={category}>Auralyn {categoryName(category)}{t('presets.copy.163')}</li>)}
            {result.summary.skippedCategories.map(category => <li key={category}>Auralyn {categoryName(category)}{t('presets.copy.164')}</li>)}
            {result.summary.missingPlugins.map((plugin,i) => <li key={`vst-${i}`}>VST {plugin.name}{t('presets.copy.165')}</li>)}
            {result.summary.missingDevices.map((device,i) => <li key={`device-${i}`}>{t('presets.copy.166')}{device.name}{t('presets.copy.167')}</li>)}
        </ul>}{result.obs.length > 0 && <ul>{result.obs.map((message,i) => <li key={i}>OBS {i + 1}：{formatObsText(t, result.obsTexts?.length === result.obs.length ? result.obsTexts[i] : null, message)}</li>)}</ul>}<p className="text-xs">{result.complete ? t('presets.copy.168') : t('presets.copy.169')}</p>
            {result.undoPending && <button type="button" className="border rounded p-2" disabled={busy || !onOperation} onClick={() => void operate({ action: 'undo', id: result.id })}>{t('presets.copy.170')}</button>}
            <p className="text-xs">{t('presets.copy.171')}</p></div>}
        {busy && <p role="status">{t('presets.copy.172')}</p>}
        {message && <p role={message.kind === 'success' ? 'status' : 'alert'}>{renderNotice(t, message.notice)}{message.rawDetail && <span className="block break-words">{t('presets.rawDetail')}: {message.rawDetail}</span>}</p>}
    </section>;
}
