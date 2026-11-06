# ブラウザCIの短縮と試験ツールの比較

2026-11-06。既存Playwrightの並列化・重複整理、Vitest Browser Mode、実TauriのWebdriverIOをこの順で比較した。
今回の採用対象は既存CIの改善とする。ツール比較の試作はローカルの証拠領域に保存し、製品・通常CIの依存へ追加しない。

## 既存Playwrightの改善

基準は `origin/main` から分岐した `00549c90106c74efca8ff86c306946a9e8261397`。
Windows 11 Pro、Ryzen 7 7800X3D（16論理CPU）、Node 24.22.1、Playwright 1.64.1で測定した。
各実行は順番に行い、別のビルド・単体試験・依存インストールを重ねていない。
同じ本番ビルドをport 1427で配信し、`CI=1`、`E2E_PREVIEW=1`、再試行0で実行した。

| 条件 | 成功 | skip | 失敗 / flaky | 全体時間 |
| --- | ---: | ---: | ---: | ---: |
| 変更前・1 worker | 193 | 3 | 0 / 0 | 479.07秒 |
| 同じケース・2 workers | 193 | 3 | 0 / 0 | 252.95秒 |
| 重複整理後・2 workers | 185 | 3 | 0 / 0 | 239.82秒 |

時間はPlaywright JSON reporterの `stats.duration`。サーバー起動を含み、Viteのビルド・npm ciは含まない。
各条件1回の測定であり、GitHub Actions上の短縮率や継続的な安定性を確定するものではない。
3件のskipは既存の `meter-profile.spec.ts`。専用の実Host計測runnerから実行する試験で、今回増やしていない。
並列数だけで約47%、重複整理込みで約50%の短縮だった。

変更内容:

- CIではファイル単位の2並列。ファイル内の試験は従来どおり直列。`fullyParallel` は有効にしない。
- `checks`（単体・DOM・アプリとE2Eの型・配布）と `browser`（本番ビルド・Chromium・ブラウザ試験）を別runnerで並行実行する。
- 既存の必須チェック名 `frontend` は最終判定jobに残し、両jobの成功を要求する。失敗・取消・skipを成功にしない。
- `settings-followup.spec.ts` の機器選択・保存済み設定の復帰は、両言語・代表のlightテーマで維持する。機能が同じだったdark/gamingの8ケースを整理する。
- 同ファイルの色・150%拡大・折返しを検査するケースは、両言語×3テーマを維持する。#329/#330/#333、メーターの寸法・値・共有の既存E2Eも維持する。

手元では既定1 workerを保ち、`--workers=2` で並列実行できる。
まず2並列を採用し、GitHubの実測で不足が残る場合にworker数やshardを検討する。
今回の測定では4並列・複数shardを比較しておらず、runner起動や重複インストールの費用まで含む最適値とは扱わない。

## Vitest Browser Modeの小規模試作

Vitest / `@vitest/browser-playwright` 4.1.12、`vitest-browser-react` 2.3.0、Playwright 1.64.1を使用。
製品の `MeterVisual` とCSSを直接Chromiumへ読み込み、3テーマ×縦横の6件で値・塗りの割合・寸法・クリップ解除・無音/受信待ち/停止を確認し、全件成功した。
nested packageの境界では製品のPostCSS設定を自動で読み込めず、最初の試作ではCSSが適用されなかった。
製品と同じTailwind/PostCSS処理とソース走査範囲を明示し、実寸を確認して解消した。

通常試験とビルドの終了後、npmコマンド起動を含めて4.70秒だった。
参考として既存 `layout.spec.ts` のクリップ/無音時の寸法と数値桁の2件は、Playwright全体時間8.20秒で成功した。
ただし既存E2Eは通知購読・入出力の共有・大型メーター・隣の操作位置も検査する。
範囲が異なるため、速度比を置換の根拠にはしない。

部品のCSSや操作を素早く確認する用途には候補となる。
アプリ全体の導線・重なり・通知の統合は引き続きPlaywright E2Eで守る。
Browser Modeも今回はPlaywright providerを使っており、ブラウザ自動化基盤を置き換える案ではない。

## 実Tauri: CDPとWebdriverIO

