import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { Button } from '@/components/ui/button';
import { MixingError } from './mixingUi';
import { audioApi } from '@/api/audio';
import { type InputSourceRequest, type ProcessInputCandidate } from '@/lib/inputSource';

export function ProcessInputPanel({ value, onChange, disabled, isAsio, status, onChooseConnection }: {
    value: InputSourceRequest; onChange: (value: InputSourceRequest) => void; disabled: boolean; isAsio: boolean;
    status?: { failed: boolean; waitingForAudio: boolean };
    /** ASIO で「アプリの音声」を選べない理由から、接続方式の設定へ移す（#290）。 */
    onChooseConnection?: () => void;
}) {
    const t = useMessages();
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
    return <fieldset disabled={disabled} className="space-y-3 rounded-card border border-border p-3">
        <legend className="px-1 text-ui-heading font-semibold">{t('processInput.title')}</legend>
        <Field label={t('processInput.source')}><Select  aria-describedby={isAsio && !process ? 'process-input-asio-reason' : undefined} value={process ? 'process' : 'device'} onChange={e => {
                if (e.target.value === 'device') onChange({ source: { kind: 'device', config: { purpose: value.source.config.purpose } } });
                else { onChange({ source: { kind: 'process_loopback', config: { appKey: '', appName: '', rawEndpointId: '', purpose: value.source.config.purpose } } }); void refresh(); }
            }}>
                <option value="device">{t('processInput.device')}</option>
                <option value="process" disabled={isAsio}>{t('processInput.process')}</option>
            </Select>
        </Field>
        {/* 選べない項目だけを残すと、何を変えれば選べるか分からない。理由と解除の設定への入口を並べる（#290）。 */}
        {isAsio && !process && <div className="flex flex-wrap items-center gap-2 text-ui-support text-muted-foreground">
            <p id="process-input-asio-reason">{t('processInput.asioUnavailable')}</p>
            {onChooseConnection && <Button variant="outline" size="sm" type="button" onClick={onChooseConnection}>{t('processInput.chooseConnection')}</Button>}
        </div>}
        {process && <>
            {status && <p role="status" className="text-ui-support">{t(status.failed ? 'processInput.failed' : status.waitingForAudio ? 'processInput.waiting' : 'processInput.capturing')}</p>}
            <p className="text-ui-support text-muted-foreground">{t('processInput.routeHelp')}</p>
            {isAsio && <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-ui-support text-destructive-text">{t('processInput.asio')}</p>
                {onChooseConnection && <Button variant="outline" size="sm" type="button" onClick={onChooseConnection}>{t('processInput.chooseConnection')}</Button>}
            </div>}
            <Field label={t('processInput.app')}><Select  value={selected?.id ?? ''} onChange={e => selectApp(e.target.value)}>
                    <option value="">{processConfig?.appName ? t('processInput.reselect', { name: processConfig.appName }) : t('processInput.choose')}</option>
                    {apps.map((app, i) => <option key={app.id} value={app.id}>{app.name}{apps.filter(a => a.name === app.name).length > 1 ? t('processInput.candidate', { number: i + 1 }) : ''}</option>)}
                </Select>
            </Field>
            <Button variant="outline" type="button" disabled={busy} onClick={() => void refresh()} >{t(busy ? 'processInput.loading' : 'processInput.refresh')}</Button>
            <p className="text-ui-support text-muted-foreground">{t('processInput.refreshHelp')}</p>
            {selected && <Field label={t('processInput.raw')}><Select  value={processConfig?.rawEndpointId} onChange={e => {
                    if (value.source.kind === 'process_loopback') onChange({ ...value, source: { ...value.source, config: { ...value.source.config, rawEndpointId: e.target.value } } });
                }}>
                    {!selected.routes.some(route => route.id === processConfig?.rawEndpointId) && <option value="">{t('processInput.chooseRaw')}</option>}
                    {selected.routes.map(route => <option key={route.id} value={route.id}>{route.name}（{t(route.muted ? 'processInput.muted' : 'processInput.muteNeeded')}）</option>)}
                </Select>
            </Field>}
            <MixingError error={error ? { operation: 'processInput.refresh', raw: error } : null} />
        </>}
        <details className="text-ui-support text-muted-foreground">
            <summary className="cursor-pointer">{t('processInput.cable')}</summary>
            <p className="mt-2">{t('processInput.cableHelp')}</p>
        </details>
        <Field label={t('processInput.purpose')}><Select  value={value.source.config.purpose} onChange={e => {
                const purpose = e.target.value as 'voice' | 'music';
                onChange({ ...value, source: value.source.kind === 'process_loopback'
                    ? { kind: 'process_loopback', config: { ...value.source.config, purpose } }
                    : { kind: 'device', config: { purpose } } });
            }}>
                <option value="voice">{t('processInput.voice')}</option>
                <option value="music">{t('processInput.music')}</option>
            </Select>
        </Field>
        {(process || value.source.config.purpose === 'music') && <p className="text-ui-support text-muted-foreground">{t('processInput.purposeHelp')}</p>}
    </fieldset>;
}
