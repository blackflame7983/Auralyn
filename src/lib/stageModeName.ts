import type { LiveModeSnapshot } from '@/api/liveModes';
import type { MessageKey } from '@/i18n/messages';

/**
 * ホームの舞台の見出しに出すモード名のキー。
 * 反映済みなら反映中のモード、切替中・停止中・一部反映では向かっている先のモードを出し、
 * 切替の途中で「いまの調整」と言い切らない。状態が補助行（LiveModeBar の切替中・停止中の表示）で伝わる前提。
 */
export function stageModeKey(snapshot: LiveModeSnapshot | null | undefined): MessageKey {
    if (!snapshot) return 'liveBar.custom';
    const mode = snapshot.phase === 'settled' ? snapshot.applied : snapshot.phase === 'custom' ? null : snapshot.target;
    return mode === 'singing' ? 'liveBar.singing' : mode === 'talk' ? 'liveBar.talk' : 'liveBar.custom';
}
