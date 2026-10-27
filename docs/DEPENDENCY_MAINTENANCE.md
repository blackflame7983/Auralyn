# 依存関係の整備方針と初回棚卸し

調査日: 2026-10-15。初回は規約・開発ツールの整備と更新検討を実施。同日の追加依頼による npm audit 限定更新、React・UI系更新、Tauri関連更新、音声系の段階更新、RustSec指摘への限定更新の結果は末尾に記録する。ライブラリ置換は未実施。
番号は調査時点の値であり、着手時にレジストリと公式リリースノートを再確認する。

2026-10-27のVite 7基準測定・Vite 8更新は[VITE8_MIGRATION.md](VITE8_MIGRATION.md)を参照する。

同日の後続監査対応で、Vitestを4.1.12へ限定更新し、NSIS画像生成のJimp利用を
既存のbmp-ts 1.0.9への直接呼び出しへ置換した。Jimp経由のZod 3は依存木から除去した。
更新前の指摘は31パッケージに波及した3件のadvisoryで、全依存の`npm audit`は31→0、
配布用依存の監査は0→0。アプリでの攻撃成立を確認したという意味ではない。
ヘッダー・サイドバーBMPの変更前後のバイト一致、奇数幅・色順・上下方向、
不透明画像の条件と壊れたPNGの拒否を確認した。フロント1,018件、配布・画像変換53件、
型検査・Viteビルド・release readinessが成功。配布用依存とnpmライセンス73件は変更なし。
Zodのメジャーoverride、Jimpの旧版への変更、Rust変更、署名付き配布・実機検証は行っていない。

## 継続する判断基準

1. 先に現在の lockfile、実際の利用箇所、対応環境、テスト結果を確認する。manifest の要求範囲と解決済みバージョンを混同しない。
2. セキュリティ修正、既存範囲内の更新、メジャー移行、代替導入を分ける。`npm audit fix --force` や全依存の一括最新版化は使わない。
3. 代替は解決する課題、保守状況、ライセンス・配布条件、移行費用、測定可能な改善で判断する。「新しい」「AI が知っている」だけでは採用しない。
4. npm は `npm ci`、Cargo は `--locked` を基本とし、更新時は両 lockfile の差分を確認する。Rust の最小対応バージョンと native / ASIO SDK の制約を確認する。
5. 開発依存の指摘と、配布アプリで到達可能な問題を区別する。`npm audit` はアドバイザリへの一致であり、攻撃の成立や Rust 側の安全性を証明しない。
6. npm / Cargo のライセンス一覧を再生成・確認し、ローカルパスが混入していないか、GPL配布・対応ソースの条件を満たすかを確認する。
7. アプリ番号は [VERSIONING.md](VERSIONING.md) で別途判断する。更新を検討しただけでは番号を変更しない。

## npm の観測

`npm outdated --json` と `npm audit --json` を実行。audit は計6パッケージ（high 4 / moderate 2）、critical 0。
数はパッケージ単位であり、独立した脆弱性の件数とは異なる。以下は主な更新候補で、網羅的な最新版一覧ではない。

| 優先 | 対象 | 現在 → 調査時候補 | 判断・必要な確認 |
| --- | --- | --- | --- |
| 先行 | Vitest | 4.1.10 → 4.1.11 | 同メジャーの修正。mocker指摘の修正版。フロント全テストを確認 |
| 先行 | sharp | 0.35.3 → 0.35.5 | 修正候補。NSIS画像生成・アイコン加工と生成画像を確認 |
| 先行 | brace-expansion / browserslist / source-map-js | 推移依存 | audit指摘。`npm explain <name>` で親を確認し、親の範囲内で更新。overrideは通常解決で直らない場合だけ理由と撤去条件を記す |
| 次 | Vite | 7.3.6 → 7.3.7 | まず現行メジャー内。開発起動とproduction buildを確認 |
| 次 | React / React DOM | 19.2.4 → 19.3.1 | 同時更新し、型・Radix・DnD・モーダル・設定復元を確認 |
| 次 | Tauri API / CLI / updater | 2.10.1 / 2.10.0 / 2.10.0 → 2.12.4 / 2.12.3 / 2.14.0 | Rust側も組合せを確認。UIテストだけでは不十分。署名・インストーラー・旧版からの更新が必要 |
| 次 | Tailwind / PostCSS plugin | 4.1.18 → 4.3.3 | 両方を揃える。主要画面・モーダル・スクロールを実画面確認 |
| 別枠 | Vite / React plugin | 8.3.4 / 6.1.2 | メジャー移行。現行 `vite.config.ts` の object形式 `manualChunks` は移行が必要。既存範囲の更新と分離 |
| 別枠 | TypeScript / Vitest / jsdom | 7.0.2 / 5.0.4 / 30.1.3 | 各メジャー移行を独立して評価。型・テスト環境の変更を同時に持ち込まない |

