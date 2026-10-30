import { useMessages } from '@/i18n/LocaleProvider';
import { MdWarningAmber } from 'react-icons/md';
import type { PluginSessionRestoreResult } from '../../../lib/restorePluginSession';

interface SessionRecoveryNoticeProps {
    status: PluginSessionRestoreResult['status'] | 'pending';
    protectedSession: boolean;
    reason: string | null;
    busy: boolean;
    onRetry: () => Promise<void> | void;
}
const labels = {
    success: 'session.success',
    partial: 'session.partial',
    failed: 'session.failed',
    cancelled: 'session.cancelled',
    retained: 'session.retained',
} as const;

// 右パネルの開閉に関係なく、保護理由と明示的な再試行をホームに残す。
export function SessionRecoveryNotice({ status, protectedSession, reason, busy, onRetry }: SessionRecoveryNoticeProps) {
    const t = useMessages();
    if (!protectedSession || status === 'pending') return null;
    // 引継ぎは正常な動作のことが多い。枠を付けない控えめな文にし、保護中であることは常に見せ、再試行の説明は折りたたむ。
    const retained = status === 'retained';
    const retry = <>
        <p className="text-xs text-muted-foreground">{t('session.explain')}</p>
        <button type="button" disabled={busy} onClick={() => void onRetry()} className="rounded-md border border-border bg-background px-3 py-2 font-medium disabled:opacity-50">
            {t('session.retry')}
        </button>
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
    return <section aria-label={t('session.label')} className="mb-4 space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
        <h2 className="flex items-center gap-2 font-semibold"><MdWarningAmber aria-hidden="true" className="h-5 w-5 shrink-0 text-warning" />{t(labels[status])}</h2>
        <p>{reason ?? t('session.defaultReason')}</p>
        <details open={busy || undefined}>
            <summary className="cursor-pointer text-xs font-medium">{t('session.retryDetails')}</summary>
            <div className="mt-2 space-y-2">{retry}</div>
        </details>
    </section>;
}
