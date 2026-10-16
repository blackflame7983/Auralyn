# Clippy警告の動作を変えない限定修正

確認日: 2026-10-16。基準HEADは `ff75147`（PR #7マージ後）。開始時にfetchし、mainとorigin/mainの一致・未コミット変更なしを確認した。作業ブランチは `codex/clippy-behavior-preserving`。

## 修正範囲

Rustソース4ファイル、11箇所に限定した。

- `vst_host/instance.rs`、`vst_host/scanner.rs`、`vst_host/presets.rs`: `map_or(false, predicate)` 5箇所を `is_some_and(predicate)` に変更。Noneはfalse、Someは同じ述語を一度評価する。参照値を判定するため、所有物の解放順序も変更しない。拡張子・大小文字の条件は維持する。
- `audio_engine/editors.rs`、`vst_host/instance.rs`: 同じ型へのキャスト4箇所を除去。HWND・viewポインタと書き込みバイト数の値・型を維持する。
- `vst_host/instance.rs`: `sample_rate: sample_rate` を省略記法へ変更。渡す値は同一。
- `vst_host/scanner.rs`: Win32 Job設定のunit値の `let _ =` だけを除去。APIの実行と `.ok()?` による失敗時の早期returnは維持する。

DSP係数、音声コールバック・変換ループ、制御フローの統合、DLL寿命管理、公開関数の型、依存manifest / lockfile、アプリ番号、配布sidecarは変更しない。新規テスト・警告抑制・自動一括修正・一括整形は追加しない。

## ローカル検証

- `cargo test --locked --lib --bins --test audio_queue_contract`: 39 lib + 2 queueテスト成功。既存プリセット一覧・読込、矩形・音声境界・確保測定の回帰テストも含む。
- `cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの複数インスタンス、DLL共有寿命、状態保存、メモリ内の無音処理1件成功。実機ストリームは開始しない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json`: 成功。
- `cargo build --locked --bins`: 成功。最新debug sidecarでOTT（310×440）とTDR Nova（830×598）の描画を画像でも確認し、重複表示防止、開閉・再表示3回、リサイズ、表示中削除が成功した。検証用プロセスは終了した。
- Clippyは各診断の最初のprimary spanをコード・ファイル・行で重複除去して67 → 56箇所。除去はunnecessary_map_or 5、unnecessary_cast 4、redundant_field_names 1、let_unit_value 1。新規警告なし。
- `git diff --check`: 成功。対象4ファイルのrustfmt検査は既存5箇所で失敗する。今回変更した行には整形差分なし。既存未整形箇所は一括修正しない。

残る56箇所にはDefault、条件統合、引数数・型の複雑さ、DSPループ、浮動小数点精度、min/maxのclamp化などがある。今回の修正を実機音声・性能・全プラグインの保証とは扱わない。
実機WASAPI / ASIO、音質・CPU・遅延・長時間運転、高DPI、全VST、署名済み配布は未検証。システム全体のVST再スキャンは行わず、既存設定・ブラックリストを保持した。

ログはignoredの `src-tauri/target/clippy-style-*` に保存する。commit・push・PR作成は行わない。

## 差分レビュー（2026-10-16）

レビュー用ブランチは `codex/review-clippy-style`。11箇所を基準HEADと照合し、追加のコード修正を要する動作変更・回帰は見つからなかった。

- Optionの5箇所はいずれも参照を含むOptionを消費する。Noneはfalse、Someは同じ述語を一度だけ評価する。拡張子の欠損・空文字・大小文字、read_dirのErrをfalseとして読み飛ばす条件は同一。述語の評価順と一時PathBufの使用も維持する。
- HWND内部・view_ptrはともに `*mut c_void`。除去したキャストでアドレスや可変性は変わらない。LEのquery_interface失敗時にBEを試す順序と、取得したインターフェースのreleaseも変更していない。
- stream_writeのnum_bytesと書き込み先はi32、prepare_processingのsample_rateとProcessSetupのフィールドはf64。キャスト除去・省略記法による数値変換はない。
- 使用中のwindows 0.62.2の定義でもSetInformationJobObjectはResult<()>を返す。API呼出し → .ok()? → 成功時だけSome(Self(job))の順序は同一。削除した束縛はunitであり、独自のDrop処理はない。

