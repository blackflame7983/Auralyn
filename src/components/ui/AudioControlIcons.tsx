// 音量の測定（波形＋チェック）とレベル表示（2本のメーター）を形で区別する。
export function AudioCheckIcon({ className }: { className?: string }) {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M3 9v6m4-9v12m4-14v6m4-3v2" />
        <circle cx="16.5" cy="16" r="5.5" /><path d="m14 16 1.7 1.7 3.3-3.4" />
    </svg>;
}

export function LevelMeterIcon({ className }: { className?: string }) {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="11" y="3" width="5" height="18" rx="1.5" />
        <path d="M5.5 13v5m8-9v9M19 4h2m-2 8h2m-2 8h2" />
    </svg>;
}
