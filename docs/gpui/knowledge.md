# GPUI の知見

GPUI で画面を書くときに、`src-gpui/`（右の列の試作から始めた GPUI 版）で確かめた書き方と落とし穴。
理由つきの決定は [decisions.md](decisions.md)、合否の証拠は [gpui-prototype-checklist.md](../plans/gpui-prototype-checklist.md) にある。
ここに書いた内容も、使う版（`AGENTS.md` の基準）が変わったら依存クレートのソースで確かめ直す。

## 版

- GPUI Kit 0.11.0。中身は `gpui-pre` 0.3.14 と `gpui-component` 0.11.0（`src-gpui/Cargo.lock`）。
- Zed 本体の `gpui` や、ほかの版の `gpui-component` の API とは名前と引数が違うことがある。例や記憶ではなく、`~/.cargo/registry/src/` にある上の版のソースで確かめる。

## 書き方

| 場面 | 書き方 | 場所 |
| :--- | :--- | :--- |
| 描画の周期 | 16ms の周期を1つだけ `cx.spawn_in` で持ち、全メーターで共有する。変化があったときだけ `cx.notify()` | `view.rs` の `tick` |
| 音声エンジン | `AudioHost` の命令は応答を待つので、画面のスレッドで呼ばない。専用のスレッドで受付順に実行し、続けて届いた音量は最後の値だけを送る | `engine/mod.rs` |
| メーターの値 | 届くたびに画面へ送らず、最新の値だけを置く。画面が周期で読む | `engine/events.rs`、`view.rs` の `tick`、`view/safety.rs` |
| 色 | 値を書かず、`auralyn_core::design::tokens()` から名前で取り、`rgb(..)` で `Hsla` にする。使う名前は試験で確かめる | `color.rs` |
| 振る舞いの規則 | 平滑化・保持・判定のような規則は GPUI に依存しないクレートに置き、時刻を引数で受けて試験する | `src-tauri/crates/auralyn-ui-model/` |
| スライダー | `SliderState` を `cx.new` で持ち、`cx.subscribe` で `SliderEvent::Change` と `Release` を受ける | `view.rs` の `new` |
| 読み上げ | 操作する要素に `.id(..)` と `.role(Role::..)` を付ける。ナレーターでの合格は AccessKit（UIA）による | `view.rs` |
| トレイとホットキー | `tray-icon` と `global-hotkey` は GPUI の主スレッドで作り、周期の中で `poll` する。登録の失敗は画面とログに出す | `desktop.rs` |
| 窓をトレイへ隠す | GPUI に窓を隠す手段が無い（`App::hide` は Windows では何もしない）。`window.on_window_should_close` で false を返して閉じるのを止め、`window.window_handle()`（`raw-window-handle`）の HWND に Win32 の `ShowWindow(SW_HIDE)`。出すときは `SW_SHOW` のあと `activate_window` | `desktop.rs` の `set_shown`、`view.rs` の `new` |
| 自前の描画 | `canvas(prepaint, paint)` の paint で `PathBuilder::fill()`／`stroke(px(..))` に `add_polygon` で点を渡し、`window.paint_path`。はみ出しは `with_content_mask` で切る。塗りには `linear_gradient` の `Background` も渡せ、グラデーションはパスの外接矩形に掛かる（2色まで） | `home.rs` の `paint_wave` |
| 動きを減らす設定 | `cx.reduce_motion()`（`App`）を渡し、時間の流れの描画を止めて今の値だけにする。ただし下の落とし穴のとおり、Windows の設定はまだ入らない | `view.rs` の `tick`、`auralyn-ui-model` の `flow` |
| 日本語入力 | GPUI Kit の `Input` / `InputState` を使う。自前の文字入力は作らない | `view.rs` |

## 落とし穴