ローカル照合では、元の4ファイルへ承認範囲の11置換だけを適用した内容と現在のソースが一致すること、追跡ファイルの差分範囲、`git diff --check`を確認した。上記の同一Rust差分に対するテスト42件・check・Clippy・build・GUI成功ログを再確認し、警告67 → 56も再集計した。コード変更や新しい懸念がないため、同一テスト・ビルド・GUIの反復は行っていない。既存の整形問題と実機等の未検証範囲は上記のとおり。

## 残存警告の調査と初期化整理（2026-10-16）

基準HEADは `c604c12`（PR #8マージ後）。fetch後にmainとorigin/mainの一致、未コミット変更なしを確認し、`codex/clippy-maintenance`で調査・対応した。最新Clippyは56箇所だった。

### 今回対応した12箇所

- AudioHost・Engine・DeviceManager・EditorManager・PluginManager・VoiceCheckShared・ObsStateに、既存のnew()へ委譲するDefaultを追加した。既存の呼出側とnew()の本体は変更しない。Engineの音声設定、VoiceCheckSharedの48kHz・processed初期値、PluginManagerの32スロットなども維持する。自動的に音声ストリーム・OBS接続を開始する変更はない。
- EngineTuningConfigとAnalysisContextのDefaultをderiveへ移した。フィールド既定値は従来どおりfalse／Noneで、serde属性は変更しない。音声解析関数・DSP係数は変更しない。
- sidecarの最初の4候補をvec!でまとめた。探索するパスと順序、debug限定の追加候補は維持する。非RTの初期化処理であり、RT上の確保には変更がない。Vecの構築方法の変更で、内部の確保手順まで同一とは扱わない。
- デバイス未検出時の固定文をformat!からto_stringへ変更した。文面・改行・条件は維持する。
- PluginManagerの既存テストモジュールを末尾へ移した。テストの内容・可視性は変更しない。

### 残る44箇所の分類と次の判断

| 分類 | 箇所数 | 方針 |
| --- | ---: | --- |
| 条件分岐 | 15 | collapsible_if 6、collapsible_else_if 3、collapsible_match 2、redundant_pattern_matching 2、single_match 2。まずIPC・OBSなど非RT側を対象とし、式の評価回数・Dropタイミング・失敗時の処理順を確認する。DSP条件の統合は別途扱う。 |
| ループ・数値処理 | 21 | needless_range_loop 17、excessive_precision・manual_clamp・inconsistent_digit_grouping・implicit_saturating_subが各1。短いバッファ、NaN、丸め、係数、RT性能への影響を確認してから個別判断する。今回変更しない。 |
| API・型 | 6 | too_many_arguments 3、type_complexity 2、ptr_arg 1。型別名や引数の整理は契約・呼出側を確認し、警告を消すだけの大きなAPI変更を避ける。 |
| IPC行・接頭辞解析 | 2 | manual_flatten・manual_stripが各1。sidecar stdoutの読み取り失敗後の継続、IPC:接頭辞・Unicode境界を確認する。デバイス名解析という当初の分類は誤りだったため訂正した。 |

### 今回のローカル検証

