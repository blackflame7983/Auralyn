# WebView のセキュリティ設定

製品の `tauri.conf.json` は `window.__TAURI__` を公開しない。UI は `@tauri-apps/api` の import を使用する。CSP は同一オリジンの資産と Tauri IPC (`ipc:`、Windows の `http://ipc.localhost`) を許可する。React の style 属性と既存の SVG data URL が必要なため、それぞれ `style-src-attr 'unsafe-inline'` と `img-src data:` を許可する。`style-src-attr` は Tauri が style-src に nonce を追加した場合も style 属性に適用される。外部スクリプト、script の unsafe-inline / unsafe-eval、任意の通信先は許可しない。

Vite が生成するローカルスクリプトや HTML 内のテーマ初期化には、Tauri がアセット処理時に nonce・hash を補う。ブラウザ内の Voice Check は再生 API ではなく Rust 側の `voice_check_preview` IPC を使用する。更新と OBS 接続も Rust 側で行い、外部ページは既存のリンクや opener で開く。これらのための外部 connect-src や media の blob は現行コードに必要ない。

開発用 `devCsp` は Vite HMR の localhost:1420 と native E2E 用 127.0.0.1:1427 の WebSocket を追加する。外部 Vite サーバーから配信されるページへの CSP 適用は Tauri の埋め込みアセットとは別に実測が必要であり、この設定だけでサーバーの HTTP 応答にポリシーが付くとは扱わない。

`npm run test:e2e:native` と `scripts/issue179-native-session.mjs` は隔離ビルドでのみ `withGlobalTauri: true` に上書きする。MCP 等、明示的にグローバル API が必要なデバッグでは `npm run tauri -- dev --config src-tauri/tauri.debug-global.conf.json` を使う。通常の開発・配布設定にこの上書きを混ぜない。設定の静的テストとビルドは、WebView での CSP 強制、IPC、更新、外部リンク、実機音声の動作を保証しない。

参照: [Tauri CSP](https://v2.tauri.app/security/csp/)、[Tauri 設定](https://v2.tauri.app/reference/config/)、[Tauri JavaScript API](https://v2.tauri.app/reference/javascript/api/)。
