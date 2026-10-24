import { useMessages } from '@/i18n/LocaleProvider';
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

// 表示モードやラックの折畳みに関係なく、保護理由と明示的な再試行を残す。
export function SessionRecoveryNotice({ status, protectedSession, reason, busy, onRetry }: SessionRecoveryNoticeProps) {
    const t = useMessages();
    if (!protectedSession || status === 'pending') return null;
    return <section aria-label={t('session.label')} className="mb-4 space-y-2 rounded-lg border border-amber-600/50 bg-amber-500/10 p-3 text-sm text-foreground">
        <h2 className="font-bold">{t(labels[status])}</h2>
        <p>{reason ?? t('session.defaultReason')}</p>
        <p className="text-xs text-muted-foreground">{t('session.explain')}</p>
        <button type="button" disabled={busy} onClick={() => void onRetry()} className="rounded-md border border-border bg-background px-3 py-2 font-medium disabled:opacity-50">
            {t('session.retry')}
        </button>
        {busy && <p role="status" className="text-xs">{t('session.busy')}</p>}
    </section>;
}
