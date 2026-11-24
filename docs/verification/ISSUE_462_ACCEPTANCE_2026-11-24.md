# #462 実機確認の記録（実際に落ちる・固まる VST での確認）

- 日付：2026-11-24
- 基点：main `56662ee5`（ブランチ `codex/vst-crash-462`）。場面 1〜5・7 は製品のコードを変える前に行った。観察 1 と 3 の一部は、確認の後に同じブランチで直した。場面 6 は、固まりの通知に VST の操作を付ける修正の後で確かめ直した。
- 目的：#477・#483・#484・#487 の実装が、模擬ではなく実際に落ちる VST で期待どおり働くかを確かめる。
- 確認の範囲：実アプリでの画面・ログ・保存状態の確認。実音・聴感・長時間運転の合格ではない。

## 使ったもの

| 項目 | 内容 |
|---|---|
| 試験用 VST | `src-tauri/examples/crash_vst3.rs`（「Auralyn Crash Test」）。release ビルド。組み立て方は [TESTING.md](../TESTING.md) の「落ちる・固まるVSTでの実機の確認（#462）」 |
| Host | debug ビルド。`npm run tauri -- dev --config src-tauri/tauri.debug-global.conf.json`、Tauri MCP CLI 0.13.2 で操作 |
| 音声エンジン | **release** の `audio_engine.exe`を `target\debug\audio_engine.exe` に写して使った。理由：今のソースの debug の子は、機器を開く `Start` で `thread 'main' has overflowed its stack` により落ちる（[TESTING.md](../TESTING.md) の W 群の注記、#829。この確認の初回にも再現した）。確認の後、元の debug の子へ戻した |
| 組み合わせ | ラックは「Acon Digital Limit」（ほかの VST の役）と試験用 VST。音声は WASAPI の既定の入出力で動かした |
| 利用者のデータ | `%APPDATA%\com.kuro7983.auralynhost`、`%LOCALAPPDATA%\com.kuro7983.auralynhost`（WebView の localStorage を含む）、`%LOCALAPPDATA%\Auralyn` を確認の前に退避し、終了後に元を消して写しを戻した。ファイル数・サイズ・更新時刻が一致（0 件の食い違い）。 |

## 場面ごとの結果

| # | 場面 | 結果 | 根拠 |
|---|---|---|---|
| 1 | `load` | 合格 | 音声を動かした状態で、flag `load` のまま試験用 VST を追加した。約 0.3 秒で音声エンジンが落ち、復旧画面に「停止直前に操作中だったVST（原因未確定）」と VST のパス、「Auralyn Crash Test.vst3の読み込みの途中で音声エンジンが停止しました。」が出た。「このVSTを除いて再試行」で音声が再開し、Limit が戻り、試験用 VST は入らなかった。ログ：`Audio engine exited: ExitPayload { cause: "vst_operation", op: Some("load"), path: Some(...), class_id: Some("524E1C7A…") }` |
| 2 | 復元の途中（`set_state`） | 合格 | 状態は 12 文字（8 バイト `AURALYN1`）を保存済み。flag `set_state` にしてアプリを終了し、起動し直した。自動の復元で落ち、操作は `restore`、「Auralyn Crash Test.vst3の復元の途中で音声エンジンが停止しました。」。「除いて再試行」で Limit が戻り、Home に「一部のVSTを復元できていません」「読み込めていないVST：Auralyn Crash Test」、VST ページにも同じ表示。保存セッション（localStorage）は Limit 456 文字・試験用 VST 12 文字のまま変わらず、自動保存は止まったまま。flag を消して「保存済みの並びを読み直す」で両方が戻った |
| 3 | `open_editor` | 合格 | 「Auralyn Crash Testの編集画面を開く操作の途中で音声エンジンが停止しました。」。ログは `op: Some("open_editor")` に `plugin_id`・`name` つき。「除いて再試行」で試験用 VST だけが外れた |
| 4 | `get_state` | 合格 | VST の行を操作して自動保存を起こすと落ち、「Auralyn Crash Testの状態の取得の途中で音声エンジンが停止しました。」。取得は VST ごとの要求なので VST が特定できる |
| 5a | `process`（音声が動いている間に VST を読み込む） | 合格（注あり） | 観測：`cause: "unknown"`、文言は「音声エンジンが停止しました。原因のVSTは特定できません。」。同じ画面に「停止直前に操作中だったVST（原因未確定）」として試験用 VST のパスも出た。推定：候補の出どころは、前回の終了の印（`vst_host_detected_crash_plugin`）か、読み込み・復元中の印（`vst_host_pending_plugin`）のどちらか。確認の時点のコードは前回の検出印を優先しており、どちらかは確定できていない（観察 3） |
| 5b | `process`（音声を止めてから開始） | 合格（注あり） | 開始の直後に落ちると、Host は機器の問題として扱う：`cause: "device_open"`、「機器を開く途中、または音声を始めた直後に停止しました。原因は確定していません。」。VST は名指しされない。ボタンは「機器を開かずに止めたままにする／別の機器を選ぶ／全セッションを再読み込み／保存済み構成を保持してVSTなしで再開」で、「このVSTを除いて再試行」はない。VST を断定しない点は期待どおり。除外はできない（観察 4） |
| 6 | `hang:open_editor`（固まり） | 合格（画面の表示は未実装） | 初回の確認（前回の印が残った状態）では、復旧画面に出た候補が古い印によるもので、固まりの通知自体は VST を含まなかった。そのため応答の期限切れの通知に、書き込み済みの VST の操作を付けた（`audio-engine-exited` → 旧の `audio-error`）。**確かめ直し**：`vst_host_detected_crash_plugin`・`vst_host_pending_plugin` がどちらも空であることを確かめてから固めた。編集を開く操作から約 6 秒で `Control stall: command=OpenEditor plugin_id=… module=Some("Auralyn Crash Test.vst3") elapsed_ms=5542` がエラーログに出て、約 25〜30 秒で `Force Killing Audio Engine`、続けて `Audio engine exited: ExitPayload { cause: "vst_operation", op: Some("open_editor"), plugin_id: Some(…), path: Some(…) }` が残った。復旧画面には「停止直前に操作中だったVST（原因未確定）」と試験用 VST のパス、「Auralyn Crash Testの編集画面を開く操作の途中で音声エンジンが停止しました。」が出て（「通信が切れました」ではない）、「このVSTを除いて再試行」で試験用 VST だけが外れた。6〜30 秒の間は画面に何も出ない（既知の制限 (c)） |
| 6b | `hang:get_state`（固まり） | 合格 | 両方の印を消してから固め、行の操作で自動保存を起こした。`Control stall: command=GetPluginState … module=Some("Auralyn Crash Test.vst3")` の後、`Audio engine exited: … op: Some("get_state") plugin_id: Some(…)`。復旧画面に「状態の取得の途中で音声エンジンが停止しました。」と除外ボタンが出た |
| 7 | 通常の終了と再起動 | 合格 | flag なしで `quit_app`。残るプロセスなし。再起動で音声が自動で始まり、復旧画面は出ず、ラック（Limit のみ → 後で Limit と試験用 VST）が復元された。復旧画面を出したまま終了して再起動した場合も、復旧画面は出なかった |

