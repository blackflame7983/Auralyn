# VST Host UI/UX 厳評レビュー (統合版 / 2026-01-12)

## 前提とゴール
- 対象ユーザー: 配信者 / Discord通話でVSTを使いたい初心者、日本語ユーザー
- ユーザーの目的: 「ノイズを消したい」「声を良くしたい」＝設定したいのは“音”であり“数値”ではない
- ゴール: **5分以内に音が出て、事故らず運用できる**
- 評価対象: UI/UX、機能導線、ヘルプ/マイクロコピー（コードベースから確認できる範囲）

## 総評 (辛口)
現状は「機能は足りてきているが、親切さが足りない」状態です。  
DAW的な前提（Host/Buffer/SampleRate）をそのまま露出しているため、**“ノイズを消したい/声を良くしたいだけ”**の層にとって心理的負担が大きい。  
結果としてコンセプトの「簡単に使える日本語ホスト」に対し、**入口の言葉・最短導線・安全ガードが弱く、初見離脱の確率が高い**です。

---

## 強み (伸ばすべき点)
- セットアップ診断（仮想デバイス/VB-CABLE/Voicemeeter前提の提案）が既にある
- レベルメーターなど「配信者が安心できる要素」を実装している
- プラグインチェーンの並べ替えなど、UXの土台はある

---

## P0: 今すぐ直すべき致命的な問題

### 1. 絵文字が文字化けして `??` 表示になっている（信頼を即失う）※恐らく文字コードの影響など
**問題**: ガイドやヒントで絵文字が `??` になり、未完成/危険そうに見える。  
**影響**: 初見で離脱（「壊れてる」「怪しい」）。  
**改善案**: **絵文字を廃止し、SVGアイコンに統一**。アイコンセットは **Material Symbols（SVG）** に寄せる。  
具体策:
- UI上のアイコン: Material Symbols (SVG) をコンポーネントとして使用（テキストに混ぜない）
- 文字列内（例: `details.push()`）の絵文字: 削除して `推奨:` `注意:` `完了:` のような接頭辞に置換
**該当例**:
- `vst-host/src/components/features/Guide/OBSGuideModal.tsx`
- `vst-host/src/components/features/SetupWizard/SetupWizardModal.tsx`
- `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`

### 2. 日本語アプリなのに英語が刺さる（安心感を損なう）
**問題**: UI/Toast/ラベルに英語が混ざる（特にエラーや失敗が英語）。  
**影響**: “海外製の難しいソフト感” が出て、初心者が身構える。  
**改善案**: **ユーザーに見える文字列は100%日本語**（必要なら括弧で英語補足）。

具体的に直すべき箇所（例）:
- ファイルD&Dのトースト: `Unsupported file` / `Failed to load...` を日本語化し、次の行動まで書く
- OBS連携: `Host/Port/Password` を日本語へ（入力の意味が分かるように）
- UIボタン/ラベル: `EDIT`, `MASTER` などを日本語へ

**該当例**:
- `vst-host/src/App.tsx`
- `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`
- `vst-host/src/components/features/PluginRack/PluginCard.tsx`
- `vst-host/src/components/layout/MasterBar.tsx`

### 3. 初回導線が「音を出す」まで足りない（3分で詰む）
**問題**: 初回で「何を選べば音が出るか」が見えない。  
**影響**: 目的達成前に離脱。  
**改善案**: 1画面で完結する **“クイックスタート”** を用意し、最短導線を固定する。

最低限の一本道:
1) マイク（入力）を選ぶ  
2) 出力先（OBS/Discord）を選ぶ  
3) テストで確認（レベルメーターが動く / 聞こえる）

### 4. “放送事故” に弱い（パニックボタンがない）
**問題**: 配信中に割れ/ノイズ/無音になった時の「とりあえず安全化」導線がない。  
**影響**: パニック→事故。ユーザーの信頼を失う。  
**改善案**: ヘッダーに **緊急バイパス（全エフェクトOFF）** を常設。

仕様案:
- 「全エフェクトOFF」= チェーン全体をバイパス（生音に戻す）
- 状態が常に見える（ON/OFF + 色 + ツールチップ）
- キーボードショートカット（例: `Alt+P`）

### 5. 破壊的操作が軽い（削除/並べ替え）
**問題**: プラグイン削除がホバーで出て即実行、Undoなし。  
**影響**: 誤操作で復元不能→不信感。  
**改善案**:
- 削除は確認 or Undoトースト（10秒以内で復元）
- 並べ替えは専用ドラッグハンドルで開始（カード全体がドラッグだと誤爆が起きやすい）

---

## P1: 大きな改善が必要な問題（“DAW臭さ” を消す）

### 6. オーディオ設定が数値だらけで判断できない
**問題**: `512 samples` を見ても「速い/遅い/重い」が分からない。  
また、初心者が読むべきヒントが折りたたまれている。  
**改善案**: **簡易モード（デフォルト） + 詳細モード** に分離する。

簡易モード案（例）:
- 遅延/安定性: `低遅延` / `バランス` / `安定` の3択（内部で 128/512/1024 を割当）
- 音質: `配信(48kHz)` / `音楽(44.1kHz)` / `高音質(96kHz)`
- 「迷ったらこれ」: `配信向け推奨を適用`（1クリックで設定＆開始）

詳細モード:
- 現行のバッファ/サンプルレートの直接指定

**該当例**: `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`

