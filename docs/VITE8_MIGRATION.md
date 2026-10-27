# Vite 8更新とローカル検証

調査・測定日: 2026-10-27。push・PR作成・公開は行わない。

本書はVite 8単独更新時の測定・検証記録。同日の後続監査対応ではVitestを4.1.12へ更新し、
Jimp/Zodの経路を除去して監査指摘を0件にした。後続変更は
[依存関係の整備記録](DEPENDENCY_MAINTENANCE.md)を参照する。

## 変更範囲

- Vite: lockfileの7.3.6 → 8.3.5（manifestは`^8.3.5`）。
- `@vitejs/plugin-react`: 4.7.0 → 6.1.2（manifestは`^6.1.2`）。
- `build.rollupOptions.output.manualChunks`のオブジェクト指定を、
  `build.rolldownOptions.output.codeSplitting.groups`へ移行。
  React、Radix、DnD、アイコンのvendor分割を維持し、WindowsとPOSIXのパス区切りに対応する。
- Vite・Vitest設定の`__dirname`を`import.meta.dirname`へ変更。
  package.jsonの動的importにはJSON属性を付け、default exportを読む形へ統一する。
  Vite 8が示す将来のnative設定ローダーに関する警告に対応する。
- React、Vitest、TypeScript、Rust、Tauri、音声処理、アプリ番号1.1.0は変更しない。
  lockfileにはViteが要求するビルド用推移依存の追加・削除・更新を含む。