- `cargo test --locked --lib --bins --test audio_queue_contract`: 39 lib + 2 queueテスト成功。
- `cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの寿命・状態保存・メモリ内無音処理1件成功。実機ストリームは開始しない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json`、`cargo build --locked --bins`: 成功。
- Clippyは最初のprimary spanをコード・ファイル・行で重複除去して56 → 44。new_without_default 7、derivable_impls 2、vec_init_then_push・useless_format・items_after_test_moduleが各1減少。行移動による差分を除き、コード・ファイルごとの警告数にも増加なし。
- 7型のnew()本体が基準HEADと一致すること、core・devices・editors・voice_check・obsはDefault追加以外に差分がないこと、audio_analysisの解析関数以下が完全一致することをソース照合で確認した。
- `git diff --check`成功。対象ファイルの全体rustfmt検査は既存の未整形箇所で失敗する。rustfmtの提案行と今回追加・変更した行に重複がないことを確認し、一括整形は行わない。

今回のログはignoredの `src-tauri/target/clippy-maintenance-*` に保存する。GUIの再操作、OBS接続、システム全体のデバイス・VST探索、実機WASAPI / ASIO、音質・CPU・遅延・長時間運転、高DPI、全VST、署名配布は未検証。依存・配布sidecar・アプリ番号の変更、commit・push・PR作成は行わない。

### 初期化・探索順・文面の差分レビュー（2026-10-16）

`codex/review-clippy-maintenance`で基準HEADと照合し、追加のコード修正を要する初期値・探索順・文面の変更は見つからなかった。

- 7型のnew()本体が基準HEADと一致し、追加したDefaultはSelf::new()だけへ委譲している。既存呼出側は変更しない。DeviceManager・EditorManager・ObsStateの生成でデバイス列挙・ウィンドウ作成・OBS接続が新たに始まる処理はない。
- derive化したEngineTuningConfigはbool 3フィールドのfalseとaffinity_maskのNone、AnalysisContextはbuffer_sizeのNoneを維持する。serde属性や解析処理は変更しない。
- 先頭候補は、実行ファイル隣のaudio_engine.exe → ns-audio-engine.exe → bin/audio_engine.exe → bin/ns-audio-engine.exeの順で同一。debug限定の追加、suffix候補の探索、existsで最初を選択する処理、spawn以降の本体も基準HEADと一致する。Vecの内部確保手順は異なり得るが、非RTの初期化であり、探索の条件・優先順位の変更ではない。
- デバイス未検出メッセージのRust文字列リテラルは改行・エスケープを含め完全一致し、format!の置換指定も含まない。to_string化で表示内容は変わらない。
- 末尾へ移したテストモジュールの内容も一致する。

上記のソース照合と `git diff --check` を今回実行し、結果をignoredの `src-tauri/target/clippy-maintenance-review-equivalence.log` に保存した。同じRust差分のテスト42件、check・Clippy・buildの成功ログを確認し、警告44箇所も再集計した。ソースの追加修正や新たな懸念がないため、同一テスト・ビルドは反復していない。配布版レイアウトでの実起動、実機音声等の未検証範囲と既存の整形問題は引き続き残る。

## 非RT条件分岐・IPC行解析の限定修正（2026-10-16）

基準HEADは `1cb76c8`（PR #9マージ後）。fetch後にmainとorigin/mainの一致・未コミット変更なしを確認した。作業ブランチは `codex/clippy-non-rt-branches`。

再調査により、前回「デバイス名解析2件」としたmanual_flatten・manual_stripは、実際にはaudio.rsのsidecar stdout受信処理にあると判明した。デバイス名照合には該当警告がないため、devices.rsの名前・重複番号・prefix照合は変更しない。前回の分類表も訂正した。

### 対応した8箇所

