import type { ReactNode, Ref } from 'react';

/** 接続・音づくり・設定は見出しの行に説明を置く。VST は説明をその下の行に置く。 */
export function PageHeading({ title, lead, headingRef, leadId, actions, leadBelow = false }: {
    title: string;
    lead?: string;
    headingRef?: Ref<HTMLHeadingElement>;
    /** 説明の一文へ焦点を戻すときだけ付ける。 */
    leadId?: string;
    actions?: ReactNode;
    leadBelow?: boolean;
}) {
    const heading = <h1 ref={headingRef} tabIndex={-1} className="text-ui-heading font-semibold text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{title}</h1>;
    const leadNode = lead ? <p id={leadId} tabIndex={leadId ? -1 : undefined} className={leadBelow
        ? 'page-heading-lead mt-1 w-full text-pretty break-words text-ui-support text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
        : 'page-heading-lead min-w-0 flex-1 break-words text-ui-support text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring'}>{lead}</p> : null;
    if (leadBelow) {
        return (
            <header className="page-heading shrink-0 pb-2">
                <div data-page-heading-row className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {heading}
                    {actions ? <div className="ml-auto">{actions}</div> : null}
                </div>
                {leadNode}
            </header>
        );
    }
    return (
        <header className="page-heading flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 pb-2">
            {heading}
            {leadNode}
            {actions}
        </header>
    );
}
