//! 画面の書体。Noto Sans JP（Google Fonts の可変フォント、SIL OFL 1.1。全文は `assets/fonts/OFL.txt`）を実行ファイルに入れて使う。
//! Yu Gothic UI は小さい字で線が細く、文の多い所で読み疲れたので替えた（docs/gpui/decisions.md 2026-11-27）。

use std::borrow::Cow;

use gpui_kit::component::Theme;
use gpui_kit::App;

const FAMILY: &str = "Noto Sans JP";
static NOTO_SANS_JP: &[u8] = include_bytes!("../assets/fonts/NotoSansJP-Variable.ttf");

/// 書体を読み込み、部品（ポップオーバー・ツールチップも）の書体にする。読めなければ GPUI の既定の書体のまま。
pub fn install(cx: &mut App) {
    if let Err(error) = cx
        .text_system()
        .add_fonts(vec![Cow::Borrowed(NOTO_SANS_JP)])
    {
        log::warn!("書体 {FAMILY} を読み込めません: {error}");
        return;
    }
    Theme::update(cx, |theme| theme.font_family = FAMILY.into());
}
