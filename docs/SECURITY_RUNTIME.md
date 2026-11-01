# WebView のセキュリティ設定

製品の `tauri.conf.json` は `window.__TAURI__` を公開しない。UI は `@tauri-apps/api` の import を使用する。CSP は同一オリジンの資産と Tauri IPC (`ipc:`、Windows の `http://ipc.localhost`) を許可する。React の style 属性と既存の SVG data URL が必要なため、それぞれ `style-src-attr 'unsafe-inline'` と `img-src data:` を許可する。`style-src-attr` は Tauri が style-src に nonce を追加した場合も style 属性に適用される。外部スクリプト、script の unsafe-inline / unsafe-eval、任意の通信先は許可しない。

Vite が生成するローカルスクリプトや HTML 内のテーマ初期化には、Tauri がアセット処理時に nonce・hash を補う。ブラウザ内の Voice Check は再生 API ではなく Rust 側の `voice_check_preview` IPC を使用する。更新と OBS 接続も Rust 側で行い、外部ページは既存のリンクや opener で開く。これらのための外部 connect-src や media の blob は現行コードに必要ない。

開発用 `devCsp` は Vite HMR の localhost:1420 と native E2E 用 127.0.0.1:1427 の WebSocket を追加する。外部 Vite サーバーから配信されるページへの CSP 適用は Tauri の埋め込みアセットとは別に実測が必要であり、この設定だけでサーバーの HTTP 応答にポリシーが付くとは扱わない。

`npm run test:e2e:native` と `scripts/issue179-native-session.mjs` は隔離ビルドでのみ `withGlobalTauri: true` に上書きする。MCP 等、明示的にグローバル API が必要なデバッグでは `npm run tauri -- dev --config src-tauri/tauri.debug-global.conf.json` を使う。通常の開発・配布設定にこの上書きを混ぜない。設定の静的テストとビルドは、WebView での CSP 強制、IPC、更新、外部リンク、実機音声の動作を保証しない。

参照: [Tauri CSP](https://v2.tauri.app/security/csp/)、[Tauri 設定](https://v2.tauri.app/reference/config/)、[Tauri JavaScript API](https://v2.tauri.app/reference/javascript/api/)。

## OBS パスワードの保存と復旧

設定画面から保存するパスワードは、Rust が Windows のユーザー単位の DPAPI で暗号化し、`app_config_dir/obs-credentials.dpapi` へ保存する。接続先も暗号化データに含め、ホスト名とポートが一致する場合だけ保存値を使う。通常版・MSIX・一時利用はそれぞれの設定保存先を使い、別の保存先へフォールバックしない。

画面へ返すのは保存先のホスト名とポートだけで、復号したパスワードは返さない。入力欄は保存後に空にする。保存値を使う場合と、空欄で認証なしを指定する場合を区別する。セットアップの入力は一時的な接続用で、保存しない。

接続と切断は、資格情報のロックを取得してから OBS client のロックを取得する同じ順序で直列化する。保存値の読み込み・復号中に画面が閉じたり非表示になった場合も、先行する接続処理を待ってから切断を完了し、切断より遅い接続を残さない。接続内の保存失敗による後片付けでは、保持中の資格情報ロックを再取得しない。

旧 `localStorage` の移行は、保存領域を確認した後、一般設定の移行より前に実行する。暗号化保存を終えてから旧値を削除し、接続先だけを再保存する。暗号化や接続先の再保存に失敗しても平文へ戻さない。再保存の容量不足で旧値を残さないよう、削除と再保存を別の操作にする。起動失敗の案内から再試行し、必要なら OBS 設定で接続先とパスワードを入力し直す。

設定エクスポート・配信設定・プロファイルの許可リストに、このファイルやパスワードを追加しない。一時利用の保存値は一時領域に限定する。旧版へ戻しても平文の保存値を復元しないため、OBS パスワードの再入力が必要になる場合がある。

DPAPI は保存時の保護であり、同じ Windows ユーザーで任意コードを実行できるプログラムからの隔離ではない。旧 `localStorage` キーの削除も、過去の LevelDB 領域やバックアップの物理消去を意味しない。[CryptProtectData の仕様](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)を参照。
