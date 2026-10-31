import { useState } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { MdWarningAmber } from 'react-icons/md';
import type { PluginSessionRestoreResult } from '../../../lib/restorePluginSession';

interface SessionRecoveryNoticeProps {
    status: PluginSessionRestoreResult['status'] | 'pending';
    protectedSession: boolean;
    reason: string | null;
    busy: boolean;
    onRetry: () => Promise<void> | void;
    /** 保存済み構成のうち、読み込めていないVSTの名前。 */
    unrestored?: string[];
    missingRecovery?: { names: string[] } | null;
    onCheckMissing?: () => Promise<void>;
    onSaveWithoutMissing?: () => Promise<void>;
}
const labels = {
    success: 'session.success',
    partial: 'session.partial',
    failed: 'session.failed',
    cancelled: 'session.cancelled',
    retained: 'session.retained',
} as const;

// 右パネルの開閉に関係なく、保護理由と明示的な再試行をホームに残す。
export function SessionRecoveryNotice({ status, protectedSession, reason, busy, onRetry, unrestored = [], missingRecovery, onCheckMissing, onSaveWithoutMissing }: SessionRecoveryNoticeProps) {
    const t = useMessages();
    const [recoveryError, setRecoveryError] = useState(false);
    if (!protectedSession || status === 'pending') return null;
    // 何が読み込めていないかを先に示し、再試行で直らない場合の手がかりを説明の中に置く。
    const names = unrestoredNamesText(t, unrestored);
    // 引継ぎは正常な動作のことが多い。枠を付けない控えめな文にし、保護中であることは常に見せ、再試行の説明は折りたたむ。
    const retained = status === 'retained';
    const retry = <>
        <p className="text-xs text-muted-foreground">{t('session.explain')}</p>
        {names && <p className="text-xs text-muted-foreground">{t('session.missingHint')}</p>}
        <button type="button" disabled={busy} onClick={() => void onRetry()} className="rounded-md border border-border bg-background px-3 py-2 font-medium disabled:opacity-50">
            {t('session.retry')}
        </button>
        {onCheckMissing && onSaveWithoutMissing && <div className="space-y-2">
            <button type="button" disabled={busy} onClick={() => { setRecoveryError(false); void onCheckMissing().catch(() => setRecoveryError(true)); }} className="rounded-md border border-border bg-background px-3 py-2 font-medium disabled:opacity-50">{t('session.checkMissing')}</button>
            {missingRecovery && (missingRecovery.names.length ? <div className="space-y-2">
                <p>{t('session.removeMissingImpact')}</p>
                <ul className="list-disc pl-5">{missingRecovery.names.map((name, index) => <li key={index}>{name}</li>)}</ul>
                <button type="button" disabled={busy} onClick={() => { setRecoveryError(false); void onSaveWithoutMissing().catch(() => setRecoveryError(true)); }} className="rounded-md border border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 px-3 py-2 font-medium disabled:opacity-50">{t('session.confirmRemoveMissing')}</button>
            </div> : <p>{t('session.noMissing')}</p>)}
            {recoveryError && <p role="alert">{t('session.missingRecoveryFailed')}</p>}
        </div>}
        {busy && <p role="status" className="text-xs">{t('session.busy')}</p>}
    </>;
    if (retained) return <section aria-label={t('session.label')} className="mb-4 space-y-1 px-1 text-xs text-muted-foreground">
        <h2 className="font-semibold">{t(labels[status])}</h2>
        <p>{reason ?? t('session.defaultReason')}</p>
        <details>
            <summary className="cursor-pointer">{t('session.retryDetails')}</summary>
            <div className="mt-2 space-y-2">{retry}</div>
        </details>
    </section>;
    return <section aria-label={t('session.label')} className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground">
        <h2 className="flex items-center gap-2 font-semibold"><MdWarningAmber aria-hidden="true" className="h-5 w-5 shrink-0 text-warning" />{t(labels[status])}</h2>
        <p className="min-w-0 flex-1 basis-48 text-xs">{names ? <><span className="font-semibold">{names}</span><br /></> : null}{reason ?? t('session.defaultReason')}</p>
        <details open={busy || undefined} className="recovery-details min-w-0">
            <summary className="cursor-pointer text-xs font-medium">{t('session.retryDetails')}</summary>
            <div className="mt-2 space-y-2">{retry}</div>
        </details>
    </section>;
}

export function unrestoredNamesText(t: ReturnType<typeof useMessages>, names: string[]): string | null {
    if (names.length === 0) return null;
    const shown = names.slice(0, 3).join(t('session.listSeparator'));
    return t('session.unrestored', { names: names.length > 3 ? t('session.more', { names: shown, count: names.length - 3 }) : shown });
}
