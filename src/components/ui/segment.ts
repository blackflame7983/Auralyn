import { cn } from '@/lib/utils';

// ホームと設定で選択状態と寸法を共用する。
export const segmentButtonClass = (selected: boolean) => cn(
    'min-w-16 whitespace-nowrap rounded-md border px-2 py-2 text-[13px] font-bold transition-colors disabled:opacity-50',
    selected ? 'border-selection bg-selection/15 text-selection' : 'border-input bg-background text-muted-foreground hover:text-foreground',
);
