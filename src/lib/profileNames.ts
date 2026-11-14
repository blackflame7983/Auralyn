import { message, type MessageKey } from '@/i18n/messages';
import type { Locale } from '@/i18n/locale';

// 保存時の `crypto.randomUUID()` と同じ、小文字16進の UUID だけを復旧の退避とみなす。
const RECOVERY_PROFILE_NAME = /^VST-recovery-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `VST-recovery-` に UUID が続く名前だけを、復旧の退避とみなす。 */
export function isRecoveryProfileName(name: string): boolean {
    return RECOVERY_PROFILE_NAME.test(name);
}

/**
 * 画面に出す名前。退避でなければ元の名前を返す。
 * 退避の ID は UUID の先頭8文字。保存名そのものは変えない。
 */
export function profileDisplayName(name: string, locale: Locale): string {
    const id = RECOVERY_PROFILE_NAME.exec(name)?.[1];
    return id ? message(locale, 'profile.recoveryName' satisfies MessageKey, { id }) : name;
}
