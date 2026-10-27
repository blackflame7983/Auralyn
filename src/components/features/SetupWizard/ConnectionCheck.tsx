import { preparationReach } from '@/lib/preparation';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { receiverDeviceNotice } from '../../../lib/audioRouting';
import { useObsUsage } from '../../../hooks/useObsUsage';
import React, { useEffect, useRef, useState } from 'react';
import { obsApi, type ObsAudioReachResult } from '../../../api/obs';
import { readObsEndpoint } from '../../../lib/obsConnectionPreferences';

interface ConnectionCheckProps {
    goal: 'obs' | 'discord' | 'listening' | 'other' | null;
    outputName: string;
    isBroadcast: boolean;
    disabled: boolean;
    audioRunning: boolean;
    onStartAudio: () => Promise<boolean>;
    onBusyChange: (busy: boolean) => void;
}

/** 接続先の設定は変更せず、手動手順と既存の到達確認を一つの場所にまとめる。 */
export const ConnectionCheck: React.FC<ConnectionCheckProps> = ({
    goal,
    outputName,
    isBroadcast,
    disabled,
    audioRunning,
    onStartAudio,
    onBusyChange,
}) => {
    const t = useMessages();
    const obsInUse = useObsUsage(isBroadcast && goal === 'obs');
    const [endpoint] = useState(readObsEndpoint);
    const [host, setHost] = useState(endpoint.host);
    const [port, setPort] = useState(String(endpoint.port));
    const [password, setPassword] = useState('');
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<SettingsNotice>(notice('guide.copy.256'));
    const [result, setResult] = useState<ObsAudioReachResult | null>(null);
    const operationRef = useRef(false);
    const connectionRevisionRef = useRef(0);
    const audioRevisionRef = useRef(0);
    useEffect(() => {
        if (obsInUse) return;
        connectionRevisionRef.current += 1;
        audioRevisionRef.current += 1;
        setConnected(false);
        setResult(null);
        setMessage(notice('guide.copy.257'));
    }, [obsInUse]);
    const portNumber = Number(port);
    const validConnection =
        host.trim() !== '' && /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;

    useEffect(() => {
        if (!audioRunning) {
            audioRevisionRef.current += 1;
            setResult(null);
            setMessage(notice('guide.copy.258'));
        }
    }, [audioRunning]);

    const run = async (operation: () => Promise<void>) => {
        if (operationRef.current || disabled || !obsInUse) return;
        operationRef.current = true;
        setBusy(true);
        onBusyChange(true);
        try {
            await operation();
        } finally {
            operationRef.current = false;
            setBusy(false);
            onBusyChange(false);
        }
    };

    const connect = () =>
        run(async () => {
            if (!validConnection) return;
            const revision = connectionRevisionRef.current;
            setConnected(false);
            setResult(null);
            try {
                await obsApi.connect({ host: host.trim(), port: portNumber, password });
                // 利用を終えた接続の遅い応答で、切断後の画面を接続済みに戻さない。
                if (revision !== connectionRevisionRef.current || document.hidden) return;
                setConnected(true);
                setMessage(notice('guide.copy.259'));
            } catch {
                if (revision !== connectionRevisionRef.current || document.hidden) return;
                setMessage(
                    notice('guide.copy.260'),
                );
            }
        });

    const checkReach = () =>
        run(async () => {
            const revision = audioRevisionRef.current;
            const connectionRevision = connectionRevisionRef.current;
            setResult(null);
            setMessage(notice('guide.copy.261'));
            try {
                if (!(await onStartAudio())) {
                    if (connectionRevision !== connectionRevisionRef.current || document.hidden)
                        return;
                    setMessage(notice('guide.copy.262'));
                    return;
                }
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                const next = await obsApi.checkAudioReach(1500);
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                if (revision !== audioRevisionRef.current) {
                    setMessage(notice('guide.copy.263'));
                    return;
                }
                setResult(next);
                preparationReach.record(next);
                if (next.reached === true) {
                    setMessage(
                        notice('guide.copy.264'),
                    );
                } else if (next.reached === 'unsupported') {
                    setMessage(
                        notice('guide.copy.265'),
                    );
                } else {
                    setMessage(
                        notice('guide.copy.266'),
                    );
                }
            } catch {
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                setConnected(false);
                setMessage(
                    notice('guide.copy.267'),
                );
            }
        });

    if (!isBroadcast) {
        return (
            <section
                aria-label={t('guide.copy.268')}
                className="rounded-xl border border-border p-4 space-y-2"
            >
                <h3 className="font-bold">{t('guide.copy.269')}</h3>
                <p className="text-sm">
                    {t('guide.copy.270')}{outputName}{t('guide.copy.271')}</p>
                {(goal === 'obs' || goal === 'discord') && (
                    <p className="text-sm text-warning">
                        {t('guide.copy.272')}{goal === 'obs' ? 'OBS' : 'Discord'}{' '}
                        {t('guide.copy.273')}</p>
                )}
            </section>
        );
    }

    return (
        <section
            aria-label={t('guide.copy.274')}
            className="rounded-xl border border-border p-4 space-y-4"
        >
            <h3 className="font-bold">{t('guide.copy.275')}</h3>
            <details className="space-y-3"><summary className="cursor-pointer font-medium">{t(goal === 'obs' ? 'structure.checkObs' : 'structure.checkReceiver')}</summary>

            <p className="text-sm">
                Auralyn → {outputName} →{' '}
                {renderNotice(t, receiverDeviceNotice(outputName))} → {goal === 'discord' ? 'Discord' : goal === 'obs' ? 'OBS' : t('guide.copy.276')}{' '}
                {t('guide.copy.277')}</p>
            {goal === 'obs' ? (
                <>
                    <ol className="list-decimal pl-5 text-sm space-y-2">
                        <li>
                            {t('guide.copy.278')}</li>
                        <li>
                            {t('guide.copy.279')}{renderNotice(t, receiverDeviceNotice(outputName))}{t('guide.copy.280')}</li>
                        <li>{t('guide.copy.281')}</li>
                    </ol>
                    <p className="text-sm">
                        {t('guide.copy.282')}</p>
                    <fieldset disabled={busy || disabled} className="flex flex-wrap gap-3">
                        <label className="text-sm">
                            {t('guide.copy.283')}<input
                                className="block w-40 bg-background border border-border rounded p-2"
                                value={host}
                                onChange={(e) => {
                                    setHost(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage(notice('guide.copy.284'));
                                }}
                            />
                        </label>
                        <label className="text-sm">
                            {t('guide.copy.285')}<input
                                className="block w-24 bg-background border border-border rounded p-2"
                                inputMode="numeric"
                                value={port}
                                onChange={(e) => {
                                    setPort(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage(notice('guide.copy.286'));
                                }}
                            />
                        </label>
                        <label className="text-sm">
                            {t('guide.copy.287')}<input
                                className="block w-48 bg-background border border-border rounded p-2"
                                type="password"
                                autoComplete="off"
                                value={password}
                                onChange={(e) => {
                                    setPassword(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage(
                                        notice('guide.copy.288'),
                                    );
                                }}
                            />
                        </label>
                    </fieldset>
                    <p className="text-xs text-muted-foreground">
                        {t('guide.copy.289')}</p>
                    <button
                        type="button"
                        disabled={busy || disabled || !validConnection}
                        onClick={connect}
                        className="px-4 py-2 rounded bg-secondary text-secondary-foreground disabled:opacity-50"
                    >
                        {t('guide.copy.290')}</button>
                    <p className="text-sm text-warning">
                        {t('guide.copy.291')}</p>
                    <button
                        type="button"
                        disabled={busy || disabled || !connected}
                        onClick={checkReach}
                        className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
                    >
                        {t('guide.copy.292')}</button>

                </>
            ) : (
                <>
                    <p className="text-sm">
                        {goal === 'discord'
                            ? t('guide.copy.296')
                            : t('guide.copy.297')}
                        {t('guide.copy.298')}{renderNotice(t, receiverDeviceNotice(outputName))}{t('guide.copy.299')}</p>
                    <p className="text-sm">
                        {t('guide.copy.300')}</p>
                </>
            )}
            </details>
            {goal === 'obs' ? (                    <p
                        role="status"
                        className={`text-sm ${result?.reached === true ? 'text-success' : 'text-muted-foreground'}`}
                    >
                        {audioRunning ? t('guide.copy.293') : t('guide.copy.294')}{' '}
                        {busy ? t('guide.copy.295') : renderNotice(t, message)}
                    </p>) : <p role="status" className="text-sm text-muted-foreground">{t('structure.receiverUnverified')}</p>}
        </section>
    );
};