## 観察（期待どおりでない点・気づき）

1. 復旧画面の本文で「原因は確定していません。」と「停止の原因は確定していません。」が続けて2回出る（機器の終了の 5b を除く、VST の操作・不明な原因の場面）。**確認の後に直した**：後の文を消した。
2. `load` では Host が VST の表示名を持たないので、VST の名前の代わりに DLL の完全なパスを出す（本文は「Auralyn Crash Test.vst3の…」とファイル名）。復元・編集・状態の取得では名前が出る。
3. 5a で、文言「原因のVSTは特定できません」と「停止直前に操作中だったVST（原因未確定）」が同時に出る（観測）。候補の出どころは、前回の終了の印か、読み込み・復元中の印のどちらか（推定。確認の時点のコードは前回の検出印を優先していた）。読み込み・復元中の印による候補は無関係な VST を指す可能性があるが、未確認。**確認の後に、前回の印の側を直した**：前回の終了で検出した印（`vst_host_detected_crash_plugin`）は、復旧画面が閉じるときに画面ごと外れるため消えず、次に原因を特定できない終了で前回の VST が候補に出た。異常終了を受けるたびに、印を置き換える（候補がなければ消す）ようにした。読み込み・復元中の印による候補は、従来どおり「原因未確定」として出す。
4. 音声の開始直後に VST が落ちると「機器の問題」として扱われ、VST を除く操作が出ない（5b）。別の Issue で扱う。
5. 「VSTを追加」を開いた直後に「プラグイン一覧を取得できませんでした」が出て、「再試行」で解消する。別の Issue で扱う。

## 確かめていないこと

- 機器を開く途中の終了：この VST では起こせない。自動の試験だけ。
- `processing_setup`・`remove`・`resume` の実機での停止（試験用 VST には `processing_setup` の指定があるが、実機では確かめていない）。
- 保存状態の「内容」の一致：長さ（12 文字）と、除外の前後で変わらないことだけ。バイト列の一致は見ていない。
- release の Host、インストーラー、MSIX での確認。debug の Host と release の子の組み合わせだけ。
- 実音・聴感・長時間運転。確認は画面・ログ・保存状態のみ。
- 配信ミックスの子（`--post-mix-worker`）の中で落ちる場合。

## 既知の制限（利用者の決定。作らない）

- (b) 除外した VST を1本ずつ戻す画面は作らない。戻すのは「保存済みの並びを読み直す」（ラック全体）だけ。
- (c) 制御スレッドが固まった間（検出から切り離しまで、本確認で約 6〜30 秒）の画面の表示は作らない。記録はエラーログの `Control stall: command=… plugin_id=… module=…`（コマンド名・VST の id・止まった位置の DLL 名）だけ。DLL 名は止まった位置の DLL で、VST が眠って待っている間は `ntdll.dll` になる（試験用 VST を最初に眠らせた回は `ntdll.dll`、回り続ける作りに変えた後は VST の DLL 名）。固まりを切り離した後の通知は、書き込み済みの VST の操作があれば VST の操作として出す（6）。
