import type { ReactNode, Ref } from 'react';

/** 接続・音づくり・VST・設定で、見出しと説明の一文を同じ位置に置く。 */
export function PageHeading({ title, lead, headingRef, leadId, actions }: {
    title: string;
    lead?: string;
    headingRef?: Ref<HTMLHeadingElement>;
    /** 説明の一文へ焦点を戻すときだけ付ける。 */
    leadId?: string;
    actions?: ReactNode;
}) {
    return (
        <header className="page-heading flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 pb-2">
            <h1 ref={headingRef} tabIndex={-1} className="text-ui-heading font-semibold text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{title}</h1>
            {lead ? <p id={leadId} tabIndex={leadId ? -1 : undefined} className="page-heading-lead min-w-0 flex-1 break-words text-ui-support text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{lead}</p> : null}
            {actions}
        </header>
    );
}
