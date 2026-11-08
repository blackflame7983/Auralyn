# VST3 の複数エフェクトをクラス ID で扱う（Issue #450）

2026-11-08、`codex/vst3-class-id-450-20261108` でローカル実装した。実在の複数クラス入り VST3、音声機器、OBS、インストーラでは確認していない。

## 列挙対象と除外

スキャナーはプラグインを子プロセスで調べ、`createInstance` は呼ばない。列挙に成功しても、そのクラスを音声処理できる保証にはならない。

対象は category がちょうど `Audio Module Class` のクラスだけ。`IPluginFactory2` が使えるときは `getClassInfo2` の `subCategories` を `|` で区切り、トークンが `Instrument` で始まり `Fx` で始まらないものを楽器として除外する。`Fx|Instrument` は残す。`IPluginFactory2` が無く v1 の `getClassInfo` だけしかない場合は、楽器かどうかを決められないので残し、`kindKnown` を false にする。

同じ CID は最初の1件だけを残す。同じ表示名で CID が違うクラスは、そのまま別項目にする。

## 取得元と不明な値

`infoSource` は `classInfo2` または `classInfo`。固定長の文字列は NUL 終端までを読む。NUL が無い、または UTF-8 として不正な場合は lossy 変換し、取得元の区別は残す。空文字は JSON に出さない。`"0.0.0"` や `"Unknown"` は作らない。

画面では、メーカーまたはバージョンが空のとき「不明」と表示する。クラス名が無くファイル名を使った項目は「名前は取得できませんでした」と添える。

## スキャナー出力

成功時の1行 JSON は `formatVersion: 2`。項目は `path`、`success`、`error`、`factoryVendor`、`classes`。クラスが0件のときは `success: false` と `error: "対応するエフェクトがありません"`。この完了は exit 0 で返し、ホストはブラックリストへ入れない。ファイル不存在、DLL のロード失敗、factory 不在など、結果を読めない失敗は従来どおり exit 1 でブラックリスト対象にする。#451 が失敗理由を種別化する前提なので、今回の理由は文字列のままである。

`formatVersion` の無い旧1行出力も読む。そのときの名前はファイル名、`nameSource` は `file`、クラス ID は無い。旧出力の vendor `"Unknown"` と version `"0.0.0"` は不明として空にする。

ホストの一覧は1クラスを1件にする。識別子は path と classId。

## ロードと移行

`VstInstance::load` は `load_with_class(path, None)`。classId があるときは、その CID のクラスだけを `createInstance` する。見つからない、または生成できないときは別クラスへ移らず失敗する。classId が無い旧データは、従来どおり category に `audio module` または `fx` を含み、最初に生成できたクラスを開く。どちらの成功でも、実際に開いた CID をインスタンスと IPC 応答へ載せる。

旧データで、新しい列挙規則のエフェクト候補が2つ以上あるときは `legacyClassAmbiguous: true` を返す。画面は同じパスにつき1回、「このファイルには複数のエフェクトがあります。以前と同じ規則で最初のものを開きました」と表示する。別の製品へ置き換えない。列挙自体に失敗した未指定ロードは、従来の選択を続け、曖昧フラグは付けない。

保存した CID がそのファイルに無いときは「保存されたエフェクトがこのファイルにありません」。指定クラスの生成失敗は「指定したエフェクトを開けませんでした」。形式が違う ID は「VSTのクラスIDが不正です」。

`classId` は Preset、bundle、live-mode journal、post-mix、ラック、復元要求の任意項目。schema_version は上げていない。無い旧 JSON は読める。保存時、値が無い項目は出さない。`missing_vst_paths` はパスの存在確認のままで、CID がそのファイルにあるかは実ロードまで分からない。

## 検証

2026-11-08、この作業ツリーで実行した。

- `cargo test --locked --lib --bins`: lib は 727 件成功、5 件は ignore。各 bin の単体テストは 0 件で、コンパイルは成功した。
- `cargo check --locked --all-targets`: 成功。
- `cargo clippy --locked --all-targets -- -D warnings`: 成功。
- `npm test -- --run --maxWorkers=4`: 165 ファイル、1890 件成功。
- `npx tsc --noEmit`: 成功。
- `git diff --check`: 空白エラーなし。既存ファイルの改行が CRLF になるという Git の通知だけが出た。

実在の複数クラス入り VST3、音声機器、OBS、インストーラは確認していない。列挙の成功は、そのクラスを処理できることの確認ではない。