`@wdio/tauri-service` / JS plugin / Rust plugin / embedded WebDriver plugin 1.5.1を使用。
公開されたservice 1.5.1のpeerに合わせ、WDIO CLI / local-runner / mocha-frameworkは9.31.9とした。
通常のHost・Cargo・権限設定を変更せず、trackedなRustソースを一時コピーし、そのコピーだけにpluginと権限を追加した。
専用の識別子・設定・WebView2保存先・バイナリを使用し、`--auralyn-review` で起動した。音声は開始していない。

両方式で同じ比較用Host・フロントを使い、設定→外観の表示言語、実IPC `get_saved_audio_config` の読取、未接続OBSの操作禁止を確認した。
CDP→WDIOを交互に各3回実行し、すべて成功した。

| 方式 | 1回目 | 2回目 | 3回目 | 中央値 |
| --- | ---: | ---: | ---: | ---: |
| Playwright CDP | 2.45秒 | 1.92秒 | 1.93秒 | 1.93秒 |
| WebdriverIO service | 6.91秒 | 7.12秒 | 6.92秒 | 6.92秒 |

Hostの起動・接続・操作・終了を含む。Rust/フロントのビルドとpreview起動は除外した。
WDIOはCLI/worker/serviceの初期化を含み、CDPは計測中のNodeプロセスから直接操作している。
この構成差を含む小さな操作の比較で、一般的な両ツールの速度差や既存native E2E全体の等価比較ではない。
試作時、WDIOの `aria/表示言語` はwrapしたlabel由来の名前でselectを見つけられず、関連するlabel内のselectを指定して解消した。
移行ではこのようなlocatorの互換性も確認が必要となる。

今回のCI待ち時間を短縮する目的では、既存Playwrightを継続する。
WDIO serviceのHost起動・終了やTauri API操作の支援は、今後native試験を拡張するときに再評価できる。
今回追加のplugin・権限・依存は通常CIと配布へ取り込まない。

## 検証・未確認事項

- `npx tsc --noEmit`、`npx tsc --noEmit -p tsconfig.e2e.json`: 成功。
- `npm test -- --run --maxWorkers=4`: 152ファイル・1,624件成功。
- `npx vite build`: 成功。
- `npm run test:release`: 59件成功。`npm run release:check`: PASS。
- `E2E_PREVIEW=1 npx playwright test` 相当（上記の各worker数、`CI=1`）: 全件成功。
- workflowの `actionlint` 1.7.12: 成功。公式配布バイナリのattestationも照合した。
- 比較用TypeScript、Browser Mode 6件、実HostのCDP/WDIO: 成功。試作の保存先を証拠領域へ移した後も再確認した。
- 比較用Cargo.lock: cargo-audit 0.22.2で683依存を監査し、脆弱性の指摘なし・警告6件、終了0。

GitHub上の新しいjob構成、branch protectionでの必須判定、実runnerでの時間と長期的なflaky率は公開後の確認が必要。
今回の試験は実機音声・聴感・OBS接続・長時間運転の受入を表さない。
実WebView2は比較用Hostの表示と上記の操作だけを確認した。
製品UIのコード・文言・メーターの値や寸法は変更していない。

別問題の候補として、既存ルート依存の `npm audit` はmoderate対象5パッケージ（glob/minimatchからarchiver等へ波及）を報告した。
比較用WDIO等を含む隔離したnpm構成はmoderate 11 / high 14の対象25パッケージを報告した。
これは独立したadvisoryの件数ではない。今回の範囲では更新・overrideを行わず、試作を通常依存へ採用しない判断の材料として残す。

ローカルの再現用コード・lockfileは `test-results/ci-study/runner-poc`、ログ・JSON・スクリーンショット・隔離Hostは `test-results/ci-study` に保存した。
いずれもignoredで、PRや通常のソース配布には含めない。比較用コードの採用時には別途レビュー・依存監査を行う。

一次情報:

- [Playwright: 並列実行](https://playwright.dev/docs/test-parallel)
- [Vitest 4.1.12: ReactのBrowser Mode](https://github.com/vitest-dev/vitest/blob/v4.1.12/docs/api/browser/react.md)
- [Vitest 4.1.12: Playwright provider](https://github.com/vitest-dev/vitest/blob/v4.1.12/docs/config/browser/playwright.md)
- [Tauri: WebDriver](https://tauri.app/develop/tests/webdriver/)
- [WebdriverIO: Tauri plugin設定](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/)
