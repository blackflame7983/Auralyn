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

export const knownViolations: KnownViolation[] = [
    // 停止中の外部VSTカードで、名前の上に「追加」が乗る。
    { check: 'overlap', screen: 'home', state: 'stopped', purpose: 'voice', size: '900x600', locale: 'ja', match: '外部VST', issue: '#621' },
    // 音楽鑑賞の VST カードは、中身の無い2段目の区切りを描いたままにする。配信ミックスはパネルを出さないので、同じホームが見える。
    { check: 'separator', screen: 'home', state: 'live', purpose: 'music', size: '1280x800', match: '区切りの後ろに中身がない', issue: '#623' },
    { check: 'separator', screen: 'stream-mix', purpose: 'music', size: '1280x800', match: '区切りの後ろに中身がない', issue: '#623' },

    // 未設定の「ここを決める」は title が無く、狭いカードではみ出す。1280×800 では収まる。
    { check: 'overflow', screen: 'home', state: 'unconfigured', size: '900x600', locale: 'ja', match: 'ここを決める', issue: 'new' },
    { check: 'overflow', screen: 'home', state: 'unconfigured', size: '1024x768', locale: 'ja', match: 'ここを決める', issue: 'new' },
    { check: 'overflow', screen: 'home', state: 'unconfigured', size: '900x600', locale: 'en', match: 'Choose this', issue: 'new' },
    { check: 'overflow', screen: 'home', state: 'unconfigured', size: '1024x768', locale: 'en', match: 'Choose this', issue: 'new' },

    // 停止中の英語だけ、送り先を指定するボタンが上の帯の経路に重なる。
    { check: 'overlap', screen: 'home', state: 'stopped', purpose: 'voice', size: '1024x768', locale: 'en', match: 'Specify the destination', issue: 'new' },

    // 実行中の英語で、声の流れと今の状態が同じ「レベル未受信」を言う。日本語は10文字未満なので対象外。
    { check: 'duplicate', screen: 'home', state: 'live', locale: 'en', match: 'Waiting for level updates', issue: 'new' },
    { check: 'duplicate', screen: 'stream-mix', locale: 'en', match: 'Waiting for level updates', issue: 'new' },

    // 接続ページの機器選択が、下に固定した保存の欄に重なる。1280 は出力、900 の英語は名前の長い入力。
    { check: 'overlap', screen: 'connect', size: '1280x800', match: 'CABLE Output', issue: 'new' },
    { check: 'overlap', screen: 'connect', size: '900x600', locale: 'en', match: 'Microphone / virtual cable', issue: 'new' },

    // 900×600 のホットキーで、キー入力と取り消しと「未設定」が重なる。
    { check: 'overlap', screen: 'shortcuts', size: '900x600', locale: 'ja', match: 'キー設定の編集を取り消す', issue: 'new' },
    { check: 'overlap', screen: 'shortcuts', size: '900x600', locale: 'en', match: 'Discard key edits', issue: 'new' },
];

export const purposeAllowances: PurposeAllowance[] = [
    // 外観は、接続ページにある使い方の切替を案内する。設定のタブ名も残す。
    { screen: 'appearance', purpose: 'music', locale: 'ja', match: '配信と音楽鑑賞の切り替え', reason: '外観のページが、接続ページの「使い方」へ案内する文' },
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

    // 接続ページは、配信側の機能と、音楽鑑賞では出さないことの説明を持つ。
    { screen: 'connect', purpose: 'music', locale: 'ja', match: '自分用と配信用に分ける', reason: '接続ページが、自分用と配信用の分け方を説明する欄' },
    { screen: 'connect', purpose: 'music', locale: 'ja', match: '歌・モニター', reason: '接続ページの歌モニター欄の名前' },
    { screen: 'connect', purpose: 'music', locale: 'ja', match: 'オケ・配信音を仕上げるVST・歌モニターは、ホームの「配信ミックス」パネルで設定します。', reason: '接続ページが、配信ミックスの設定場所を案内する文' },
    { screen: 'connect', purpose: 'music', locale: 'ja', match: '配信ミックス', reason: '接続ページにある配信ミックス欄の見出し' },
    { screen: 'connect', purpose: 'music', locale: 'ja', match: 'ホームの表示を「配信・通話向け」にすると使えます。', reason: '音楽鑑賞ではパネルを出さないと書き、戻す先の名前を示す文' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'Separate monitor and broadcast', reason: '接続ページが、自分用と配信用の分け方を説明する欄' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'Singing and monitoring', reason: '接続ページの歌モニター欄の名前' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'Set the backing track, broadcast VST, and singing monitor in the Broadcast mix panel on Home.', reason: '接続ページが、配信ミックスの設定場所を案内する文' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'Broadcast mix', reason: '接続ページにある配信ミックス欄の見出し' },
    { screen: 'connect', purpose: 'music', locale: 'en', match: 'For streaming / calls', reason: '音楽鑑賞ではパネルを出さないと書き、戻す先の名前を示す文' },
];