- sidecar stdoutの `if let Ok(l)` をlet-elseによるcontinueへ変更。読み取り失敗後は同じ反復末尾でエラーを解放し、次のreadを試す。最初のエラーで打ち切るmap_whileや、linesへのflattenは使用しない。空行の読み飛ばし、JSON振り分け、Mutex取得、イベント通知、EOF後のクラッシュ通知・待機解除は維持する。差分の多くは既存ハンドラのインデント移動である。
- `starts_with("IPC:")` と固定バイトsliceを `strip_prefix("IPC:")` へ変更。先頭だけに一致し、成功時は従来と同じ借用sliceを使う。rawログへの振り分け・エラー表示に使う元のStringは保持する。
- OBSイベント監視の単一matchをif letへ変更。既存の名前付きeventから同じnameを移し、同じ順でログ・emitを実行する。他のイベントは従来どおり無視する。
- ホットキーのPressed判定とALT+M照合を `&&` で統合。Pressed時だけmatchesを1回呼ぶ。両条件はboolで所有値のDropを伴わない。内部のstate取得・Mutex guard・mute呼出しは変更しない。
- 診断CLIの3つのデバイス情報取得closureのelse内if letをelse ifへ変更。入力時は入力API、出力時は出力APIをそれぞれ1回だけ呼び、失敗時の空文字／None／0は維持する。
- 同CLIのSupportedBufferSizeの単一matchをif letへ変更。借用したRangeのmin/max更新順、Unknownの読み飛ばしは同一。音声の開始・設定処理は変更しない。

### ローカル検証

- `cargo test --locked --lib --bins --test audio_queue_contract`: 39 lib + 2 queueテスト成功。
- `cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの寿命・状態保存・メモリ内無音処理1件成功。実機ストリームは開始しない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json`、`cargo build --locked --bins`: 成功。
- Clippyは最初のprimary spanをコード・ファイル・行で重複除去して44 → 36。manual_flatten・manual_strip各1、single_match 2、collapsible_if 1、collapsible_else_if 3を解消。行移動を除いたコード・ファイル別集計でも新規増加なし。
- ignoredの隔離Rust probeへ基準HEADと修正ソースの該当処理を抽出し、入出力・副作用の記録を比較した。IPCは2回の読み取り失敗、空行、CRLF、部分・先頭以外のprefix、Unicode、空payload、raw行についてread回数・エラーDrop順・振り分けが一致。JSON dispatch部分は記録用stubへ置換しており、本体が不変であることを別途ソース照合した。
- デバイス情報closureは模擬デバイスで入力／出力・各APIの成功／失敗の8通りを比較し、戻り値、3つのAPI呼出し、config・errorのDrop順が一致した。OBS dispatchも模擬イベント・emitで対象／対象外と成功／失敗を比較し、送信回数・payload・errorのDrop順が一致した。実CPALドライバや実OBSへの接続検証ではない。
- `git diff --check`成功。変更行はrustfmt相当へ揃えた。全体に残る既存の未整形箇所は一括修正しない。

残る36箇所は条件分岐9、ループ・数値処理21、API・型6。DSP・RT処理内の条件や、エンジン開始に関わる条件は今回対象外とした。DSP係数・音声処理、デバイス名照合、依存manifest / lockfile、配布sidecar、アプリ番号は変更しない。

ログ・隔離probeのソースと結果はignoredの `src-tauri/target/clippy-non-rt-*` に保存する。実OBS接続・通知、実ホットキー操作、実機デバイス列挙・WASAPI / ASIO、実アプリ全体のIPC、GUI、高DPI、長時間・音質・CPU・遅延、署名配布は未検証。commit・push・PR作成は行わない。

### 非RT分岐・失敗経路の差分レビュー（2026-10-16）

`codex/review-clippy-non-rt`で差分と周辺を確認し、追加の製品コード修正を要する評価回数・Dropタイミング・失敗時の処理順の変更は見つからなかった。

- IPCの失敗したResult内のエラーは、従来の反復末尾とlet-elseのcontinueのどちらでも、次のread前に解放する。成功時のStringも、従来のifブロック末尾と新しいfor本体末尾の間に別処理がないため、次の反復・EOF後処理に対する解放順は同じ。strip_prefixの結果は借用であり、所有値の解放は追加しない。
- JSON dispatch部分は文字列リテラルを保持したtoken照合で一致し、ログ・応答・通知とMutex guardのスコープは変わらない。EOF後のクラッシュ通知・待機解除を含むファイル末尾も基準HEADと一致する。
- OBSは名前付きeventを同じスコープで処理し、nameの移動とemit結果の破棄は同一。診断CLIでは成功したiteratorを同じextendへ渡し、失敗値の破棄から次の処理までに別処理が入らない。BufferSize判定は借用である。
- ホットキーは2つのbool判定だけを統合し、Pressedでない場合はmatchesを呼ばない。内部のstate・Mutex・mute処理はtoken照合で一致する。