公式資料: [Vite 8移行](https://vite.dev/guide/migration)、
[Reactプラグイン6](https://github.com/vitejs/vite-plugin-react/releases/tag/plugin-react%406.0.0)、
[Rolldownの手動分割](https://rolldown.rs/in-depth/manual-code-splitting)。

## 測定条件

- Windows 11 x64、AMD Ryzen 7 7800X3D、Node 24.21.0、npm 11.19.0。
- 基準HEAD: `526242a2ba738b0283ad56090649b78277185752`。
- 起動中の既存アプリ・開発サーバーを維持し、専用worktreeと別のnode_modulesで測定。
  同一worktreeでVite 7、Vite 8の順に測定し、Rustビルドやテストは測定後に実行した。
  OSキャッシュの消去やバックグラウンド負荷の固定はしていない。
- フロントビルドは`node node_modules/vite/bin/vite.js build`を6回実行。
  Nodeプロセス生成から終了までの経過時間で、tsc・Rust・画像生成・インストーラーは含まない。
  初回はウォームアップとして除外し、後続5回の中央値を比較する。
  Vite 7の初回ビルドは依存インストール完了前に開始したため、コールドビルド比較には使わない。
- 開発起動は`node node_modules/vite/bin/vite.js --port 1430 --host 127.0.0.1`。
  プロセス生成から`ready in`出力の観測までを25ms間隔で測定。
  各版の初回を除外し、依存キャッシュを保持した後続5回を比較する。
- 初回HTTP処理は、起動後に`/`、`/src/main.tsx`、`/src/index.css`を順番に取得した合計。
  依存モジュール全体の読み込み・React描画・Tauri起動完了の時間ではない。
- CSS HMRは`src/index.css`へコメントを追記し、WebSocketで更新通知を受信してから
  変換済みCSSをHTTPで取得するまでを測定。元ファイルは各サーバー終了前にバイト単位で復元した。
  後続5起動×各5回の25標本の中央値を比較する。ブラウザーの描画完了は測定しない。
- サイズは最終ビルドの全JS/CSSファイルの合計。gzipは各ファイルをNodeのgzip既定値で圧縮した合計。
  インストーラーやプロセスのメモリ使用量ではない。

## 結果

| 対象 | Vite 7 | Vite 8 | 解釈 |
| --- | ---: | ---: | --- |
| フロントビルド中央値 | 6,565ms | 1,244ms | 約81%短縮、約5.3倍 |
| キャッシュ保持時の開発起動中央値 | 450ms | 357ms | 約21%短縮。25ms間隔の観測を含む |
| 最初の3 HTTP取得中央値 | 1,195ms | 971ms | 約19%短縮。画面表示時間ではない |
| CSS更新通知＋再変換中央値 | 276ms | 273ms | ほぼ同等。改善の根拠にはしない |
| JS総量 | 1,541,698 bytes | 1,540,851 bytes | ほぼ同等 |
| JS gzip総量 | 427,508 bytes | 419,683 bytes | 約1.8%減 |
| CSS総量 | 88,698 bytes | 88,789 bytes | ほぼ同等 |
| CSS gzip総量 | 13,539 bytes | 13,518 bytes | ほぼ同等 |

比較に使った標本（ms、四捨五入）:

| 対象 | Vite 7の5回 | Vite 8の5回 |
| --- | --- | --- |
| ビルド | 6311 / 6550 / 6820 / 6907 / 6565 | 1198 / 1244 / 1359 / 1275 / 1210 |
| 開発起動 | 641 / 421 / 543 / 450 / 416 | 340 / 357 / 360 / 324 / 358 |
| HTTP取得 | 1568 / 1195 / 1351 / 1079 / 1154 | 1047 / 1319 / 922 / 969 / 971 |
| 各起動内のCSS更新中央値 | 288 / 313 / 253 / 249 / 277 | 278 / 267 / 261 / 278 / 288 |

初回の開発起動はVite 7が513ms、Vite 8が720ms。
それぞれ1標本のため、コールド起動の優劣は判断しない。
測定時のグループ設定は更新後と同じ。後続の`import.meta.dirname`・JSON属性の変更後も
最終ビルドのJS/CSSファイル名・非圧縮サイズ・gzipサイズが測定時の成果物と一致した。
既存の500kB超チャンク警告は測定したVite 8ビルドでは発生しなかった。
音声遅延・ドロップアウト・UI描画速度・実機性能の改善は、この測定から主張しない。

## 検証

- `npm ci --no-audit --no-fund`: 成功。更新後lockfileから再インストールできる。
- `npm ls --all`: 成功。Vitest 4.1.11もVite 8.3.5を共用し、peerの不整合はない。
- `npx tsc --noEmit`、最終設定での`npx vite build`: 成功。
  最終ビルドではnative設定ローダーに関する警告も発生しない。
  `npx vite build --configLoader native`でも同じ成果物を生成できる。
- `npm test -- --run --maxWorkers=4`: 105ファイル、1,018件すべて成功。
  初回の既定並列実行は1件が5秒の制限で時間切れ。
  並列数4の最初の再実行もRust初回ビルドと重なり、空きメモリが約0.8GBまで低下したため中断した。
  上記の成功結果はRustビルドを止めた後の単独再実行。テストの制限時間・検証内容は変更していない。
- `npm run test:release`: 51件成功。`npm run release:check`: PASS。
- `node scripts/generate-nsis-bitmaps.js`: ヘッダー188×57、サイドバー205×314を生成でき、既存画像との差分なし。
- `node generate-licenses.cjs`: 収録済みnpmライセンス一覧と内容一致。
  配布用のnpm依存は変更していない。
- `npm audit --json`: 更新前32（high 30 / moderate 2）→更新後31（high 29 / moderate 2）。
  パッケージ単位の数であり、独立した脆弱性の件数ではない。
  Viteの一致は解消。残るJimp/Zod、Vitest/mockerは更新前から存在し、別更新として扱う。
  `npm audit fix --force`は実行していない。
- `npm run tauri build -- --debug --no-bundle --config <検証用設定>`: 成功。
  検証用設定はworktree外に置き、アプリ識別子を`com.kuro7983.auralynhost.vite8check`へ分離。
  `beforeBuildCommand`を空にして検証済みの`dist`を埋め込んだ。
  Rust依存を並列数2で初回ビルドし、通常版の設定・配布設定は変更していない。
  サイドカーは元checkoutの`src-tauri/bin`から検証用worktreeへコピーした既存成果物。
  今回は音声エンジンを再ビルド・実機検証した結果として扱わない。
- `tauri-mcp-cli`で上記アプリの127.0.0.1:9224へ接続し、識別子・接続成功を確認。
  WebView保存先も分離し、`http://tauri.localhost/`で本番用成果物を読み込んだ。
  日本語・Auroraの1024×768と英語・Lightの900×600を確認した。
  言語選択はselect要素の値変更とchangeイベントを使い、実キー操作の保証とはしない。
- 初期セットアップの表示・閉じる、設定のタブ切り替え、テーマ・言語変更、
  アプリ番号1.1.0、ライセンス画面の開閉、かんたん／詳細表示の切り替え、
  VST追加画面の開閉とOTT検索、大型メーターの停止表示を確認。
  900×600の詳細表示で`scrollWidth <= innerWidth`。スクリーンショットも目視確認した。
  確認した操作のコンソールerrorログは0件。
- 音声の保存・開始操作は実行していない。`get_audio_state`は`config: null`。
  検証用アプリ・driver sessionは終了した。既存アプリ・開発サーバーは終了していない。
- `git diff --check`: 成功。Rustのmanifest・lockfile・ソースに差分なし。

## 未確認の範囲

音声実機、VSTの実ロード・編集画面・実際のドラッグ並べ替え、OBSへの到達、
React Fast Refreshの実WebView描画、長時間運転、DPI違いは未確認。
今回のHMR測定はCSSの通知・再変換までであり、React画面の再描画時間ではない。
`npm run build`によるrelease sidecar再生成、署名済みNSISの生成・インストール、
旧版からの更新、公開後の取得確認も実施していない。
これらはフロントビルド・自動テスト・上記WebView確認の成功とは区別する。