アドバイザリ: [Vitest/mocker](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)、[sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)。
残る指摘は [brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)、[Browserslist](https://github.com/advisories/GHSA-c83g-rgw3-j3cx)、[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) を参照。
Viteの変更は [公式移行ガイド](https://vite.dev/guide/migration)。Tauriの組合せと更新経路は [公式Updater文書](https://tauri.app/plugin/updater/)。

## Rust の観測

Cargo.lock と crates.io API の `max_stable_version` / `repository` を照合した候補。
Cargo 全推移依存の outdated / RustSec 監査は未実施。最新版へコンパイルできることや互換性は未確認。

| 対象 | 現在 → 調査時最新安定版 | 判断 |
| --- | --- | --- |
| CPAL | 0.17.1 → 0.18.2 | WASAPI / ASIO の基盤。別変更でドライバ、デバイス切替、サンプルレート、連続動作を検証 |
| rubato | 0.14.1 → 5.0.1 | 大きな移行幅。既存 `FftFixedIn` 利用を公式APIと照合し、品質・遅延・CPU・割当を測定してから採用判断 |
| winit | 0.29.15 → 0.30.13 | `EventLoopWindowTarget` / `WindowBuilder` 利用を含む。VST editor の開閉・リサイズ・DPI・スレッド制約を検証 |
| obws | 0.11.5 → 0.15.0 | OBS 接続・認証・ソース作成・イベント・メーター・再接続を検証 |
| base64 | 0.21.7（直依存）→ 0.23.1 | plugin state の往復保存・旧データ復元を確認。lockfileには推移依存0.22.1も存在 |
| winreg | 0.52 系 → 0.56.0 | 自動起動の登録・解除・既存設定を確認 |
| vst3 | 0.3.0 → 0.3.0 | 最新化目的での置換は不要。ホスト互換性の改善が必要なときに評価 |

一次情報: [CPAL](https://crates.io/crates/cpal)、[rubato](https://github.com/HEnquist/rubato)、[winit](https://crates.io/crates/winit)、[obws](https://crates.io/crates/obws)、[base64](https://crates.io/crates/base64)、[winreg](https://crates.io/crates/winreg)、[vst3](https://crates.io/crates/vst3)。
obwsの旧 [GitHub](https://github.com/dnaka91/obws) はアーカイブ済みだが、crates.ioは `forge.dnaka91.rocks` を現在のrepositoryとして示す。
移転先は今回ブラウザで取得できず、そこでの保守状況は未確認。GitHubのarchiveだけを理由に採用撤回しない。

## 代替の判断

| 案 | 今回の判断 | 理由・次の評価条件 |
| --- | --- | --- |
| Tauri / React / CPAL / VST3基盤の全面置換 | 継続 | 現状の具体的障害を改善する証拠がない。配布・音声・プラグイン互換性を既存テストと実機確認で守る |
| release-please / semantic-release | いったん不採用 | コミット分類だけでは保存データ・音声互換性を判定できず、既存の署名・別repo公開・Source ZIPの手順も統合が必要。現段階はAI提案と既存配布ゲートで品質を守る |
| lucide-react と react-icons の一本化 | lucide削除を次の小変更候補にする | コード検索ではlucideの直接利用がなく、Viteのvendor設定に残る。削除前に利用再検索、bundle比較、画面・ライセンス一覧を確認する |
| Zustand等の状態管理追加 | 保留 | Contextの具体的問題を再現し、局所修正では解決できない場合に比較する |
| IPCの型生成（tauri-specta / ts-rs） | 小規模試作候補 | 手書きTS/Rust契約のずれを減らせる可能性。Tauri CommandとサイドカーJSON-RPCの対象差、生成型・serde表現・CI再現性を確認してから選ぶ |

## 推奨する着手順

1. audit指摘への限定更新を行い、`npm ci`、フロントテスト、型検査、Viteビルド、画像生成を確認。auditを再実行し、残る指摘を記録する。
2. React / UI系とTauri系を別々に更新。Tauri系は両言語のlockfile、sidecar、署名・インストール・更新まで確認する。
3. 不要候補のlucideを削除してbundleを比較。音声系更新は基準測定を残して1ライブラリずつ進める。
4. メジャー移行・型生成・ライブラリ代替は、それぞれ独立した変更で費用と改善を評価する。

検証の具体項目は [TESTING.md](TESTING.md)。本書の調査結果を「依存更新済み」「脆弱性解消済み」と報告しない。

## 今回の整備で確認した範囲

基準HEAD: `2b06ef8`、ブランチ: `codex/maintenance-version-policy` のローカル差分（2026-10-15）。
配布関連23テスト、フロント33テスト、`tsc --noEmit`、Viteビルド、`release:check`、番号同期のdry-runが成功。
Viteは空の `vendor-react` チャンクを警告した。チャンク設定の見直し時に確認する。
Rust実ビルド、音声・OBS・VSTの実機確認、インストーラー・更新・署名・公開確認は未実施。
アプリ番号は1.1.0を維持。今回のみをリリース対象とするなら判定は `none`（規約・開発用スクリプト整備）。

## npm audit 限定更新（2026-10-15）

ユーザーの追加依頼に基づき、`codex/npm-audit-limited-update` でローカル更新・検証を実施。前段の規約整備の未コミット差分を維持した。
変更対象は `package.json`、`package-lock.json`、本節。push・PR作成・タグ・公開は行っていない。

| 対象 | 更新前 → 更新後 |
| --- | --- |
| Vitest / @vitest群 | 4.1.10 → 4.1.11 |
| sharp / 対応native package | 0.35.3 → 0.35.5（libvipsのoptional packageは1.3.2 → 1.3.4） |
| brace-expansion | 2.1.4 → 2.1.7、read-package-json配下の1.1.18 → 1.1.21 |
| browserslist | 4.28.1 → 4.29.3（要求されたブラウザデータ等の推移依存を含む） |
| source-map-js | 1.2.1 → 1.2.2 |

直接依存の要求下限は `sharp: ^0.35.5`、`vitest: ^4.1.11` へ変更。通常の親semver範囲内で解決し、overrideは追加していない。
npmの再解決で不要に更新されたchai / tinyrainbowは、新しい親の要求を満たすことを確認し、元の版を維持した。
lockfileにはnpmが再計算したpeerメタデータの差分も含む。React・Tauri・Vite・TypeScript・音声系・Cargoのバージョンは変更していない。

検証結果:

- `npm ci`: 成功。続く `npm audit --json` は6件（high 4 / moderate 2）から0件へ。
- `npm ls vitest @vitest/mocker sharp brace-expansion browserslist source-map-js`: 成功。対象のroot・nested依存を修正版で解決していることを確認。
- `npm test -- --run`: 33件成功。`npm run test:release`: 23件成功。
- `npx tsc --noEmit`、`npx vite build`、`npm run release:check`、`git diff --check`: 成功。
- `node generate-licenses.cjs`: 成功。配布用npmライセンス一覧の差分なし。
- 既存の画像生成スクリプトを一時コピー上で実行し、header 188×57 / sidebar 205×314の24bit BMPを検査。双方が既存画像とバイト単位で一致。元画像は変更していない。
- archiverのglob経由でZIPをメモリ上へ生成し、ZIPシグネチャと期待したファイル名を確認。

全対象は開発依存。固定PNG / SVGの画像生成やビルド・テスト・配布補助が現行の利用経路であり、配布アプリで攻撃者入力が到達する経路は確認していない。
影響版の除去とaudit指摘の解消を確認したもので、Linux native画像処理の攻撃再現や公開mocker pluginへの攻撃試験は行っていない。
Rust・音声実機・インストーラー・更新経路・公開確認も今回の範囲外。

残る警告は、Viteの空の `vendor-react` チャンク、license-checkerの推移依存等の非推奨、ライセンス生成時のreact-icons repository URLの非推奨、npmのesbuild postinstall未承認表示。上記検証はいずれも成功しているが、これらの警告の解消は別の整備で扱う。
アプリ番号は1.1.0を維持。開発依存のみの整備として `none` を基本とし、配布物を再生成して再配布する際は `VERSIONING.md` に従って別途判定する。

## React・UI系更新（2026-10-15）

ブランチ: `codex/react-ui-dependencies`。前段のaudit対応と規約整備の未コミット差分を維持し、今回の依存差分は作業開始時のmanifest / lockfileのコピーと比較した。
最新安定版・peer条件をnpmレジストリで確認し、既存メジャー内の更新を採用。React / React DOMは同じ19.3.1へ揃えた。

| 対象 | 作業開始時の解決版 → 更新後 |
| --- | --- |
| React / React DOM | 19.2.4 → 19.3.1 |
| @types/react / @types/react-dom | 19.2.13 / 19.2.3 → 19.3.0 / 19.3.0 |
| Radix avatar / dialog / popover | 1.1.11 / 1.1.15 / 1.1.15 → 各1.3.1 |
| Radix dropdown-menu / label | 2.1.16 / 2.1.8 → 2.2.1 / 2.1.17 |
| Radix radio-group / separator / slider | 1.3.8 / 1.1.8 / 1.3.6 → 1.5.1 / 1.2.0 / 1.6.1 |
| Radix slot / switch / tabs / tooltip | 1.2.4 / 1.2.6 / 1.1.13 / 1.2.8 → 1.5.0 / 1.4.1 / 1.2.1 / 1.4.1 |
| react-icons / sonner / tailwind-merge | 5.5.0 / 2.0.7 / 3.4.0 → 5.7.0 / 2.0.8 / 3.7.0 |
| Tailwind / @tailwindcss/postcss | 4.1.18 → 両方4.3.3 |
| @testing-library/react | 16.3.2 → 16.3.3 |

DnD、clsx、class-variance-authority、tailwindcss-animateは調査時点で既に最新。lucide-reactは直接利用がなくメジャー移行に当たるため、削除・更新を混ぜず維持した。
Tauri関連の全lockfileエントリ、Vite・TypeScript・Vitest・sharp・DnDのエントリは作業開始時と同一。Cargo.toml / Cargo.lock、音声処理、アプリのUIソースは変更していない。
Radix / Tailwind等に付随するFloating UI、Lightning CSSなどは推移依存として更新。配布用npmライセンス一覧を再生成し、採用版との一致・ローカルパス非混入を確認した。

一次情報: [React 19.3.1](https://github.com/react/react/releases/tag/v19.3.1)、[Radix変更履歴](https://www.radix-ui.com/primitives/docs/overview/releases)、[Sonner 2.0.8](https://github.com/emilkowalski/sonner/releases/tag/v2.0.8)、[Tailwind公式](https://tailwindcss.com/blog)。
RadixのpeerはReact 19を許容し、変更履歴にはReact 19でのrefループやフォーカス・dismiss処理の修正がある。互換性はpeer宣言だけで断定せず、以下の実行結果と併せて判断した。

検証結果:

- `npm ci`: 成功。最初は確認用ViteがCSS native moduleを使用中でEPERMとなり、自分で起動したサーバーを停止後に成功した。
- `npm test -- --run`: 33件成功。`npm run test:release`: 23件成功。
- `npx tsc --noEmit`、`npm ls --all`、`npx vite build`、`npm run release:check`、`git diff --check`: 成功。
- `npm audit --json`: 0件を維持。
- Vite開発画面と本番ビルドをChromeで確認。Tauri公式mockIPC / mockWindowsを使い、隔離したブラウザcontext内の設定・ダミーデバイス・ダミープラグインだけを操作した。
- 本番ビルドで設定の開閉、タブ、テーマのradio・保存値、スイッチ、スライダーのキーボード操作、メニューのEscape閉鎖と起点へのフォーカス復帰、通知、プラグイン追加を確認。
- 並べ替えは実ハンドルへのPointerイベント模擬入力で検証し、表示順・`reorder_plugins`引数・保存された順序が一致。ブラウザツールの通常dragとカード本体のキーボード操作では並べ替えを確認できず、これらの操作を検証済みとは扱わない。
- 再読込み後にテーマ・入力ゲイン・ダミープラグイン順の復元を確認。操作後のアプリ例外はなし。初回のfavicon.ico 404は検証用HTMLにicon指定がないことによるもの。

1024×768の詳細表示では状態表示ボタンが幅26px・高さ161pxへ潰れ、ヘッダー高さ64pxを超えた。更新前の依存・ソースを使う一時コピーの本番ビルドでも同一寸法で再現し、既存の狭幅レイアウト課題と切り分けた。1280×800では状態表示が通常表示される。今回、レイアウト修正は行っていない。
Viteの空vendor-reactチャンク、npmの非推奨・install-script警告、ライセンス生成時のrepository URL警告は前段と同様に残る。

未確認: Tauri WebView / ウィンドウの実動作、実VST・音声・OBS、インストーラー・署名・実更新経路。ブラウザモックはこれらの互換性を保証しない。
アプリ番号は1.1.0を維持。実行時依存の更新を配布する際は少なくともpatchを候補とし、全リリース差分で改めて判定する。push・PR作成・タグ・公開は未実施。

## Tauri関連更新（2026-10-15）

ブランチ: `codex/tauri-dependencies`。前段の未コミット差分を維持し、作業開始時のnpm / Cargo manifestとlockfileを一時領域へ保存して比較した。
crates.ioとnpmレジストリで最新安定版・MSRV・依存条件を確認。Tauri本体 / tauri-build / updater / MCP bridgeのMSRVはRust 1.90で、使用中の1.92.0で検証した。

| 対象 | 更新前 → 更新後 |
| --- | --- |
| Rust tauri / JS @tauri-apps/api | 2.10.2 / 2.10.1 → 両方2.12.4 |
| npm CLI | 2.10.0 → 2.12.3 |
| tauri-build | 2.5.5 → 2.7.3 |
| opener（Rust / JS） | 2.5.3 → 両方2.7.2 |
| process（Rust / JS） | 2.3.1 → 両方2.4.0 |
| updater（Rust / JS） | 2.10.0 → 両方2.14.0 |
| global-shortcut（Rust） | 2.3.1 → 2.4.1 |
| single-instance（Rust） | 2.4.0 → 2.5.4 |
| window-state（Rust） | 2.4.1 → 2.5.0 |
| 開発用mcp-bridge（Rust） | 0.11.2 → 0.13.1 |

一次情報: [Tauri依存同期の公式方針](https://tauri.app/develop/updating-dependencies/)、[Tauri 2.12.4](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.4)、[MCP bridge 0.13.1](https://github.com/hypothesi/mcp-server-tauri/releases/tag/v0.13.1)、[Updater](https://tauri.app/plugin/updater/)。
公式方針に従ってTauri本体とAPIのminor、JS/Rust双方を持つプラグインのexact versionを揃えた。bridgeはTauri 2.12.2以上に対応する安定版を使用し、debug時だけの登録・127.0.0.1 bindを維持した。

CargoはTauri関連9パッケージを指定して更新し、必要なWebView2 / Wry / Tao / tray / updater署名検証などの推移依存も更新された。
CPAL 0.17.1、rubato 0.14.1、winit 0.29.15、vst3 0.3.0、nnnoiseless 0.5.2、ringbuf 0.4.8、rustfft 6.4.1、hound 3.5.1、obws 0.11.5、libloadingの解決版は作業前と同一。直接利用するwindows 0.62.2も維持した。
npm側はTauri以外の全lockfileエントリが作業前と同一。Rustの音声・VST実装は変更していない。

### 更新確認APIの権限修正

実アプリで `plugin:updater|check` が `updater.check not allowed` となることを確認した。
更新前のcapabilityにもupdater / process権限がなく、旧updaterのpermission定義も同じ許可を要求していた。
既存 `Header.tsx` が使う `check()`、`downloadAndInstall()`、`relaunch()` に対応する以下の3つだけをmain windowへ追加した。

- `updater:allow-check`
- `updater:allow-download-and-install`
- `process:allow-restart`

個別のdownload / install / exit権限やremote URL権限は追加していない。既存のUIでユーザーが操作した更新・再起動を許可する変更であり、この検証中にインストール・再起動は実行していない。
本番のアプリID・公開先・署名公開鍵・バージョンなどの `tauri.conf.json` は作業前と同一。

### 検証結果と残件

- `npm ci`、`npm ls --all`、`npx tsc --noEmit`、`npx vite build`、`npm run release:check`、`git diff --check`: 成功。
- `npm test -- --run`: 33件成功。`npm run test:release`: 23件成功。`npm audit --json`: 0件。
- `cargo check --locked --all-targets`、`cargo build --locked --bins`: 成功。capability追加後も通常構成で再確認した。
- `cargo test --locked --lib`: 31件成功。実デバイス起動・録音・実VST GUIを使うintegration_test / repro_ottは実行していない。
- `cargo clippy --locked --all-targets`: 失敗。`src-tauri/src/vst_host/instance.rs:3301` のpublic関数からraw pointerを渡す処理が `clippy::not_unsafe_ptr_arg_deref` に抵触。更新前のCargo.toml / Cargo.lockと同じソースを使った隔離コピーの `cargo clippy --locked --lib` でも同じエラーを再現した。音声・VST実装の変更やlint抑制は行っていない。
- npmライセンス一覧と `cargo about generate --locked --fail` によるWindows向けCargoライセンス一覧を再生成し、更新版の収録を確認した。
- Tauri CLI 2.12.3でdebugアプリを起動。検証用identifier / productName、子プロセスのAPPDATA、WebView2の保存先を分離した一時configを使用し、通常の保存設定を使っていない。
- ビルド済みの新しいaudio_engine / plugin_scannerを一時externalBin構成へコピーして起動確認した。既存 `src-tauri/bin` の配布用sidecarは上書きしていない。音声ストリーム・録音は開始せず、warmupと `get_audio_state` のIPC応答（config:null）まで確認。
- `tauri-mcp-cli` 0.13.1のdriver接続を確認。identifierは検証用、pluginVersion / serverVersionは0.13.1、versionWarningはnull。WebViewの公開APIからTauri 2.12.4 / アプリ1.1.0を取得できた。
- native APIによる起動画面のキャプチャ、設定画面、メニューのキーボード操作、ウィンドウresize / minimize / maximizeの応答を確認。focus呼出しは成功応答だったが、最小化解除は別操作が必要だった。
- single-instanceは同じ検証用exeを2つ目として起動し、2つ目だけが終了、最初のプロセスが維持されることを確認。
- 権限追加後、実WebView経由のUpdater checkが成功（result:null）。画面の「アップデートを確認」からも「最新バージョンです」の通知を確認し、その時点の公開manifestとの確認経路が動作した。更新適用の成功を意味するものではない。

CLI packageに複数binがあるため、`npx @hypothesi/tauri-mcp-cli@0.13.1` では実行binを決定できなかった。`npx -y --package=@hypothesi/tauri-mcp-cli@0.13.1 tauri-mcp ...` と明示すると実行できた。
Clippyの既存エラー、既存の非推奨・空チャンク警告は残る。署名済みインストーラー生成、旧版からの更新適用・設定移行、トレイ経由の復帰、長時間の音声実機確認、他OSの動作は未確認。
確認用アプリ・サーバー・driver sessionは終了し、通常構成のdebugバイナリを再ビルドした。検証用コピー・設定・画像はignoredなtarget配下に残す。
アプリ番号は1.1.0を維持。次の配布番号は全差分から別途判定する。push・PR作成・タグ・公開・更新のインストールは未実施。

## 音声系の段階更新（2026-10-15）

ブランチ: `codex/audio-dependencies`。着手時の未コミット変更とClippy修正を保持し、OTTの表示崩れには変更を加えていない。
レジストリの最新安定版、取り下げ状態、公式リリースノート、公開ソースを再確認した。
Context7 CLIは認証エラーとなったため、公式資料とcrates.ioの情報を使用した。

| 段階 | 対象 | 実施・判断 |
| --- | --- | --- |
| 1 | CPAL 0.17.1 → 0.17.3 | 同じ0.17系の最新修正版へ限定更新。0.17.2は取り下げ済み。0.17.3は互換性を壊すエラー列挙型変更を戻し、ASIOリンク不具合を修正。WASAPIのOS側リサンプリング変更を含むため実機で比較 |
| 2 | ringbuf 0.4.8 → 0.5.3 | 既知のメモリ安全性の指摘への修正版を採用。公開ソースで使用中のHeapRb、split、try_push / try_pop、pop_slice、容量照会APIを照合。アプリ本体の変更なしで互換性を確認 |
| 保留 | CPAL 0.18.2 | 最新安定版だが、エラー型、ストリーム構築引数、デフォルト設定などの移行が必要。今回の限定更新から分離 |
| 保留 | rubato 0.14.1 → 5.0.1 | リサンプリングAPIとバッファ構造の移行、品質・割当・遅延の測定を伴うため独立して評価する |
| 維持 | RustFFT 6.4.1 / nnnoiseless 0.5.2 / hound 3.5.1 / vst3 0.3.0 | 着手時の解決済み版が最新安定版。更新や置換は不要 |
| 別枠 | winit 0.29.15 → 0.30.13 | エディタのイベントループ移行。今回の音声依存更新やOTT描画修正に混ぜない |

CPALのMSRVは1.78、ringbuf 0.5.3はRust 2024 editionを使用する。確認環境のRust 1.92.0でビルドした。
CPALに伴う推移依存の変更はasio-sys 0.2.5 → 0.2.6、alsa 0.10.0 → 0.11.0、alsa-sys 0.3.1 → 0.4.0、coreaudio-rs 0.13.0 → 0.14.2。
Windows向けライセンス一覧を再生成し、385ライブラリ、CPAL / asio-sys / ringbufの新版収録、ローカルパスの混入がないことを確認した。
Tauriを含むその他のパッケージのバージョンと依存参照先は、着手時のlockfileから変えていない。

一次情報: [CPAL 0.17.3](https://github.com/RustAudio/cpal/releases/tag/v0.17.3)、[CPAL変更履歴](https://github.com/RustAudio/cpal/blob/master/CHANGELOG.md)、[ringbuf 0.5.3](https://crates.io/crates/ringbuf/0.5.3)、[RUSTSEC-2026-0293](https://rustsec.org/advisories/RUSTSEC-2026-0293.html)。

### ローカル検証と残る条件

- `cargo test --locked --lib --bins --test audio_queue_contract`: 既存31テストと追加2テストが成功。追加テストは、リングをまたぐステレオサンプルの順序、満杯時の再試行を含む別スレッド間の20,000コマンドの順序・欠落・重複を確認する。
- `cargo clippy --locked --all-targets`: 成功。前の作業で修正したraw pointerのエラーも再発していない。既存警告は残る。
- 最終構成で `cargo check --locked --all-targets`、`cargo build --locked --bins`、`cargo about generate --locked --fail`、`npm run release:check`、`git diff --check` が成功。
- 新規テストは `rustfmt --edition 2021 --check` が成功。全体の既存未整形箇所は前の作業から残り、今回まとめて整形していない。
- 更新前、CPAL単独更新後、ringbuf更新後を別のエンジンバイナリで比較した。既存の配布用 `src-tauri/bin` を上書きせず、検証物はignoredな `src-tauri/target/audio-update-baseline` に保存した。検証用プロセスは終了済み。
- 仮想WASAPI入力 `CABLE Output` と出力 `CABLE In 16ch` を使用し、出力をミュート。44.1kHz / 48kHz指定、256 / 512フレーム、開始・停止・再設定、処理中のTDR Nova追加、状態保存・復元、削除と遅延解放を確認した。デバイス列挙は3構成とも42件。
- 更新前は44.1kHz指定が48kHzへフォールバックした。CPAL単独更新後と最終構成は同じデバイスで実際に44.1kHzを適用でき、48kHz入力からのリサンプリング経路も動作した。48kHz指定も適用できた。要求値と実レートを区別する。
- Voicemeeter Virtual ASIOは更新前後とも開始できたが、48kHz指定時の実レートはドライバ側の96kHzだった。ASIOで48kHzを確認したとは扱わない。
- アプリ内のglitch指標は、短いバッファとASIOの条件で更新前から増加した。これはコールバック間隔等から算出する値であり、聴感上の音切れ回数ではない。数秒間のミュート確認から、音質・CPU・遅延や長時間安定性の改善は主張しない。

各条件の定常確認3秒間で、最終構成のglitch指標増分はWASAPI 256フレームで291 / 300、512フレームで0 / 0、ASIOで294。
更新前は同じ順に294 / 300、0 / 2、292だった。ただし44.1kHz指定の更新前は実際には48kHzであり、ビルド負荷や測定時刻も異なる。厳密な性能比較には使用しない。
全条件でエンジン応答とVSTの遅延解放を確認し、定常確認中にstream errorの通知はなかった。

RustSec監査には検証用ディレクトリにインストールしたcargo-audit 0.22.2を使用し、同じアドバイザリDBで更新前後のlockfileを比較した。
既知脆弱性の一致は13件から12件へ減少し、ringbufのRUSTSEC-2026-0293が解消。アプリからの攻撃成立を証明する数ではない。
残る一致はquick-xml、rustls、rustls-webpki、tarに関する12件。unmaintained 2件、unsound 5件の情報警告も残る。
全OSを含むlockfileへの監査結果であり、すべてをWindows配布物の実行経路にある問題として扱わない。
CPAL更新だけでは解消しないTLS・XML・アーカイブ関連依存は、到達経路を確認したうえで次の限定更新として扱う。監査全体が成功したとは報告しない。

聴感・信号品質、物理デバイスの抜差し、他のASIOドライバ、長時間連続運転、OBSの再接続、DPI変更、署名済み配布の検証は未実施。
アプリ番号は1.1.0を維持。push・PR作成・タグ・公開は行っていない。

## RustSec指摘への限定更新（2026-10-15）

ブランチ: `codex/rustsec-limited-updates`。前の作業の未コミット変更を保持し、今回の変更はCargo.lock、Windows向けCargoライセンス一覧、本書に限定した。
Cargo.toml、npm依存、アプリ本体、音声ライブラリ、OTT描画には変更を加えていない。

| 対象 | 着手時 → 更新後 | 判断 |
| --- | --- | --- |
| quick-xml | 0.38.4 → 0.41.0 | 2件の指摘の修正済み下限。最新版0.42.0への追加移行は分離 |
| plist | 1.8.0 → 1.10.0 | quick-xml 0.41を使う最小の親。最新版1.10.1はquick-xml 0.42、base64、indexmap、editionの変更も伴うため今回は採用しない |
| wayland-scanner | 0.31.8 → 0.31.11 | 非Windows向けのもう一つのquick-xml依存元。0.31.9 / 0.31.10では修正版に届かない |
| rustls | 0.23.36 → 0.23.46 | 同じ0.23系の最新安定修正版。対象4件の修正済み条件を満たす |
| rustls-webpki | 0.103.9 → 0.103.15 | 同じ0.103系の最新安定修正版。対象4件の修正済み条件を満たす |
| tar | 0.4.44 → 0.4.46 | 同じ0.4系の最新修正版。監査対象2件に加え、0.4.46のPAX同期修正を含む |

`cargo update -p <対象> --precise <版>` で更新し、関係のない同一版パッケージの依存参照先は着手時の解決状態を維持した。
全targetの逆依存木で旧quick-xmlが残らないこと、上記6パッケージ以外のバージョン・依存参照先が変わらないことを確認した。
plistのMSRVは1.88、quick-xml 0.41は1.79。Rust 1.92.0の確認環境で検証した。

### 影響範囲

- WindowsのUpdaterはreqwest経由でrustlsを使用する。証明書・ホスト名検証や配布物の署名検証を弱めず、通信経路の依存版だけを更新した。
- Windowsの証明書チェーン検証はrustls-platform-verifierのOS検証経路。現在のfeaturesはring / std / tls12で、BrotliやハイブリッドPQ鍵交換は有効ではない。独自セッションストアやTLS秘密値のDebug出力もアプリでは確認していない。全指摘が現在のWindows構成で悪用可能だったとは判断しない。
- plistは通常のXML Readerを使い、指摘対象のNsReaderや属性イテレーターへのWindowsアプリ経路は確認できなかった。非WindowsのWayland生成器には属性を読む経路があるが、入力はビルド時のプロトコルXMLであり、遠隔入力による攻撃成立は未立証。
- tarはUpdaterのLinux / macOS向け依存。Windowsはzip / インストーラーを使用するため、Windowsの通常依存木とライセンス一覧にはtarが含まれない。非Windowsの展開より前にはUpdaterの署名検証がある。任意の未署名アーカイブが直接展開されるとは判断しない。

### 検証結果

- 更新前にcargo-audit 0.22.2でDBを更新し、同じDBで更新後を監査。既知脆弱性の一致は12件 → 0件、更新後の終了コードは0。別分類のunmaintained 2件、unsound 5件は残る。
- `cargo check --locked --all-targets`、`cargo test --locked --lib --bins --test audio_queue_contract`（31 + 2件）、`cargo clippy --locked --all-targets`、`cargo build --locked --bins` が成功。既存のClippy警告は残る。
- 管理された隔離ハーネスの5テストが成功。アプリのmanifestへテスト用依存は追加していない。
  - 257個の名前空間宣言は旧quick-xmlでは受理され、新版ではTooManyDeclarationsとして拒否。256個の通常境界は受理。
  - 20,000個の異なる属性を読めること、重複属性を引き続き拒否することを確認。厳密な性能測定ではない。
  - plistの日本語・文字参照・data・日付・配列を含むXML / binary往復保存と、壊れた入力のエラーを確認。
  - PAXサイズが非ゼロの通常ヘッダーより優先され、後続entryも読めることを確認。同じ入力は旧tar 0.4.44で3バイトが1バイトに欠け、新版で成功した。
  - TLSの未信頼証明書を拒否し、隔離fixtureのルートだけを明示した接続では成功。OSの信頼ストアやアプリ設定には証明書を追加していない。
- ビルドした実アプリをAPPDATA / WebView2保存先を分離して起動し、tauri-mcp-cliで接続を確認。公開Updater APIのHTTPS checkが成功（update:null）。音声ストリームは開始せず（config:null）、更新のdownload / install / restartも呼んでいない。アプリ、開発サーバー、driver sessionは終了した。
- Windows向けCargoライセンス一覧を再生成し、plist / quick-xml / rustls / webpkiの版番号更新と、ライセンス種別・repositoryが変わらないことを確認。
- 独立した読取専用の事前調査と候補レビューを実施。対象指摘が残る別依存経路や、具体的な互換性回帰の指摘はなかった。

TLSの各指摘の攻撃パケット、CRL・名前制約の全ケース、Unix固有のsymlink / chmod再現、非Windowsのビルド・実更新、署名済み更新の適用は未検証。
監査一致の解消、隔離した回帰確認、Windows実アプリの更新確認を区別し、全OS・全攻撃ケースの安全性保証とはしない。
アプリ番号は1.1.0を維持。push・PR作成・タグ・公開は行っていない。

一次情報: [quick-xmlのCPU指摘](https://rustsec.org/advisories/RUSTSEC-2026-0194.html)、[名前空間の指摘](https://rustsec.org/advisories/RUSTSEC-2026-0195.html)、[plist変更履歴](https://github.com/ebarnard/rust-plist/blob/master/CHANGELOG.md)、[rustls 0.23.46](https://github.com/rustls/rustls/releases/tag/v%2F0.23.46)、[webpki 0.103.15](https://github.com/rustls/webpki/releases/tag/v%2F0.103.15)、[tar 0.4.46](https://github.com/composefs/tar-rs/releases/tag/0.4.46)。

## 保守停止・unsound警告への対応（2026-10-15）

ブランチ: `codex/rustsec-warning-updates`。着手時の全target監査は脆弱性0件、保守停止2件、unsound 5件。
レジストリ・RustSec・公開ソース・対象別の逆依存木を再確認し、以下の限定更新と機能指定を行った。
Context7 CLIは認証エラーのため、公式情報で照合した。既存の未コミット変更は保持している。

| 警告 | 対応 | 影響範囲・根拠 |
| --- | --- | --- |
| anyhow / RUSTSEC-2026-0190 | 1.0.101 → 1.0.104 | 直依存とTauriの通常・ビルド経路。修正下限1.0.103を満たす同系最新安定版。context後のdowncast_mutの借用規則違反への修正 |
| event-listener / RUSTSEC-2026-0221 | 5.4.1 → 5.4.2 | 非Windowsのzbus / async系。非Sendタグを持つStackSlotのSend / Sync境界を修正 |
| rand / RUSTSEC-2026-0097 | 0.8.5 → 0.8.8 | OBSのobws → tokio-tungstenite → tungstenite経路。同じ0.8系の修正版を採用し、0.9 / 0.10への移行は行わない。既存0.9.4は維持 |
| memmap2 / RUSTSEC-2026-0186 | 依存経路を除去 | 初段で0.9.11へ更新・検証した後、最終構成ではwinitのLinux用機能を無効化したためクレート自体が不要になった |
| ttf-parser / RUSTSEC-2026-0192 | 依存経路を除去 | 修正版はない。winitの既定Linux装飾 → sctk-adwaita → ab_glyph → owned_ttf_parser経路を無効化 |
| proc-macro-error / RUSTSEC-2024-0370 | 保留、警告は維持 | glib-macros / gtk3-macrosの非Windowsビルド依存。修正版はなく、親が ^1.0 を要求。manyhow等の追加だけでは既存経路を置換できない |
| glib / RUSTSEC-2024-0429 | 保留、警告は維持 | 非WindowsのGTK3 / WebKit経路。修正版は0.20以降だが、現行Tauri / GTKが0.18系を要求。別版の直接追加では旧版が残る |

### Windows専用方針との整合

`README.md`、`BUILD_GUIDE.md`、`RELEASE_PLAN.md`のサポート対象はWindows 11 x64のみ。
この方針に合わせ、winit 0.29.15を `default-features = false, features = ["rwh_06"]` とした。
VSTエディタが使うWindowsのWindowBuilder / EventLoopWindowTarget / Win32 HWNDのAPIと、raw-window-handle 0.6は維持する。
X11、Wayland、Linux側の装飾・フォント描画の既定機能を有効化しないため、Linuxでwinitを使用する構成には別途バックエンド機能の再指定と検証が必要になる。
これはライブラリのメジャー移行やOTT描画の修正ではない。

この機能指定の変更前後で、Windows向けの `cargo tree --locked --target x86_64-pc-windows-msvc` の出力が一致することを確認した。
21個の未使用の推移依存がlockfileから除かれた。残る依存の無関係な版・参照先は維持し、同一名の複数版が減った箇所の表示上の版修飾はCargoの形式に合わせている。
最終の版更新はanyhow、event-listener、rand 0.8の3件。音声処理実装、CPAL / rubato / ringbuf、winitの版、npm依存、アプリ番号1.1.0は変えていない。

### 検証と残件

更新後の全target監査は脆弱性0件、保守停止1件、unsound 1件（警告計7件 → 2件）。
残るproc-macro-errorとglibは、Windows向けの逆依存木には存在しない。auditのignoreや警告抑制は追加していない。
これはWindowsでの悪用可能性を推測でゼロとする判断ではなく、現在の対象別依存木に含まれないことを確認した結果である。

隔離ハーネスの通常5テストとcompile-fail 2テストが成功した。アプリのmanifestにテスト用依存は追加していない。
最終構成の `cargo check --locked --all-targets`、`cargo test --locked --lib --bins --test audio_queue_contract`（31 + 2件）、`cargo clippy --locked --all-targets`、`cargo build --locked --bins` が成功した。既存のClippy警告は残る。
Windows向けCargoライセンス一覧を再生成し、anyhow / rand 0.8の新版を収録した。ライブラリ数は385件で変わらず、Unix専用のevent-listener / memmap2 / ttf-parserが追加されていないことも確認した。
`npm run release:check` と `git diff --check` が成功。Rust実装・既存テスト・npm manifest / lockfileのハッシュは着手時と一致する。

- anyhowのcontextを付けたエラーの型復元・変更、表示とroot causeを確認。Miriによる未定義動作検出は未実施であり、通常テストだけを借用規則違反の不存在の証明にはしない。
- event-listenerの非Sendタグに対するSend / Syncの2例が修正版でコンパイルを拒否し、旧5.4.1では同じ例がコンパイルできることを対照確認。Send可能なタグと別スレッドからの通常通知も確認した。
- memmap2の正常範囲のflushとファイル内容保存、境界超過・usize::MAXを含む範囲のInvalidInputをWindowsで確認。最終アプリではこの依存経路自体を除去している。Unix専用advise_rangeは未検証。
- randのlog機能を明示した条件で200,000バイトを生成し、旧0.8.5で発生した再シード時のログ呼出しが0.8.8では発生しないことを確認。ログ側から乱数へ再入してUBを起こす試験は行っていない。
- 既存と同じobws 0.11.5 / tokio-tungstenite 0.20.1を使い、隔離したローカルOBS WebSocket模擬サーバーへ接続、Identify、GetVersionの要求・応答を確認。実OBSへの設定変更・録画・配信操作は行っていない。
- 最新のビルド済みエンジンでTDR Novaの実エディタを表示し、重複起動防止、リサイズ、閉じる・再表示を3回、表示中の削除とプロセス応答を確認。画像で描画も確認した。音声ストリームは開始せず、検証用プロセスは終了した。OTTには変更を加えていない。

proc-macro-error / glibは、Tauri / Wry / GTKの親依存が修正版・保守された代替に対応した時点で再評価する。
必要なら別の変更として、バックポートの保守方針とLinuxでの検証環境を定める。単独override、警告件数だけを目的にした版偽装、未検証のGTK移行は採用しない。
今回の検証はWindows 11 x64。実OBS認証・再接続・メーター、Linux / macOS、長時間音声、署名済み配布・更新適用は未検証。
push・PR作成・タグ・公開は行っていない。

一次情報: [anyhow](https://rustsec.org/advisories/RUSTSEC-2026-0190.html)、[event-listener](https://rustsec.org/advisories/RUSTSEC-2026-0221.html)、[memmap2](https://rustsec.org/advisories/RUSTSEC-2026-0186.html)、[rand](https://rustsec.org/advisories/RUSTSEC-2026-0097.html)、[proc-macro-error](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)、[ttf-parser](https://rustsec.org/advisories/RUSTSEC-2026-0192.html)、[glib](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)。

## 整備差分全体のレビュー（2026-10-15）

ブランチ: `codex/review-maintenance`。HEADとの差分と未追跡の規約・テストを含め、依存更新、VSTエディタのClippy修正、バージョン・配布方針を確認した。
依存の追加更新や音声処理の変更は行っていない。VST切断を親HWND破棄より先にする変更、Windows専用のwinit機能指定、Updaterの使用APIに対応した権限に、今回の確認で具体的な回帰は見つからなかった。

### 発見した不足と修正

- 配布用sidecarの準備処理に、release成果物が欠落すると古いdebug版をコピーする経路が残っていた。代用を削除し、両release成果物の存在確認後にコピーする。欠落・Cargo失敗時に既存sidecarを変更しない回帰テストを追加した。
- sidecar用の開発・配布ビルドがlockfile固定を明示していなかった。両スクリプトに `--locked` を追加し、検証した依存解決を使う方針に揃えた。
- 新設したバージョン同期の公開前CLI経路に回帰テストがなかった。一時リポジトリで通常成功、各同期先の版不一致、壊れたlockfile、確認時に書き込まないことを検証するテストを追加した。
- READMEの「独自GUI非対応」とsidecar準備を省いた起動例を現行実装へ合わせた。OTTの既知の表示崩れは未修正として明記した。
- ビルドガイドのRustテスト例を音声入力を開始しない範囲へ絞り、全テストには実機操作が含まれることを明示した。

### 今回のローカル確認

- `npm ci`、`npm ls --all` が成功。npm監査は脆弱性0件。インストール時に開発ツールの非推奨依存などの警告は残る。
- フロント33テスト、配布スクリプト27テスト、TypeScript検査、Vite production buildが成功。Viteの空のvendor-reactチャンク警告は残る。
- `cargo test --locked --lib --bins --test audio_queue_contract` は31 + 2件成功。`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets`、`cargo build --locked --release --bins` も成功。既存のClippy警告は残り、警告ゼロを意味しない。
- Cargoライセンス一覧を別ファイルへ再生成し、収録済み一覧とのSHA-256一致を確認。npmライセンス73件はlockfileの版と一致した。
- RustSec DBを更新して再監査し、既知脆弱性0件、保守停止1件・unsound 1件。残るproc-macro-error / glibはWindowsの逆依存木に含まれない。
- APPDATA / WebView2保存先を分離したdebug実アプリで、MCP bridge 0.13.1の接続、初回ウィザードを閉じた後の設定画面・外観タブ切替・描画、HTTPS Updater check（update:null）を確認。音声ストリームは開始しなかった。今回起動したアプリ・devサーバー・driver sessionは終了した。
- `release:check` とバージョン同期確認が成功。アプリ番号は1.1.0を維持した。

releaseバイナリのコンパイル成功は、署名済みインストーラーや旧版からの更新適用の成功を意味しない。配布先の既存sidecarは上書きせず、今回の準備スクリプトのコピー動作は隔離fixtureで確認した。
長時間音声・全デバイス切替・全VST/DPI・実OBS・設定移行・署名済み配布と更新適用は未検証であり、公開前の確認事項として残す。
音声系の大幅移行、OTT修正、push・PR作成・タグ・公開は行っていない。