- **閉じるときの「ウィンドウ ハンドルが無効です」（0.3.14、Windows）。** `WindowsWindow` の `Drop` は `ShowWindowAsync(SW_HIDE)` のあと、`RevokeDragDrop` と `DestroyWindow` を executor で後から呼ぶ。窓がもう壊れているとこれらが失敗し、`log_err` がモジュール名の無い ERROR（0x80070578・0x80040102 = `DRAGDROP_E_INVALIDHWND`）を出す。終了そのものは正常で、アプリ側で消す手段は無い。

- **動きを減らす設定を OS から読まない（0.3.14）。** `App::reduce_motion()` はアプリが `set_reduce_motion` で入れた値を返すだけで、初期値は false。Windows の「アニメーションを表示する」（`SPI_GETCLIENTAREAANIMATION`）はどこからも読まれない。読み込むかどうかは未決（2026-11-25）。
- **窓が見えているかを知る API がない（0.3.14）。** トレイへ隠すのはアプリ自身（`set_shown`）なので、その印でメーターを止めている（DESIGN.md 10.6）。最小化と、ほかの窓に覆われたときは分からず、計算を続ける。
- **`[patch.crates-io]` は依存先では効かない。** `src-tauri` の差し替え（`cpal`）は、別のワークスペースから `vst-host` を読むときには効かないので、`src-gpui/Cargo.toml` にも同じ差し替えを置く。
- **フォルダ型の `.vst3` はそのまま渡せない。** Tauri 版はスキャナーの `resolve_binary` で中の実体を探している。GPUI 側でも同じ関数を通す。
- **別の作業ツリーでは sidecar がない。** ignored の `src-tauri\bin` に `audio_engine-*.exe` が無いと Tauri の build script が止まる。元の作業ツリーからコピーする。
- **ビルド領域が大きい。** GPUI 一式（debug と release）で `src-tauri/target` が約 20 GB 増えた（2026-11-25）。新しい領域を作らず、`.cargo/config.toml` で `src-tauri/target` を共有する。
- **狭い窓では、状態が変わって文が増えると下が切れる。** 長い説明は読み上げの説明へ回し、見える文は短くする。
- **`gpui-component` の部品の既定はライト（`ThemeMode::Light`）。** 画面の地を暗く塗っても、ボタン・入力欄はライトの色のまま描かれる。`ghost` のボタンは暗い地に暗い文字になり、マウスを当てるまで見えなかった（2026-11-25）。`gpui_kit::init` の直後に `Theme::change(ThemeMode::Dark, None, cx)` を呼ぶ。地の色とテーマのモードは同じものから決める。
- **`ghost` のボタンは枠も地もなく、暗い地では文字だけに見える。** マウスを当てるまでボタンと分からなかった（2026-11-25）。押せることを見せたい操作は `outline` 以上にする。
- **`gpui_kit::assets::Assets` には Lucide の一部しか入っていない（0.11.0）。** `IconName` には全部の名前があるが、既定の組（`default-icons.txt`）に無いアイコン（`House`・`Cable` など）は、`Assets` だけでは何も描かれない。`icon_assets!` で使うものだけを足し、`Assets` と合わせた `AssetSource` を渡す（`src-gpui/src/assets.rs`）。全部入りの `AllAssets` は実行ファイルが大きくなる。
- **動きを減らす設定は、アプリが `cx.set_reduce_motion` で渡す。** gpui-pre 0.3.14 は OS の設定を読まない。渡せば `with_animation` は1回きりの動きを最後の状態で描き、`.loading()` の回る印も止まる。Windows は `SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION)`（`desktop::reduce_motion`、起動時に1回）。
- **タイトルバーの明暗は、GPUI が OS の明暗で塗る。** 窓を作るときと、Windows の明暗が変わったとき（`WM_SETTINGCHANGE` の `ImmersiveColorSet`、外観の知らせを呼んだ**あと**）に `DWMWA_USE_IMMERSIVE_DARK_MODE` を書く。テーマに合わせるには `MainView::new`・テーマの変更・`observe_window_appearance` の `on_next_frame` で書き直す（知らせの中で書いても上書きされる）。
