import { formatObsText, obsHistoryResults, originalObsText } from '@/lib/obsUiText';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useId, useRef, useState } from 'react';
import { obsApi, type ObsSetupPlan, type ObsSetupHistory } from '@/api/obs';



export function ObsSafeSetup({
    connected = true,
    disabled,
    onBusyChange,
    onOpenGuide,
}: {
    connected?: boolean;
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onOpenGuide?: () => void;
}) {
    const t = useMessages();
    const reasonId = useId();
    const [plan, setPlan] = useState<ObsSetupPlan | null>(null);
    const [history, setHistory] = useState<ObsSetupHistory[]>([]);
    const [busy, setBusy] = useState(false);
    const unavailableReason = busy ? t('settings.obs.operationBusy') : !connected ? t('settings.obs.connectionRequired') : disabled ? t('settings.obs.operationBusy') : null;
    const [forgetting, setForgetting] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef(false);
    const historyRevision = useRef(0);
    const historyDetails = useRef<HTMLDetailsElement>(null);
    const revealHistory = () => {
        const details = historyDetails.current;
        if (!details) return;
        details.open = true;
        details.querySelector('summary')?.focus();
        details.scrollIntoView?.({ block: 'nearest' });
    };
    useEffect(() => {
        let active = true;
        const revision = ++historyRevision.current;
        setPlan(null);
        obsApi
            .setupHistory()
            .then((items) => {
                if (active && revision === historyRevision.current) setHistory(items);
            })
            .catch((e) => {
                if (active && revision === historyRevision.current) setError(String(e));
            });
        return () => {
            active = false;
        };
    }, [connected]);
    useEffect(() => {
        onBusyChange(busy);
        return () => onBusyChange(false);
    }, [busy, onBusyChange]);
    const run = async (action: () => Promise<void>, requiresConnection = true) => {
        if (inFlight.current || (requiresConnection && disabled)) return;
        inFlight.current = true;
        historyRevision.current += 1;
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(String(e));
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };
    const preview = (source?: string) =>
        run(async () => {
            setPlan(null);
            setPlan(await obsApi.previewSetup(source));
        });
    const buttonClass = 'rounded border border-border px-3 py-2 hover:bg-muted disabled:opacity-50';
    return (
        <section aria-label={t('settings.ObsSafeSetup.335')} className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
                {t('settings.ObsSafeSetup.336')}</p>
            <div className="flex flex-wrap gap-2">
            <button
                type="button"
                className={buttonClass}
                disabled={busy || disabled}
                aria-describedby={unavailableReason ? reasonId : undefined}
                onClick={() => void preview()}
            >
                {t('settings.ObsSafeSetup.337')}</button>
            {onOpenGuide && (
                <button type="button" className={buttonClass} disabled={busy} aria-describedby={busy ? reasonId : undefined} onClick={onOpenGuide}>
                    {t('settings.ObsSafeSetup.338')}</button>
            )}
            </div>
            {unavailableReason && <p id={reasonId} className="text-xs text-muted-foreground" role="status">{unavailableReason}</p>}
            {error && (
                <p role="alert" className="text-warning break-words">
                    {originalObsText(t, error)} {t('settings.ObsSafeSetup.339')}</p>
            )}
            {plan && (
                <div
                    className="rounded border border-border p-3 space-y-3"
                    aria-label={t('settings.ObsSafeSetup.340')}
                >
                    {plan.message && <p>{formatObsText(t, plan.messageText, plan.message)}</p>}
                    {plan.changes.length > 0 ? (
                        <ul className="space-y-2">
                            {plan.changes.map((c, i) => (
                                <li key={i} className="break-words">
                                    <strong>
                                        {c.source}：{formatObsText(t, c.labelText, c.label)}
                                    </strong>
                                    <p className="text-xs text-muted-foreground">
                                        {formatObsText(t, c.beforeText, c.beforeDisplay ?? c.before)} →{' '}
                                        {formatObsText(t, c.afterText, c.afterDisplay ?? c.after)}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        plan.supported && <p>{t('settings.ObsSafeSetup.341')}</p>
                    )}
                    {plan.supported && plan.changes.length > 0 && (
                        <button
                            type="button"
                            className={buttonClass}
                            disabled={busy || disabled}
                            aria-describedby={unavailableReason ? reasonId : undefined}
                            onClick={() =>
                                void run(async () => {
                                    const result = await obsApi.applySetup(plan.id);
                                    setHistory((items) => [...items, result]);
                                    setPlan(null);
                                    revealHistory();
                                })
                            }
                        >
                            {t('settings.ObsSafeSetup.342')}</button>
                    )}
                    <button
                        type="button"
                        className={buttonClass}
                        disabled={busy} aria-describedby={busy ? reasonId : undefined}
                        onClick={() => setPlan(null)}
                    >
                        {t('settings.ObsSafeSetup.343')}</button>
                    {plan.supported && plan.duplicateMicSources.length > 0 && (
                        <div className="space-y-2">
                            <p>{t('settings.ObsSafeSetup.344')}</p>
                            {plan.duplicateMicSources.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={`${buttonClass} block break-all`}
                                    disabled={busy || disabled}
                                    aria-describedby={unavailableReason ? reasonId : undefined}
                                    onClick={() => void preview(name)}
                                >
                                    {t('settings.obs.mutePreview', { source: name })}</button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            <details ref={historyDetails} className="rounded border border-border p-3 space-y-3">
              <summary className="cursor-pointer font-medium">{t('structure.history')}</summary>
            <p className="text-xs text-muted-foreground">
                {t('settings.ObsSafeSetup.346')}</p>
            <button
                type="button"
                className={buttonClass}
                disabled={busy} aria-describedby={busy ? reasonId : undefined}
                onClick={() =>
                    void run(async () => {
                        setHistory(await obsApi.setupHistory());
                        setPlan(null);
                    }, false)
                }
            >
                {t('settings.ObsSafeSetup.347')}</button>
            {history.length > 0 && (
                <ol className="space-y-3" aria-label={t('settings.ObsSafeSetup.348')}>
                    {[...history].reverse().map((h) => (
                        <li key={h.id} className="rounded border border-border p-3 space-y-2">
                            <p>
                                {h.timing ? t('settings.ObsSafeSetup.349') : t('settings.ObsSafeSetup.350')} #{h.id} {h.connectionLabel}
                            </p>
                            {h.timing && <p className="text-xs text-muted-foreground">{t('settings.obs.timing', { source: h.timing.source, before: h.timing.currentOffsetMs, after: h.timing.resultOffsetMs, delay: h.timing.additionalDelayMs, note: h.timing.measurement.referenceNote })}</p>}
                            {h.restorable === false && (
                                <p id={`${reasonId}-${h.id}`} className="text-xs text-warning">
                                    {t('settings.ObsSafeSetup.355')}</p>
                            )}
                            <ul>
                                {h.changes.map((c, i) => (
                                    <li key={i} className="break-words">
                                        {c.source}：{formatObsText(t, c.labelText, c.label)} — {obsHistoryResults(t, h)[i]}
                                        <p className="text-xs text-muted-foreground">
                                            {formatObsText(t, c.beforeText, c.beforeDisplay ?? c.before)} →{' '}
                                            {formatObsText(t, c.afterText, c.afterDisplay ?? c.after)}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                className={buttonClass}
                                disabled={busy || disabled || h.restorable === false}
                                aria-describedby={[unavailableReason ? reasonId : null, h.restorable === false ? `${reasonId}-${h.id}` : null].filter(Boolean).join(' ') || undefined}
                                onClick={() =>
                                    void run(async () => {
                                        setPlan(null);
                                        const result = await obsApi.restoreSetup(h.id);
                                        setHistory((items) =>
                                            items.map((item) =>
                                                item.id === result.id ? result : item,
                                            ),
                                        );
                                        revealHistory();
                                    })
                                }
                            >
                                {t('settings.obs.undo', { id: h.id })}</button>
                            <button
                                disabled={busy} aria-describedby={busy ? reasonId : undefined}
                                className={buttonClass}
                                onClick={() => setForgetting(h.id)}
                            >
                                {t('settings.obs.forget', { id: h.id })}</button>
                            {forgetting === h.id && (
                                <div className="space-y-2">
                                    <p>
                                        {t('settings.ObsSafeSetup.360')}</p>
                                    <button
                                        disabled={busy} aria-describedby={busy ? reasonId : undefined}
                                        className={buttonClass}
                                        onClick={() =>
                                            void run(async () => {
                                                await obsApi.forgetHistory(h.id);
                                                setHistory((items) =>
                                                    items.filter((item) => item.id !== h.id),
                                                );
                                                setForgetting(null);
                                            }, false)
                                        }
                                    >
                                        {t('settings.ObsSafeSetup.361')}</button>
                                    <button
                                        disabled={busy} aria-describedby={busy ? reasonId : undefined}
                                        className={buttonClass}
                                        onClick={() => setForgetting(null)}
                                    >
                                        {t('settings.ObsSafeSetup.362')}</button>
                                </div>
                            )}
                        </li>
                    ))}
                </ol>
            )}
            </details>
        </section>
    );
}