追加の隔離Rust検証では、現在ソースと基準HEADからIPC loopを抽出し、空入力、エラーのみ、連続エラー、成功とエラーの混在、Unicode等の5系列を比較した。read回数、エラーDrop順、Reader破棄からloop後への順序が一致した。実際のstd::io::Cursorに不正UTF-8行と正常IPC行を渡す比較でも、エラー後の正常行処理が一致した。JSON dispatchは引き続き記録用stubであり、実アプリ全体のIPC検証ではない。

ホットキー分岐も現在ソースと基準HEADから抽出し、Pressed／キー一致／state有無／lock成否／mute成否の32通りを模擬オブジェクトで比較した。matches・state・lock・muteの呼出し回数、guard・state・errorのDrop順が一致した。既存のデバイスprobeが現在のclosureを対象としていることも照合した。

結果はignoredの `src-tauri/target/clippy-non-rt-review-{io,hotkey}.{rs,log}` とexeに保存する。`git diff --check`成功。同一Rust差分のテスト42件・check・Clippy・build成功ログと警告36箇所を再確認した。製品コードに追加修正や新たな懸念がないため、同一テスト・ビルドは反復していない。実OBS・実ホットキー・実ドライバ・アプリ全体のIPC等の未検証範囲、既存の整形問題は上記のとおり。

## API・型の限定整理（2026-10-16）

基準HEADは `ffcc02e`（PR #10マージ後）。fetch後にmainとorigin/mainの一致・未コミット変更なしを確認した。作業ブランチは `codex/clippy-api-types`。最新Clippyの36箇所のうち、API・型関連は6箇所だった。

### 修正した2箇所と呼出側への影響

診断CLIのscan_devices内だけで使う `RawDeviceScanEntry` を追加し、入力・出力のraw_itemsの型注釈を共通化した。別名の実体は従来と同じ `(String, String, Option<(u32, u32)>, u16, bool)` で、名前、レート表示、バッファ範囲、チャンネル数、既定フラグの順を維持する。

新しいstructや公開型にはせず、所有権・Drop・メモリ上の型・Vec操作は同一。push、分解、重複番号の付与、DeviceInfoへの変換・serde定義・JSON出力、各APIの評価順は変更しない。型別名の宣言を除き、2つの型注釈を展開するとファイル全体が基準HEADと完全一致することを照合した。外部の呼出側には変更を要求しない。

### 既存契約を維持するため残した4箇所

| 箇所 | 警告 | 保留した理由 |
| --- | --- | --- |
| Blacklist::new | ptr_arg | scannerとTauriホストの2呼出側を確認。通常の呼出しではPathへの一般化が可能だが、公開関数の `fn(&PathBuf) -> Self` という型まで同一にはならない。既存シグネチャを維持する条件で今回は変更しない。 |
| profile::apply_profile | too_many_arguments | Tauriのプロファイル適用・バックアップ復元から呼ばれる公開Rust関数。引数を束ねる場合は既存呼出契約への別判断が必要。 |
| Tauri apply_profileコマンド | too_many_arguments | フロントのinvokeと既存テストでも名前付きpayloadを使用する。引数オブジェクト化によるJSON契約の変更を混ぜない。 |
| generate_advices | too_many_arguments | 私有関数で呼出側は解析モジュール内の1箇所だが、解析結果の助言生成に関わる。音声解析側へ今回の整理を広げない。 |

警告の抑制や、型名で警告を隠すだけの公開引数の変更は行わない。DSP係数・音声処理、既存関数のシグネチャ、Tauriコマンドのpayload、依存・アプリ番号・配布sidecarは変更しない。

