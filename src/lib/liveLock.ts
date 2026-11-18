import { toast } from 'sonner';
import type { MessageKey } from '@/i18n/messages';
import type { PluginNoticeFormatter } from './pluginNotice';

const LIVE_LOCK_TOAST_ID = 'live-lock-blocked';

/** 操作ロック中にバックエンドが VST の変更を断ったときの拒否か。拒否文の語で見分け、文そのものは翻訳せず原文で見せる。 */
export function isLiveLockRejection(error: unknown): boolean {
    return String(error).includes('本番保護中は');
}

/**
 * 操作ロックに断られた変更は、一般の失敗文に置き換えず、理由の原文と解除のしかたを通知で見せる。
 * ロックの拒否だったときだけ通知して true を返す。ラックはロックされても変わらないので、呼び出し側は元の状態のまま戻す。
 */
export function notifyLiveLock(t: PluginNoticeFormatter, error: unknown, title: MessageKey, id: string | number = LIVE_LOCK_TOAST_ID): boolean {
    if (!isLiveLockRejection(error)) return false;
    toast.error(t(title), {
        id,
        description: `${t('pluginNotices.rawDetail', { detail: String(error) })} ${t('pluginNotices.liveLockedHint')}`,
        duration: 10000,
    });
    return true;
}
