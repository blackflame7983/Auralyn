// index.css のテーマ変数をこの範囲だけに適用し、現在のテーマにかかわらず実際の配色を示す。
// ゲーミングの見本は、同じ CSS が切り欠いた形も付ける。色だけでなく形で見比べる。
export function ThemeSwatch({ theme }: { theme: 'light' | 'dark' | 'gaming' }) {
    return <span data-theme-preview={theme} aria-hidden="true"
        className="flex h-10 w-20 shrink-0 items-center justify-between gap-2 rounded-control border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 text-[hsl(var(--foreground))]">
        <span className="font-semibold">Aa</span>
        <span className="size-3 shrink-0 rounded-full bg-[hsl(var(--primary))]" />
    </span>;
}