### ローカル検証

- `cargo test --locked --lib --bins --test audio_queue_contract`: 39 lib + 2 queueテスト成功。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json`、`cargo build --locked --bins`: 成功。
- Clippyは最初のprimary spanをコード・ファイル・行で重複除去して36 → 34。type_complexity 2箇所を解消し、コード・ファイル別の警告数にも新規増加なし。残りは条件分岐9、ループ・数値処理21、API・型4。
- `git diff --check`成功。対象ファイルの全体rustfmt検査は既存の2つのlog::debug書式で失敗する。今回変更した型注釈・宣言には整形差分なし。一括整形は含めない。

ログはignoredの `src-tauri/target/clippy-api-types-*` に保存する。実機デバイス列挙、実ドライバの診断JSON、GUI・実アプリ全体のIPC、実機音声・性能・高DPI・署名配布は未検証。音声/VST実装の差分がないため、実OTT寿命テストの再実行は行わない。commit・push・PR作成は行わない。

### 型別名の差分レビュー（2026-10-16）

`codex/review-clippy-api-types`で差分と使用箇所を確認し、追加修正が必要な型・所有権・Drop・JSON・既存APIの変更は見つからなかった。

- RawDeviceScanEntryはscan_devices内の型別名であり、新しい所有型・struct・ラッパーではない。別名の実体は従来の5要素タプルそのもの。String、Option、Vecの型・所有権は同一で、追加のclone・borrow・変換・割当・Drop処理はない。
- 型別名の宣言とコメントを除き、2つの型注釈を展開すると、ファイル全体が基準HEADと完全一致した。既存のpush・分解・move・スコープも不変であり、Dropタイミングを変える差分はない。
- JSONは従来のDeviceInfoを構築してserde_json::to_stringする。DeviceInfoのフィールド型・順序・deriveと、値の設定・重複名処理・最後のJSON出力はすべて同一。型別名を直接シリアライズする変更ではない。実機デバイスを列挙してのJSON比較は行っていない。
- 別名は外部へ公開せず、公開関数・Tauriコマンドのシグネチャと呼出側も変更していない。API関連の保留4箇所はそのままとする。

今回、完全一致のソース照合と `git diff --check` を実行した。照合結果はignoredの `src-tauri/target/clippy-api-types-review-equivalence.log` に保存する。同一Rust差分のテスト41件・check・Clippy・build成功ログを確認し、警告34箇所も再集計した。追加コード修正や新たな懸念がないため、同一テスト・ビルドの反復、新規の実装をなぞるテストは行わない。既存の整形問題と実機等の未検証範囲は上記のとおり。

## 残る警告のまとめ対応（2026-10-16）

基準HEADは `76f5355`（PR #11マージ後）。fetch後にmainとorigin/mainの一致・未コミット変更なしを確認した。依頼に合わせ、`codex/clippy-remaining`の1ブランチ内で段階的に対応した。

### 34箇所から0件への内訳

実装・テストコードの修正で31箇所を解消し、公開契約を維持する3箇所には理由付きの個別 `#[expect]` を付けた。34箇所すべてをAPI変更で解消したわけではない。全体のallowやClippy設定の緩和は行わず、`-D warnings`で個別expectの不成立も検出する。

