# GPUI の知見

GPUI で画面を書くときに、試作（`prototypes/gpui-safety-column/`）で確かめた書き方と落とし穴。
理由つきの決定は [decisions.md](decisions.md)、合否の証拠は [gpui-prototype-checklist.md](../plans/gpui-prototype-checklist.md) にある。
ここに書いた内容も、使う版（`AGENTS.md` の基準）が変わったら依存クレートのソースで確かめ直す。

## 版

- GPUI Kit 0.11.0。中身は `gpui-pre` 0.3.14 と `gpui-component` 0.11.0（`prototypes/gpui-safety-column/Cargo.lock`）。
- Zed 本体の `gpui` や、ほかの版の `gpui-component` の API とは名前と引数が違うことがある。例や記憶ではなく、`~/.cargo/registry/src/` にある上の版のソースで確かめる。

## 書き方

| 場面 | 書き方 | 場所 |
| :--- | :--- | :--- |
| 描画の周期 | 16ms の周期を1つだけ `cx.spawn_in` で持ち、全メーターで共有する。変化があったときだけ `cx.notify()` | `view.rs` の `tick` |
| 音声エンジン | `AudioHost` の命令は応答を待つので、画面のスレッドで呼ばない。専用のスレッドで受付順に実行し、続けて届いた音量は最後の値だけを送る | `engine.rs` |
| メーターの値 | 届くたびに画面へ送らず、最新の値だけを置く。画面が周期で読む | `engine.rs`、`view.rs` |
| 色 | 値を書かず、`auralyn_core::design::tokens()` から名前で取り、`rgb(..)` で `Hsla` にする。使う名前は試験で確かめる | `view.rs` の `mod color` |
| 振る舞いの規則 | 平滑化・保持・判定のような規則は GPUI に依存しないクレートに置き、時刻を引数で受けて試験する | `prototypes/auralyn-ui-model/` |
| スライダー | `SliderState` を `cx.new` で持ち、`cx.subscribe` で `SliderEvent::Change` と `Release` を受ける | `view.rs` の `new` |
| 読み上げ | 操作する要素に `.id(..)` と `.role(Role::..)` を付ける。ナレーターでの合格は AccessKit（UIA）による | `view.rs` |
| トレイとホットキー | `tray-icon` と `global-hotkey` は GPUI の主スレッドで作り、周期の中で `poll` する。登録の失敗は画面とログに出す | `desktop.rs` |
| 日本語入力 | GPUI Kit の `Input` / `InputState` を使う。自前の文字入力は作らない | `view.rs` |

## 落とし穴

- **窓が見えているかを知る API がない（0.3.14）。** DESIGN.md 10.6 の「窓が隠れている間はメーターを止める」は、まだ満たせていない。
- **`[patch.crates-io]` は依存先では効かない。** `src-tauri` の差し替え（`cpal`）は、別のワークスペースから `vst-host` を読むときには効かないので、試作の `Cargo.toml` にも同じ差し替えを置く。
- **フォルダ型の `.vst3` はそのまま渡せない。** Tauri 版はスキャナーの `resolve_binary` で中の実体を探している。GPUI 側でも同じ関数を通す。
- **別の作業ツリーでは sidecar がない。** ignored の `src-tauri\bin` に `audio_engine-*.exe` が無いと Tauri の build script が止まる。元の作業ツリーからコピーする。
- **ビルド領域が大きい。** GPUI 一式（debug と release）で `src-tauri/target` が約 20 GB 増えた（2026-11-25）。新しい領域を作らず、`.cargo/config.toml` で `src-tauri/target` を共有する。
- **狭い窓では、状態が変わって文が増えると下が切れる。** 長い説明は読み上げの説明へ回し、見える文は短くする。
- **`gpui-component` の部品の既定はライト（`ThemeMode::Light`）。** 画面の地を暗く塗っても、ボタン・入力欄はライトの色のまま描かれる。`ghost` のボタンは暗い地に暗い文字になり、マウスを当てるまで見えなかった（2026-11-25）。`gpui_kit::init` の直後に `Theme::change(ThemeMode::Dark, None, cx)` を呼ぶ。地の色とテーマのモードは同じものから決める。
