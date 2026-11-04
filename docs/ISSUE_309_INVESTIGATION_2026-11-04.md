# #309 保存設定の調査と復帰確認

2026-11-04。ベース`2b3fef1`、作業ブランチ`codex/issue-309-persistence-20261104`。
関連する#289のVoicemeeter開始失敗も、利用者の許可を得て専用の保存先・全体ミュートで再現した。

## 分かったこと

1. **48 kHzからの再試行でサイドカーが落ちていた。** Voicemeeter Insert Virtual ASIOへ48 kHz・512フレームを要求すると、入力buildが`sample clock or rate cannot be determined or is not present`で失敗した。既定の96 kHzへ再試行した後、`thread 'main' ... has overflowed its stack`で終了した。96 kHz・512を最初から要求すると成功した。
2. **初回失敗後のファイル不在は、削除なしで再現する。** `last_audio_config.json`を書き込むのは、Hostが検証済み`Started`応答を受けた後。設定画面のWebView保存も開始成功後である。未設定から失敗した場合は、どちらにも正常設定がまだ存在しない。ボタンを押したこと自体は保存成功を意味しなかった。
3. **既存の正常設定は、再現したクラッシュ後も残った。** 96 kHzで成功させて作成したファイルは、次に48 kHzで実際のスタックオーバーフローを起こしても、バイトのハッシュが一致した。Hostの保存済み設定取得も旧96 kHzを返した。
4. **ファイルが残っていても、画面が未設定になる経路があった。** 起動時の画面はWebViewの`vst_host_audio_config`を読み、停止中のネイティブ保存設定を表示へ戻していなかった。WebViewの値がない／壊れた条件では、保存ファイルの不在とは別に「音声未設定」になり得た。

Issueに記載された「18:24に通常版のフォルダーが空だった」という過去の観察そのものは、当時の保存先・ファイル履歴がないため断定しない。今回確認した通常版のファイルは268 bytes、更新日時2026-10-31 15:09:27で、調査前後のハッシュが一致した。再現条件では「開始失敗が旧正常設定を削除した」という結果にはならなかった。

動作中の通常Hostへの読み取りでも、`app_config_dir`は`%APPDATA%/com.kuro7983.auralynhost`、WebView originは`http://localhost:1420`、画面側の保存hostはnullだった。ネイティブファイルとWebView保存の片方だけが残る状態を、試験fixture以外でも確認した。通常Hostには音声・設定の変更要求を送っていない。

## 修正

- ストリーム構築の再試行を再帰から反復へ変更。callback準備を含む大きなスタックフレームから戻ってから次の試行を行う。既存の再試行回数、機器・streamの解放順、レート・バッファの選択方針は維持する。試行関数のinlineを抑止し、フレームが重ならない境界を保つ。
- WebViewの接続設定が読めない場合は、同じアプリのネイティブ保存設定を検証し、画面へ復帰して設定を開く。機器選択も復帰したID・レート・バッファを利用する。
- 起動時に復帰した値は表示用として扱い、WebView保存・Start・移行確認完了を行わない。既存のHost側の起動gateを維持し、新しい自動開始要求には利用しない。移行・一時利用の確認待ちでも同じ制約を保つ。
- 読み込み中の手動保存を古い設定で上書きしない。ネイティブ保存とWebView保存の変換・入力元・経路検証を共通化し、未知の形式は受け入れない。

前回追加した一時ファイルへの保存・同期・置換と明示読み込みも維持する。

## 実機での確認

専用Host・engine・scannerを現行ソースからdebugビルドし、通常版と異なるidentifierと全app保存先を指定した。MCP CLI 0.13.2、bridge 0.13.1で接続。通常のHost、Windows音量、Voicemeeter設定は操作していない。

| 条件 | 結果 |
| --- | --- |
| 修正前・初回48 kHz/512 | 入力build拒否→96 kHz再試行→スタックオーバーフロー。保存ファイルなし。 |
| 修正前・初回96 kHz/512 | 正常開始し、保存ファイルを作成。 |
| 修正前・正常設定保存後に48 kHz/512 | 同じクラッシュを再現。保存ファイルのハッシュと内容を保持。 |
| 修正後・初回48 kHz/512 | 96 kHz/512への再試行が成功し、実際の96 kHz設定を保存。 |
| 修正後・48 kHz/512の開始・停止を3回 | 3回とも96 kHz/512で開始、stream running=true・streamFailed=false。各回停止し、最終running=false。 |
| 修正後・存在しない機器IDで開始拒否 | エラーを返し、直前の正常設定ファイルのハッシュを保持。 |
| WebView接続設定なしで同じ専用Hostを再起動 | 設定画面にVoicemeeterの機器ID・96 kHz・512・入出力1/2が復帰。WebViewの値はnullのまま、streamは停止。 |
| 復帰した画面で「保存して開始」 | 実機で正常開始し、WebViewにも設定を保存。その後停止を確認。 |

直後のsidecar再生成で、一度だけ機器IDを解決できない応答も観測した。保存ファイルは変わらず、その後同じIDを利用できた。これは待機時間の追加等で隠さず、未特定の別条件として残す。

最終的に専用Hostを終了し、MCPを切断した。通常版の`last_audio_config.json`と未追跡の利用者所有設計文書は、調査前後でハッシュ一致。

## 自動検証

最終結果は本記録のコミット時点のもの。通常版とMSIXの保存先分離は既存Rustの保存・読取試験で確認し、今回も別保存先のファイルへ代替しない。MSIXパッケージのインストール試験とは区別する。

- Vitest: 148ファイル・1,581件成功。ネイティブのみの保存からの表示復帰、未保存・破損WebView値の保持、確認待ち、遅い読み込みと手動保存の競合、機器IDの復帰を含む。
- ブラウザ: 設定・送り先・ホーム・ASIO接続の46件成功。日英・3テーマで、ネイティブ保存から復帰した画面、開始失敗後の保持、再読み込みも確認。最初の実行では追加試験が通知の`role=alert`を誤って前提として6件失敗し、実際の通知文を検証する指定へ修正した。
- `npx tsc --noEmit`、`npx vite build`成功。
- `cargo test --locked`成功。ライブラリ713件成功・5件ignore、sidecarなどの統合試験も成功。実機録音・OTTを要求するignore試験は明示実行していない。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`成功。Rust変更ファイルをrustfmtで整形し、`git diff --check`成功。

証拠は`%USERPROFILE%/.codex/tmp/auralyn-309-validation-20261104-bc4c953d/`へ保持。主な記録は`baseline-host.log`、`fixed-host.log`、`first-asio-48k.json`、`failed-asio-48k-with-last-good.json`、`first-asio-48k-fixed.json`、`three-retries-fixed-confirmed.json`、`rejected-device-fixed.json`、`restarted-recovered.json`、`restarted-recovered.png`、`recovered-ui-started.json`、`recovered-ui-stopped.json`、`existing-host-readonly-path.json`。試験ログは`unit-all.log`、`browser-accepted.log`、`typescript.log`、`build.log`、`rust-test.log`、`rust-check.log`、`rust-clippy.log`。

## 確認の限界

今回確認したのは、Voicemeeter Insert ASIOの上記条件と、正常設定の保持・画面への復帰・明示再開である。聴感、他のASIO機器、長時間運転、MSIX実パッケージ、および任意の開始失敗後の音声の自動ロールバックの合格にはしない。#289全体の完了やGitHub Issueのクローズも行っていない。
