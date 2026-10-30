import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 状態を色の点と文言で示す。色だけで伝えない（DESIGN.md 7）。
// ok=正常（success）、warn=未確認・注意（warning）、error=停止中の異常（meter-danger、ヘッダーの状態表示と同じ）、off=設定 OFF などの中立。
export type StatusTone = 'ok' | 'warn' | 'error' | 'off';

const tones: Record<StatusTone, string> = {
    ok: 'bg-success shadow-[0_0_6px_hsl(var(--success)/0.5)]',
    warn: 'bg-warning',
    error: 'bg-meter-danger',
    off: 'bg-muted-foreground/50',
};

export function StatusDot({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
    return <span data-tone={tone} className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
        <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', tones[tone])} />
        <span className="truncate">{children}</span>
    </span>;
}
