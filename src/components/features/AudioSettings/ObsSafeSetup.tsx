import { ObsText } from '@/components/ui/ObsText';
import { ErrorDetails } from '@/components/ui/ErrorDetails';
import { obsHistoryResultParts, obsTextParts } from '@/lib/obsUiText';
import { useMessages } from '@/i18n/LocaleProvider';
import { InfoPopover } from '@/components/ui/InfoPopover';
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
    const [error, setError] = useState<{ operation: 'history' | 'preview' | 'apply' | 'undo' | 'forget'; value: unknown } | null>(null);
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
                if (active && revision === historyRevision.current) setError({ operation: 'history', value: e });
            });
        return () => {
            active = false;
        };
    }, [connected]);
    useEffect(() => {
        onBusyChange(busy);
        return () => onBusyChange(false);
    }, [busy, onBusyChange]);
    const run = async (operation: NonNullable<typeof error>['operation'], action: () => Promise<void>, requiresConnection = true) => {
        if (inFlight.current || (requiresConnection && disabled)) return;
        inFlight.current = true;
        historyRevision.current += 1;
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError({ operation, value: e });
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };
    const preview = (source?: string) =>
        run('preview', async () => {
            setPlan(null);
            setPlan(await obsApi.previewSetup(source));
        });
    const planMessage = plan?.message ? obsTextParts(t, plan.messageText, plan.message) : null;
    const errorParts = error ? obsTextParts(t, error.value, error.value instanceof Error ? String(error.value) : error.value) : null;
    const historyFull = error?.value === '変更履歴が20件あります。OBSで状態を確認し、不要な履歴を削除してください。';
    const buttonClass = 'rounded border border-border px-3 py-2 hover:bg-muted disabled:opacity-50';
    return (
        <section aria-label={t('settings.ObsSafeSetup.335')} className="space-y-3 text-sm">
            <div className="flex items-center gap-1">
                <p className="text-ui-support text-muted-foreground">{t('obsSetup.stopFirst')}</p>
                <InfoPopover label={t('settings.ObsSafeSetup.335')}>{t('settings.ObsSafeSetup.336')}</InfoPopover>
            </div>
            <div className="flex flex-wrap gap-2">
            <button
                type="button"
                className={`${buttonClass} text-ui-control`}
                disabled={busy || disabled}
                aria-describedby={unavailableReason ? reasonId : undefined}
                onClick={() => void preview()}
            >
                {t('settings.ObsSafeSetup.337')}</button>
            {onOpenGuide && (
                <button type="button" className={`${buttonClass} text-ui-control`} disabled={busy} aria-describedby={busy ? reasonId : undefined} onClick={onOpenGuide}>
                    {t('settings.ObsSafeSetup.338')}</button>
            )}
            </div>
            {unavailableReason && <p id={reasonId} className="text-ui-support text-muted-foreground" role="status">{unavailableReason}</p>}
            {error && (
                <div className="space-y-2">
                    <p role="alert" className="text-warning">{historyFull ? t('obsSetup.historyFull') : errorParts?.summary ?? t(`obsSetup.${error.operation}Failed`)} {!historyFull && !errorParts?.summary && t(error.operation === 'preview' ? 'obsSetup.previewNextStep' : error.operation === 'forget' ? 'obsSetup.forgetNextStep' : 'obsSetup.errorNextStep', { preview: t('settings.ObsSafeSetup.337'), history: t('structure.history'), refresh: t('settings.ObsSafeSetup.347') })}</p>
                    {errorParts?.detail && <ErrorDetails detail={errorParts.detail} />}
                </div>
            )}
            {plan && (
                <div
                    className="rounded border border-border p-3 space-y-3"
                    aria-label={t('settings.ObsSafeSetup.340')}
                >
                    {planMessage && <div className="space-y-2">
                        <p>{planMessage.summary ?? (plan.changes.length > 0 ? t('obsSetup.planMessageUnavailable') : t('obsSetup.planUnavailable', { preview: t('settings.ObsSafeSetup.337') }))}</p>
                        {planMessage.detail && <ErrorDetails detail={planMessage.detail} />}
                    </div>}
                    {plan.changes.length > 0 ? (
                        <ul className="space-y-2">
                            {plan.changes.map((c, i) => (
                                <li key={i} className="break-words">
                                    <div className="font-bold">
                                        {c.source}：<ObsText text={c.labelText} legacy={c.label} />
                                    </div>
                                    <div className="text-ui-support text-muted-foreground">
                                        <ObsText text={c.beforeText} legacy={c.beforeDisplay ?? c.before} /> →{' '}
                                        <ObsText text={c.afterText} legacy={c.afterDisplay ?? c.after} />
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        plan.supported && <p>{t('settings.ObsSafeSetup.341')}</p>
                    )}
                    {plan.supported && plan.changes.length > 0 && (
                        <button
                            type="button"
                            className={`${buttonClass} text-ui-control`}
                            disabled={busy || disabled}
                            aria-describedby={unavailableReason ? reasonId : undefined}
                            onClick={() =>
                                void run('apply', async () => {
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
                        className={`${buttonClass} text-ui-control`}
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
                                    className={`${`${buttonClass} block break-all`} text-ui-control`}
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
            <p className="text-ui-support text-muted-foreground">
                {t('settings.ObsSafeSetup.346')}</p>
            <button
                type="button"
                className={`${buttonClass} text-ui-control`}
                disabled={busy} aria-describedby={busy ? reasonId : undefined}
                onClick={() =>
                    void run('history', async () => {
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
                            {h.timing && <p className="text-ui-support text-muted-foreground">{t('settings.obs.timing', { source: h.timing.source, before: h.timing.currentOffsetMs, after: h.timing.resultOffsetMs, delay: h.timing.additionalDelayMs, note: h.timing.measurement.referenceNote })}</p>}
                            {h.restorable === false && (
                                <p id={`${reasonId}-${h.id}`} className="text-ui-support text-warning">
                                    {t('settings.ObsSafeSetup.355')}</p>
                            )}
                            <ul>
                                {h.changes.map((c, i) => (
                                    <li key={i} className="break-words">
                                        {c.source}：<ObsText text={c.labelText} legacy={c.label} /> — <ObsText parts={obsHistoryResultParts(t, h)[i]} />
                                        <div className="text-ui-support text-muted-foreground">
                                            <ObsText text={c.beforeText} legacy={c.beforeDisplay ?? c.before} /> →{' '}
                                            <ObsText text={c.afterText} legacy={c.afterDisplay ?? c.after} />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                className={`${buttonClass} text-ui-control`}
                                disabled={busy || disabled || h.restorable === false}
                                aria-describedby={[unavailableReason ? reasonId : null, h.restorable === false ? `${reasonId}-${h.id}` : null].filter(Boolean).join(' ') || undefined}
                                onClick={() =>
                                    void run('undo', async () => {
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
                                className={`${buttonClass} text-ui-control`}
                                onClick={() => setForgetting(h.id)}
                            >
                                {t('settings.obs.forget', { id: h.id })}</button>
                            {forgetting === h.id && (
                                <div className="space-y-2">
                                    <p>
                                        {t('settings.ObsSafeSetup.360')}</p>
                                    <button
                                        disabled={busy} aria-describedby={busy ? reasonId : undefined}
                                        className={`${buttonClass} text-ui-control`}
                                        onClick={() =>
                                            void run('forget', async () => {
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
                                        className={`${buttonClass} text-ui-control`}
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
