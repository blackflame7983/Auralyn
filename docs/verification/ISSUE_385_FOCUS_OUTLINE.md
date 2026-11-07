# #385 forced-colors のフォーカス監査

対象は `src/` 全体の `outline-none` と CSS の `outline: none`。文言・DOM構造・音声処理は変更しない。

`outline-hidden` は通常時に輪郭を隠し、forced-colors では2pxの実線（transparentをOSの色へ調整）を残す。
元が無条件の `outline-none` でも、置換先は `focus:outline-hidden` とする。
これにより、ハイコントラスト時にフォーカスしていない項目まで囲むことを避ける。
元の `focus-visible` 条件、背景・ring・影・テーマ・モーションの指定は維持する。

## 全件の判断

パスは `src/components/` からの相対表記。

| ファイル・部品 | 箇所数 | 判断・理由 |
| --- | ---: | --- |
| `ui/dropdown-menu.tsx` 通常・チェック・ラジオ・サブメニュー項目 | 4 | `focus:outline-hidden`。Radixの矢印移動でDOMフォーカスと `data-highlighted` が追従する既存DOM試験を拡張。forced-colors時だけoffsetを-2pxにし、親のoverflowによる切り抜きを避ける。影による通常時の内側線は維持 |
| `ui/button.tsx` | 1 | `focus-visible:outline-hidden`。ringが消えてもキーボードの輪郭を残す |
| `ui/tabs.tsx` タブ・パネル | 2 | `focus-visible:outline-hidden`。選択中の影とキーボードフォーカスを区別 |
| `ui/slider.tsx` つまみ | 1 | `focus-visible:outline-hidden`。ring消失への対応 |
| `ui/switch.tsx` | 1 | `focus-visible:outline-hidden`。ring消失への対応 |
| `ui/radio-group.tsx` | 1 | `focus:outline-hidden`。既存のfocus条件を維持 |
| `ui/badge.tsx` | 1 | `focus:outline-hidden`。通常は非操作のdivだが、tabIndex等を受け取れるため共通のフォーカス指定を修正 |
| `features/AudioSettings/AudioSettingsModal.tsx` select・input | 7 | `focus:outline-hidden`。背景・枠色・ringだけに依存しない |
| 同ファイルの閉じるボタン | 1 | 対象外。`focus:not-focus-visible:outline-none` はポインター時だけ。キーボードには `focus-visible:outline-2` と `focus-visible:outline-primary` の実線あり。静的試験の許可リストに理由付きで記録 |
| `features/AudioSettings/ObsConnectionSettings.tsx` | 3 | `focus:outline-hidden`。接続入力欄のring消失への対応 |
| `features/AudioSettings/SystemSettings.tsx` | 1 | `focus:outline-hidden`。入力欄のring消失への対応 |
| `features/SetupWizard/SetupWizardModal.tsx` | 4 | `focus:outline-hidden`。select・inputのring消失への対応 |
| `features/PluginBrowser/PluginBrowserModal.tsx` | 1 | `focus:outline-hidden`。検索入力のring消失への対応 |
| `features/Settings/LicenseModal.tsx` | 1 | `focus:outline-hidden`。検索入力のring消失への対応 |
| `features/Templates/TemplateWizardModal.tsx` | 1 | `focus:outline-hidden`。入力欄の枠色だけに依存しない |
| `features/Tutorial/TutorialOverlay.tsx` | 1 | `focus:outline-hidden`。Popover.Contentのプログラムによるフォーカスでも輪郭を残す |
| `ui/SegmentedControl.tsx` | 0 | 対象外。既に `focus-visible:outline`・`outline-2`・`outline-ring` の実線を使用 |
| `src/index.css` のラック見出しの `outline: none` | 2ルール | 対象外。非操作見出しへのポインター経由のフォーカスだけを抑制。キーボードフォーカスの輪郭は抑制しない |

`src/` で見つかった `outline-none` は31箇所中30箇所を修正し、1箇所は上記理由で維持。
独立した共通select部品はなく、該当するネイティブselectは各画面側で修正した。

## 再発防止と確認の境界

- `src/__tests__/focusOutline.test.ts` は試験用コード以外のTS・TSX・CSSを再帰走査し、共通クラス定数も含め `outline-none` の派生クラスを検出する。例外の追加・重複・不要化も検出する。
- `ui/__tests__/dropdown-menu.test.tsx` は矢印移動・disabledのスキップ・サブメニュー移動と、全種類の項目のフォーカスクラスを確認する。jsdomでは実際のCSS描画を検証できない。
- `e2e/browser/forced-colors-focus.spec.ts` は3テーマでforced-colorsをエミュレートし、ヘルプメニューをキーボードで開いて移動する。DOMフォーカス、highlight属性、実線・2px幅・内側offset、Escape後のフォーカス復帰を検査する。Playwrightの実行はユーザーが行う。
- Windowsの実際のコントラストテーマを有効にしたWebView2では、メニュー全種類と各入力部品の輪郭・背景との判別・切り抜き、通常3テーマの見た目、動きを減らす設定を別途確認する。ブラウザのエミュレーションはOS設定を使った実機確認の代わりにはしない。

## ローカル検証結果（2026-11-06）

| コマンド | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 成功。初回は新規静的試験のreplaceAllがES2020に非対応で失敗し、split/joinへ修正して再実行成功 |
| `npx tsc --noEmit -p tsconfig.e2e.json` | 成功 |
| `npm test -- --run --maxWorkers=2` | 155ファイル中154成功・1失敗、1,633試験中1,632成功・1失敗。新規静的試験2件と拡張メニューDOM試験1件は成功 |
| `npx vite build` | 成功。PluginBrowserModalの静的・動的import混在警告あり（import構成は未変更） |
| `git diff --check` | 成功 |

失敗した既存試験は `src/components/features/AudioSettings/__tests__/AudioSettingsSelection.test.tsx:201` の
「学習の中止失敗を未処理のPromise拒否にせず、状態再取得から再試行できる」。
`測定状態を取得できません。再取得してください。` がDOMに見つからず失敗した。
今回のクラス変更との因果関係・変更前の再現性は未確認であり、範囲外の修正はしていない。

ビルド後のCSSで、`focus:outline-hidden` のforced-colors時の2px実線と、
それより後に出力されるメニュー用の `outline-offset: -2px` を確認した。
通常テーマの視覚比較、Playwright実行、実WebView2での確認は未実施。
既存の編集対象ファイルはCRLFを維持した。