- 条件分岐は短絡評価の順番を維持して統合した。出力configの検索結果は名前付き束縛に保持し、従来の分岐末尾まで寿命を維持する。IPCテストのResponseパターンも同じ受信処理へ渡す。
- RTループは借用スライス・iteratorへ置き換え、サンプル順・チャンネル順・各DSPの呼出回数と演算式を維持した。ゲインはフレームを外側に保ち、smoother.nextは1フレーム1回。退役キューは同じ順に走査し、満杯時は同じslotへ戻してbreakする。
- スライスの範囲は、既存のchannels／max_chと事前確保したバッファ長、framesの上限、rt_order_lenの上限に基づく。zipの両側を同じframesに限定した。内部不変条件が破れた場合のpanic位置まで同一とは主張しない。
- リサンプル後のinterleaveはフレームを外側・チャンネルを内側に維持した。VST入力のdeinterleaveは元のinput_idxと不足入力のゼロ補完を維持した。
- jitterの非負減算をsaturating_subへ置換。解析の助言生成は私有AdviceInputsへ引数を束ね、公開レポート・JSON・APIは変更しない。clip助言のclampは元のNaN→12.0を明示して維持した。
- 過剰精度の定数変更はテストのノイズ生成だけで、f32のビット列は元と同じ `0x472aee8c`。本番DSP係数・DSP実装、依存・lockfile・配布sidecar・アプリ番号は変更しない。

互換性の個別例外は、`Blacklist::new`のptr_arg（公開 `fn(&PathBuf) -> Self`）、公開Rust関数 `profile::apply_profile`のtoo_many_arguments、Tauri `apply_profile`コマンドのtoo_many_arguments（名前付きinvoke payloadと注入引数）の3箇所。既存シグネチャと呼出側をそのまま維持する。以前の限定整理で保留した私有generate_advicesは今回の対象に含めた。

### ローカル検証

