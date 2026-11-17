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

export const purposeAllowances: PurposeAllowance[] = [
    // 外観は、接続ページにある使い方の切替を案内する。設定のタブ名も残す。
    { screen: 'appearance', purpose: 'music', locale: 'ja', match: '配信と音楽鑑賞の切り替え', reason: '外観のページが、接続ページの「使い道」へ案内する文' },
    { screen: 'appearance', purpose: 'music', locale: 'ja', match: 'OBS連携', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },
    { screen: 'appearance', purpose: 'music', locale: 'en', match: 'Switch between streaming', reason: '外観のページが、接続ページの「使い方」へ案内する文' },
    { screen: 'appearance', purpose: 'music', locale: 'en', match: 'OBS', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },
    { screen: 'shortcuts', purpose: 'music', locale: 'ja', match: 'OBS連携', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },
    { screen: 'shortcuts', purpose: 'music', locale: 'en', match: 'OBS', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },
    { screen: 'shortcuts', purpose: 'music', locale: 'en', match: 'Stream Deck', reason: 'Stream Deck は製品名で、音楽鑑賞のホットキーでも使う' },
    { screen: 'system', purpose: 'music', locale: 'ja', match: 'OBS連携', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },
    { screen: 'system', purpose: 'music', locale: 'en', match: 'OBS', reason: '設定のタブ名。画面の切替なので音楽鑑賞でも残す' },

    // OBS連携のページ自体は、音楽鑑賞でも開く。配信中に適用しない注意も、そのページの文。
    { screen: 'obs', purpose: 'music', locale: 'ja', match: 'OBS', reason: 'OBS連携のページは、音楽鑑賞でも開く設定画面' },
    { screen: 'obs', purpose: 'music', locale: 'ja', match: '配信・録画を停止してから適用してください。', reason: 'OBSの設定を適用する前に、配信と録画を止める注意' },
    { screen: 'obs', purpose: 'music', locale: 'en', match: 'OBS', reason: 'OBS連携のページは、音楽鑑賞でも開く設定画面' },
    { screen: 'obs', purpose: 'music', locale: 'en', match: 'Stop streaming and recording before applying.', reason: 'OBSの設定を適用する前に、配信と録画を止める注意' },

    // 接続ページは、音楽鑑賞では出さないことの説明を持つ。
    { screen: 'connect', purpose: 'music', locale: 'ja', match: '使い道を配信・通話にすると使えます。', reason: '音楽鑑賞ではパネルを出さないと書き、戻す先の名前を示す文' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'Streaming & calls', reason: '音楽鑑賞ではパネルを出さないと書き、戻す先の名前を示す文' },
];