### 7. レイテンシの見せ方が弱い（安心につながっていない）
**問題**: 推定レイテンシが“補助情報”扱いで目に入らない。  
**改善案**:
- 設定画面に「推定レイテンシ」を大きく表示し、色/ラベルで評価（例: 10ms以下=緑/最高）
- ヘッダーのEngineステータスにも同じ基準のラベルを表示

**該当例**: `vst-host/src/components/features/DeviceStatus/DeviceStatus.tsx`

### 8. VB-CABLE導入後の導線が弱い（“インストールした”の次がない）
**問題**: 「インストールしてください」で止まりやすい。  
**改善案**: 診断結果に **「インストールしました → 再スキャン」** の大きいボタンを追加し、フローに組み込む。

期待挙動:
- 押下 → `fetchDevices(true)` → 再診断 → 推奨設定が出たらワンクリック適用

**該当例**: `vst-host/src/components/features/SetupWizard/SetupWizardModal.tsx`

### 9. 常時確認できるメーターが欲しい（配信者の安心材料）
**問題**: `LargeLevelMeter` はオーバーレイで、作業を邪魔しやすい。  
**改善案**:
- “ドック型/ミニフロート型” のメーターを常時表示できるようにする
- 「マイクが拾っているか」「割れてないか」が常に見える状態をデフォルトに寄せる

### 10. OBS連携が手動入力前提で脱落を招く
**問題**: `localhost` や `4455` を手で入力させるのはハードル。  
**改善案**:
- 初期値として `localhost:4455` を入力済みにする（プレースホルダーでなく）
- 接続失敗時に、次に見るべきOBS設定箇所を “図解/スクショ付き” で誘導（ヘルプに飛ばす）

**該当例**: `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`

### 11. ヘルプがOBS寄りでDiscord導線がない
**問題**: Discord用途の“勝ち筋”が用意されていない。  
**改善案**: 「Discord通話」専用ガイドを追加し、最短手順と事故回避を明示。

最低限入れる内容:
- Discordの入力デバイスを `CABLE Output`（等）にする
- 自分の声が二重になる/ハウリングする場合の回避（モニターOFF、Windows既定デバイスの見直し）

---

## P2: 品質/一貫性の問題（積み上げで効く）

### 12. デザインが“一貫していない”
**問題**: 一部はサイバー/グロー寄り、一部は管理画面寄りで、世界観が揺れる。  
**改善案**:
- “落ち着いた既定” + “ゲーミング強め” を切り替え可能にする（設定）
- 色/余白/影/角丸をトークンで統一（モーダルごとの独自クラスを減らす）

### 13. 外部URL依存の背景ノイズ（オフラインで欠ける）
**問題**: 外部URLのノイズ画像に依存している。  
**改善案**: ローカルアセットに同梱し、オフラインでも完全動作。

---

## マイクロコピー改善案（置換例）
“専門用語の意味を伝えつつ、初心者を怖がらせない” を最優先にする。

- `Host` → `音声方式（低遅延ならASIO / 迷ったらWASAPI）`
- `Input` → `マイク（入力）`
- `Output` → `出力先（OBS/Discord）`
- `Buffer Size` → `遅延調整（バッファサイズ）`
- `Sample Rate` → `音質設定（サンプルレート）`
- `保存して開始` → `この設定で開始`
- `EDIT` → `編集（プラグイン設定）`
- `BETA` → `ベータ版（不安定な場合があります）`

Toast例（ファイルD&D）:
- `Unsupported file: ...` → `このファイルは追加できません（VST3のみ対応）`
- `Failed to load ...` → `読み込みに失敗しました（VST3/64bit/権限を確認してください）`

---

## 実装タスク（ファイル単位の具体化）
「どこを直すか」が曖昧だと進まないので、実装単位に落とす。

1. アイコン（絵文字）排除 → Material Symbols SVGへ統一  
   - `vst-host/src/components/features/Guide/OBSGuideModal.tsx`  
   - `vst-host/src/components/features/SetupWizard/SetupWizardModal.tsx`  
2. 英語表示の全廃（UI/Toast/Tooltip）  
   - `vst-host/src/App.tsx`（ファイルD&Dのトースト）  
   - `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`（OBS連携のラベル）  
   - `vst-host/src/components/features/PluginRack/PluginCard.tsx`（EDIT）  
   - `vst-host/src/components/layout/MasterBar.tsx`（MASTER / Tooltip）  
3. 緊急バイパス（全エフェクトOFF）追加（ヘッダー常設）  
   - `vst-host/src/components/layout/Header.tsx`（ボタン追加）  
   - `vst-host/src/api/audio.ts`（必要なinvoke追加の検討）  
4. オーディオ設定: 簡易/詳細モード  
   - `vst-host/src/components/features/AudioSettings/AudioSettingsModal.tsx`  
5. セットアップウィザード: 「インストールしました → 再スキャン」フローを追加  
   - `vst-host/src/components/features/SetupWizard/SetupWizardModal.tsx`

---

## まとめ（優先度）
1. **必須**: 文字化け絵文字の排除（Material Symbols SVG化）
2. **必須**: アプリ内テキストの日本語化（エラー/Toast/ラベル）
3. **必須**: 緊急バイパス（全エフェクトOFF）で“事故らない”導線
4. **推奨**: オーディオ設定の簡易モードで“迷わせない”
5. **推奨**: メーターの常時表示で“安心させる”

現段階で最大の課題は「機能不足」ではなく、**“分かる言葉と一本道の導線不足”**です。  
“最短で音が出る” を作るだけで、体験は一気に改善します。