- `cargo clippy --locked --all-targets --message-format=json -- -D warnings`: 成功、警告0件。
- `cargo test --locked --lib --bins --test audio_queue_contract`: lib 42件とqueue 2件成功。NaN・無限大・境界値、多チャンネルの順序と分割入力、VSTの短い入力と割当なしの回帰確認を追加した。
- `cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの寿命・状態保存・メモリ内無音処理1件成功。合計45テスト成功。
- `cargo check --locked --all-targets`、`cargo build --locked --bins`、`git diff --check`: 成功。実機ストリームを開始するintegration_testとrepro_ottはコンパイルのみで実行しない。
- ignoredの差分比較probeへ基準HEADと現在ソースの対象ループ、および実DSP・Smootherの定義を抽出した。DSP定義自体が不変であることも照合した。実nnnoiselessを用いた128条件（レート、チャンネル、モード、フラグ、連続ブロック）の出力ビット列と呼出回数が一致し、ウォームアップ後の対象処理の確保・解放は0回だった。clip助言は100万通りのf32ビットパターンでも旧式と一致した。
- 退役キューは模擬backpressureの198条件を各2回flushし、送信順・保持slot・退役値をDropしないことが一致した。ゲインは16条件で出力ビット列・smootherの進行回数と状態が一致した。両probeで対象処理の確保・解放は0回だった。実CPALコールバック全体の性能計測ではない。
- 最終ビルドのaudio_engineで実OTT（310×440）とTDR Nova（830×598）の画像を確認した。各3回の開閉、二重ウィンドウ防止、884×661へのサイズ変更、表示中アンロード、応答継続が成功した。音声Startコマンドは送信していない。

### 既存課題と未検証範囲

差分比較中、DSPライブラリの初回処理に遅延初期化による割当を検出した。修正前後を別プロセスで測ると、どちらも確保50回・解放5回、出力ハッシュとnoise／voice各480回の呼出しが一致した。今回の変更で増加はないが、コールド開始時もRT無割当を満たすとは言えない。実処理状態を進めるwarmupは初期音声を変え得るため、今回混ぜず別途検討する。

追記（差分レビュー時）: 入出力レートが異なる場合に入力コールバックから呼ばれるStreamResampler::processにも、以前から出力Vecの確保・解放がある。下記の実ソース比較では修正前後の回数が一致した。ウォームアップ後の無割当という結果は上記のDSP・退役・ゲインの対象処理に限り、音声コールバック全体の無割当を示すものではない。

全体rustfmt検査には従来からの未整形箇所が残るため、変更箇所だけを整えた。実機WASAPI／ASIOのストリーム、実音声の音質・CPU・遅延・長時間動作、高DPI、インストーラ・署名配布は未検証。ライブラリの大幅移行やDSP係数の変更は含めない。

ログ・比較probeはignoredの `src-tauri/target/clippy-remaining-*`、GUIログ・画像は `src-tauri/target/clippy-remaining-editor/` に保存する。この段階ではcommit・push・PR作成を行わない。

### 全差分のレビュー（2026-10-16）

同じ `codex/clippy-remaining` で基準HEAD・現在の全差分と周辺の生成・更新・解放経路を確認した。追加の製品コード修正を要する順序・所有権・出力の変化は見つからなかった。上記の入力リサンプラーの既存割当を、検証範囲の不足として追記した。

- planarバッファはコールバック開始前にchannels.max(2)本を最大frames分確保し、コールバック内でリサイズしていない。ゼロchannels／framesは早期returnする。rt_order_lenは初期化・ReorderProcessorsのどちらもMAX_PLUGINS以下に制限し、削除時は縮める。新しいスライス・zipはこの範囲内で、フレーム順・左右順・プラグイン順と処理回数を維持する。
- iterator・zip・split_at_mutは既存バッファの借用だけで、所有値を生成・移動・解放しない。退役失敗時のOptionはtake後のNoneへ同じ値を戻す。受理したprocessorの移動先とスコープも同一。なおAddProcessorの無効index／重複slot拒否時は従来からprocessorがRT側でDropされる経路であり、今回その挙動を変更していない。通常のindexはPluginManagerが空きslotから割り当て、アンロード完了まで再利用しない。異常な内部メッセージまでRT Dropなしを保証する変更ではない。
- AdviceInputsは借用とCopyのf32のみで、ヒープ割当・独自Dropはない。引数構築の評価順も同じ。3つの例外属性を除去すると、lib.rs・profile.rs・blacklist.rsは基準HEADと空白以外も含めたtoken比較で一致した。Tauriのpayload名、公開Rust関数の引数、Blacklistの関数型、各呼出側の変更はない。一般化や引数オブジェクト化は別のAPI変更となるため、今回の理由付きexpectは妥当と判断した。

追加のローカル検証では、基準HEADと現在のaudio_analysis.rs全体を別モジュールとして同時コンパイルし、44.1k／48k、空・短い・端数・長い入力、6種の信号、3種のbuffer設定による216条件でQualityReportのJSON文字列全体が一致した。レートが異なる実StreamResamplerの旧／新実装も同時コンパイルし、1／2／4ch・連続する36ブロックでサンプルのビット列と確保・解放回数が一致した。例として48k→44.1k・2chの当該系列では1024入力フレームで確保4回・解放3回、4096で確保15回・解放14回。戻り値のVecの破棄は計測区間外であり、これらはコールバック全体の回数ではない。

config探索71条件、所有値を含むIPC送信の成功／失敗2条件、AddProcessorの全u8 index×slot空き／使用中の512条件は、実ソースから分岐を抽出して模擬値で比較し、評価とDropのtraceが一致した。実CPAL・実VSTオブジェクトの異常メッセージ検証ではない。

DSP・Smootherの定義と、旧／新のmono／stereoループ・退役・ゲイン処理が既存probeと一致することを再照合してからprobeを再実行した。128条件のDSP出力・回数・warm時無割当、退役198条件とゲイン16条件、100万通りのclamp比較が成功した。独立プロセスのcold比較も確保50回・解放5回、同一出力ハッシュ・呼出回数で一致した。

結果と再現用コードはignoredの `src-tauri/target/clippy-remaining-review*` に保存する。同一製品コードの45テスト・strict Clippy警告0・check・build・GUI成功ログを再確認した。製品コードを追加変更していないため、それらの一括再実行は行っていない。`git diff --check`は今回も成功。DSP係数・音声処理の仕様は変更せず、commit・push・PR作成は行わない。実機音声・性能等の未検証範囲と既存のRT制約は上記のとおり。
