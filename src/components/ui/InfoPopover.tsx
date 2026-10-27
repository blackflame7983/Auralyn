import { type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { MdInfoOutline } from 'react-icons/md';

// クリックとキーボードの両方で開き、Escape で閉じた後は入口に戻る。
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
    return <Popover.Root>
        <Popover.Trigger asChild>
            <button type="button" aria-label={label} className="inline-flex rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                <MdInfoOutline aria-hidden="true" className="h-4 w-4" />
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content aria-label={label} sideOffset={5} collisionPadding={12} className="z-[200] max-h-[min(60vh,24rem)] w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
                {children}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}
