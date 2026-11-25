# コードベースのガードと検証

新規・変更コードで、型逃げ、依存の逆流、所有者のない副作用を増やさないための検査である。
成功は仕様全体の正しさや実音声の品質を保証しない。

## 一つの入口から検証する

初回は`npm ci`と、Python 3.12以降で次を実行する。

```powershell
python -m pip install --target node_modules/.cache/auralyn-python -r requirements-dev.txt
npm run verify -- --changed
```

| コマンド | 対象 |
| --- | --- |
| `npm run verify -- --static` | 設定指紋、全TS/E2EのLint、Python、Rust抑制・RT検査適用、検査器の負例試験、型検査2系統、用語 |
| `npm run verify -- --changed` | staticと、未コミット・新規ファイルに対応するVitest。未知の経路・設定変更は全Vitestとフロントビルド・配布スクリプト試験へ戻す |
| `npm run verify -- --feature connection` | staticと機能のVitest。`home`、`vst`、`voice-check`、`restore`も指定可能 |
| `npm run verify -- --feature home --browser` | 上記と、その機能のPlaywright。ローカルChromiumの準備が必要 |
| `npm run verify -- --full` | static、全Vitest、Vite、配布スクリプト、リリース方針 |
| `npm run verify -- --static --rust` | staticと、容量・他ビルド確認、Rust fmt、Clippy全target（workspace 全体）、auralyn-core の試験、gain ramp・比較・native変換の既存試験 |

`--changed`はHEADからの未コミット差分を使う。コミット済み変更には`--feature`か`--full`を使う。
機能の対応は`config/verification-features.json`にあり、未知の機能名は失敗する。テスト0件を合格にしない。文書のみ・差分なしでは理由を表示してテストを省く。
共有hook・API・イベントの影響はimportだけでは決まらないため、未知の変更は広い検証へ戻す。機能選択は開発中の短い確認用であり、CIは常に全Vitestと既存の全ブラウザ試験を実行する。

成功時は検査名と所要時間、失敗時は末尾の診断・再実行コマンド・詳細ログを表示する。
実行ごとに`test-results/gardening/<時刻>/summary.json`と各ログを残す。ignore済みの検証証跡であり、コミットしない。
Rustは既存のCargo targetを再利用する。大容量領域の準備・終了時の整理は[BUILD_GUIDE](BUILD_GUIDE.md)に従う。

## 既存違反を固定する

`config/gardening-baseline.json`は導入時のTS・E2E違反を、ファイル・ルール・トップレベル宣言のソース指紋・件数・理由で固定する。改行コードは正規化し、抑制・言い訳コメントは診断箇所の内容も固定する。
inlineのLint設定は実行時に無効化し、既存のdisable自体も検査する。ファイル全体のdisableを増やす代わりに外部台帳で隔離し、製品コードへの大量の抑制コメント挿入を避けている。

- 新規の宣言・ファイル・違反、件数増加は失敗する。
- 違反を持つ宣言を編集すると免除は失効する。残る違反も修正し、不要な台帳項目を削除する。
- 同じファイルの別宣言の編集では、未変更の既存負債まで書き直さない。
- 違反を減らしたときは台帳の件数・不要項目を減らす。指紋を書き換えて追認しない。
- 台帳を自動生成・更新するコマンドは提供しない。新しい例外は、人間が対象・理由・撤去条件を承認した場合だけ追加する。

PythonはRuffの重大エラー・未定義名・裸のexcept・抑制を検査し、ASTで同じ隔離方式を使う。導入時のPython例外は0件である。
Rustの既存`allow/expect`は`config/gardening-rust-baseline.json`でファイル指紋ごとに固定する。Rustの抑制検査は属性の字句的検出であり、完全なRust AST解析ではない。

## 検査対象と限界

TSは明示的any・非null・unsafe操作・未処理Promise・Hooks・副作用・依存境界を検査する。
独自ルールはReactの別名import、window/globalThis経由のタイマー、単純な別名・分割代入、相対パスと`@/`、再export、動的importも対象にする。
既存のfeature内`use*.ts`は専用hookとして扱う。タイマー生成は`src/hooks/internal/`へ限定し、hookへ移動するだけでは免除しない。
描画ループの入口は`src/hooks/useAnimationFrame.ts`。非表示・動きを減らす設定では、呼出し側から`enabled=false`を渡す。
一般的な`as`、数値リテラル、bool、コメントを一律に違反にはしない。テーマ色の検査はJSXの直書き色に限る。Canvasの色全体、任意の計算の責務、コメントの意味まで自動判定するものではない。

