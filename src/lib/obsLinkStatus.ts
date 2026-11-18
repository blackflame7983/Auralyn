import type { MessageKey } from '@/i18n/messages';

export interface ObsLinkFacts {
    connected: boolean;
    connecting: boolean;
    checking: boolean;
    failed: boolean;
    unreadable: boolean;
}

export interface ObsLinkStatus {
    tone: 'ok' | 'warn' | 'error' | 'off';
    label: MessageKey;
}

// 設定のOBS連携の見出しに出す札。接続の状態の値はOBSの接続の購読と取得から得て、ここで新しく問い合わせない。
// 状態を読めないときは「未接続」と言わず、確認できないことを示す（DESIGN.md 2.5）。
export function obsLinkStatus(facts: ObsLinkFacts): ObsLinkStatus {
    if (facts.connected) return { tone: 'ok', label: 'settings.ObsConnectionSettings.291' };
    if (facts.connecting) return { tone: 'warn', label: 'obs.status.connecting' };
    if (facts.checking) return { tone: 'warn', label: 'obs.status.checking' };
    if (facts.failed) return { tone: 'error', label: 'obs.status.failed' };
    if (facts.unreadable) return { tone: 'warn', label: 'obs.status.unknown' };
    return { tone: 'off', label: 'obs.status.disconnected' };
}
