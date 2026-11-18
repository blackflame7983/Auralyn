import { toast } from 'sonner';
import type { MessageKey } from '@/i18n/messages';
import type { PluginNoticeFormatter } from './pluginNotice';

const LIVE_LOCK_TOAST_ID = 'live-lock-blocked';

/** バックエンドの保護の拒否文（src-tauri の PROTECTED）の語。liveLockReason.test.ts が Rust の文との一致を照らす。 */
export const LIVE_LOCK_REJECTION_MARKER = '本番保護中は';

/** 操作ロック中にバックエンドが VST の変更を断ったときの拒否か。拒否文の語で見分ける。 */
export function isLiveLockRejection(error: unknown): boolean {
    return String(error).includes(LIVE_LOCK_REJECTION_MARKER);
}

/**
 * 操作ロックに断られた変更は、一般の失敗文に置き換えず、アプリの言葉で理由と解除のしかたを通知で見せる。
 * バックエンドの原文は画面に出さない（呼び出し側が開発者向けに console へ残す）。
 * ロックの拒否だったときだけ通知して true を返す。ラックはロックされても変わらないので、呼び出し側は元の状態のまま戻す。
 */
export function notifyLiveLock(t: PluginNoticeFormatter, error: unknown, title: MessageKey, id: string | number = LIVE_LOCK_TOAST_ID): boolean {
    if (!isLiveLockRejection(error)) return false;
    toast.error(t(title), { id, description: t('pluginNotices.liveLockedBody'), duration: 10000 });
    return true;
}