Rustは`await_holding_lock`をdenyし、`gain_ramp`・`comparison`の製品処理と`native_stream`の入出力変換でClippyの禁止API・型を有効にする。
`Cargo.toml`では禁止API・型のlintを既定でallowとし、上記RT境界のdeny属性で有効にする。禁止リストを設定しただけで制御処理・テストのI/Oまで警告にしないための適用範囲指定である。
制御スレッドの有限待機や起動時の確保まで禁止しない。新しいRT経路には同じ検査を付け、既存の割当・解放計測も実行する。
禁止リストは全呼出し先を解析するRT安全証明ではない。間接的な確保・プラグイン内部・実機driverは別途検証する。
コメントの禁句検査は候補の検出にすぎない。数学・仕様・公開API・`SAFETY:`・ライセンスは残し、コードの言い換えや古い説明はレビューで取り除く。

## 設定変更をレビューする

`config/gardening-policy.json`は検査設定、台帳、検査器、検証コマンド、CIの承認済み指紋を持つ。改行コードの違いは無視する。
`package.json`はscriptsと検査ツールの版を検査し、アプリ番号だけの変更は妨げない。
`Cargo.toml`はlintsセクションを検査する。
指紋の不一致は失敗する。必要な強化・例外削除・依存更新でも、対象差分と実結果を確認して指紋を更新し、更新理由をレビューへ示す。通過のための緩和や負債の追認には使わない。

`.github/CODEOWNERS`はガード変更のレビュー先を指定する。実際の強制にはGitHub側で必須チェックとCode Ownerレビューを保護する設定が必要である。
同じ書込権限を持つ実行者は検査器と指紋の両方を変更できるため、指紋だけを敵対的改ざんへの防壁とは扱わない。GitHub設定の変更は対象と影響を示し、明示承認を得て行う。
2026-11-17の設定確認と、承認後に必須CIを適用した記録は[整備後の確認](proposals/gardening-follow-up.md)を参照する。

## 不変条件と再現

`routing.property.test.ts`は実関数に対し、保存往復、不正入力拒否、ASIOの全チャンネル被覆、安定順序・非破壊、メーターの範囲・単調性を検証する。
通常は固定seedで200回実行する。失敗時の最小反例を例示テストへ残し、再現にはログのseedとpathを指定する。

```powershell
$env:FC_SEED = '<失敗ログのseed>'
$env:FC_PATH = '<失敗ログのpath>'
npm exec -- vitest run src/lib/__tests__/routing.property.test.ts -t '<失敗したテスト名>'
Remove-Item Env:FC_SEED, Env:FC_PATH
```

モックの有無だけで試験を評価しない。API境界で失敗・遅い応答を注入し、値・保存の有無・操作可能状態を確認する。
上限の誤り、奇数末尾、失敗後の保存、停止後のpoll再開など、具体的な誤実装を検知できるかを重視する。

## UI・非同期フローを確認する

[feature-map](feature-map.md)から画面・テストへ進む。Playwrightでは固定sleepより、要素・IPC結果・レイアウトの安定条件を待つ。失敗時はtraceと実行時例外・未定義IPCを確認する。
実Tauriの操作は[TESTING](TESTING.md)の隔離環境とTauri MCPの手順を使う。IPCモックと実機・聴感・長時間運転を分けて記録する。
複雑な状態変更の説明には、次のようなユーザー視点の図を添える。変更する実装のイベント・取消・失敗に合わせて書き換え、図だけで検証済みと扱わない。

```mermaid
stateDiagram-v2
    [*] --> 停止
    停止 --> 接続中: 開始
    接続中 --> 稼働: 接続成功
    接続中 --> 停止: 取消
    接続中 --> 要確認: 接続失敗
    要確認 --> 接続中: 設定を修正して再試行
    稼働 --> 停止: 停止
```
