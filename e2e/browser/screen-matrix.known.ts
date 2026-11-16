// まだ直していない違反と、音楽鑑賞でも正しく出る語。
// 登録した違反が出なくなると試験が失敗する。直したら、その行を外す。

export type MatrixCheck = 'overlap' | 'overflow' | 'wrap' | 'duplicate' | 'empty' | 'separator' | 'purpose';

export interface KnownViolation {
    check: MatrixCheck;
    /** home, sound, vst, connect, appearance, shortcuts, obs, system, stream-mix */
    screen: string;
    state?: 'live' | 'stopped' | 'unconfigured';
    purpose?: 'voice' | 'music';
    /** 900x600 のように、幅x高さ。 */
    size?: string;
    locale?: 'ja' | 'en';
    /** セレクタか、文字の先頭に含まれる断片。 */
    match: string;
    /** Issue 番号。未起票の崩れは new。 */
    issue: string;
}

export interface PurposeAllowance {
    screen?: string;
    state?: 'live' | 'stopped' | 'unconfigured';
    purpose?: 'voice' | 'music';
    size?: string;
    locale?: 'ja' | 'en';
    /** この文字を含む要素では、中の配信・声向けの語を違反にしない。 */
    match: string;
    reason: string;
}

export const knownViolations: KnownViolation[] = [];

export const purposeAllowances: PurposeAllowance[] = [];
