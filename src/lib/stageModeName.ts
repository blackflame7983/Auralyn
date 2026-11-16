import type { LiveModeSnapshot } from '@/api/liveModes';
import type { MessageKey } from '@/i18n/messages';

function modesRegistered(snapshot: LiveModeSnapshot): boolean {
    return Boolean(snapshot.definitions?.singing || snapshot.definitions?.talk);
}

/**
 * ホームの舞台の見出しに出す名前のキー。
 * 歌・雑談を1つも登録していないときは「いまの声」。モードの札は見出し側で出さない（#655）。
 * 登録済みで、反映済みなら反映中のモード、切替中・停止中・一部反映では向かっている先のモードを出し、
 * 切替の途中で「いまの調整」と言い切らない。状態が読めないあいだは「いまの調整」のままにする。
 */
export function stageModeKey(snapshot: LiveModeSnapshot | null | undefined): MessageKey {
    if (!snapshot) return 'liveBar.custom';
    if (!modesRegistered(snapshot)) return 'home.currentVoice';
    const mode = snapshot.phase === 'settled' ? snapshot.applied : snapshot.phase === 'custom' ? null : snapshot.target;
    return mode === 'singing' ? 'liveBar.singing' : mode === 'talk' ? 'liveBar.talk' : 'liveBar.custom';
}
