# ホスト側 AI ノイズ機能 実装具体化メモ

## 目的

VST プラグイン化ではなく、まず Auralyn 本体のホスト機能として以下を実装する。

- `Smart Noise Learn`
  - 数秒間の環境音サンプリングから、定常ノイズを学習して抑制量を自動調整する
- `Venue Mode`
  - ゲームセンターやイベント会場のような騒音環境で、近接話者を優先して通す

このメモは、現状コードの確認結果を踏まえた実装差分の整理である。

## 現状のコード確認

### 既にあるもの

- ノイズ低減のリアルタイム経路は存在する
  - `src-tauri/src/audio_engine/core.rs`
  - `RtNoiseReducer` が `nnnoiseless::DenoiseState` を使って 2ch に対して処理している
- エンジン設定は IPC 経由で切り替えられる
  - `src-tauri/src/ipc.rs`
  - `Command::SetNoiseReduction { active, mode }`
- ホスト層から Tauri command で叩ける
  - `src-tauri/src/audio.rs`
  - `src-tauri/src/lib.rs`
- フロント側には既に UI がある
  - `src/components/layout/MasterBar.tsx`
  - `src/components/features/AudioSettings/AudioSettingsModal.tsx`

### 現状の制約

- モードは実質 `OFF / low / high` のみ
- 学習状態や環境プロファイルの概念がない
- ランタイム統計は `有効かどうか` と `遅延` 程度しか返していない
- 処理順序は
  - 入力ゲイン
  - 入力チャンネル選択
  - ノイズ低減
  - VST チェーン
  - 出力
  になっており、ここに `学習` と `Venue Mode` を足すのが最も自然

## 実装方針

### 基本方針

- 既存の `SetNoiseReduction(active, mode)` をいきなり壊さない
- まずは後方互換を維持したまま、内部構造を `NoiseControlConfig` 相当に拡張する
- UI も最初は既存トグルを残しつつ、設定モーダルに詳細項目を追加する

### 目標機能の分解

#### 1. Smart Noise Learn

想定仕様:

- ユーザーが「3秒学習」を開始
- その間、入力バッファから環境ノイズ統計を収集
- 学習結果から以下を決定
  - 帯域別ノイズ床
  - 推奨 suppression 強度
  - 推奨 gate threshold
- 学習後、既存の RNNoise 系処理に加えて、軽い帯域別 suppression を事前適用

効きやすい対象:

- 空調
- PC ファン
- 電源ハム
- 筐体の持続ノイズ

効きにくい対象:

- 周囲の会話
- BGM
- 突発音

#### 2. Venue Mode

想定仕様:

- 近接話者優先
- 非定常ノイズ環境向け
- 子音欠けを減らす
- 強すぎる suppression によるロボ声を抑える

MVP でやること:

- `Smart Noise Learn` の結果を土台にする
- 軽い VAD を追加
- 話者不在時だけ強めに抑制
- 話者あり時は suppression を弱める
- リリースを長めにして語尾欠けを防ぐ

MVP でやらないこと:

- 特定話者の埋め込みベース認識
- VoiceFilter 系のターゲット話者分離
- GPU 前提の重いモデル

## 推奨する処理順序

現状の処理箇所:

- `src-tauri/src/audio_engine/core.rs`
  - 入力ルーティング後
  - VST チェーン前

拡張後の想定順序:

1. 入力ゲイン
2. 入力チャンネル選択
3. 学習用メトリクス収集
4. 学習済みノイズプロファイルによる前段 suppression
5. RNNoise 系ノイズ低減
6. Venue Mode 用の VAD ベース補正
7. VST チェーン
8. 出力ゲイン

理由:

- 学習系とノイズ抑制を VST より前に置くと、VST の EQ やコンプによる誤学習を避けられる
- A/B 比較と遅延表示も既存ロジックに乗せやすい

## 追加すべきデータ構造

### Engine 側

対象:

- `src-tauri/src/audio_engine/core.rs`

追加候補:

- `noise_control_enabled: bool`
- `noise_control_mode: String`
  - `legacy_low`
  - `legacy_high`
  - `smart`
  - `venue`
- `noise_learning_state: String`
  - `idle`
  - `capturing`
  - `ready`
- `noise_learning_progress: f32`
- `noise_profile: NoiseProfile`
- `speech_presence_state: bool`
- `speech_focus_amount: f32`

`NoiseProfile` の初期案:

- `sample_rate_hz: u32`
- `capture_ms: u32`
- `bands: [f32; N]`
- `noise_floor_rms: f32`
- `recommended_mix: f32`
- `recommended_gate_db: f32`

### IPC

対象:

- `src-tauri/src/ipc.rs`

追加候補 command:

- `StartNoiseLearning { duration_ms: u32 }`
- `CancelNoiseLearning`
- `ApplyNoiseControlPreset { mode: String }`
- `SetNoiseControlConfig { ... }`

追加候補 response/runtime stats:

- `noise_learning_state`
- `noise_learning_progress`
- `noise_control_mode`
- `noise_profile_available`
- `speech_detected`
- `recommended_noise_mix`

### Frontend API

対象:

- `src/api/audio.ts`

追加候補:

- `startNoiseLearning(durationMs?: number)`
- `cancelNoiseLearning()`
- `setNoiseControlConfig(config)`

`EngineRuntimeStats` 追加候補:

- `noiseLearningState`
- `noiseLearningProgress`
- `noiseProfileAvailable`
- `noiseControlMode`
- `speechDetected`
- `recommendedNoiseMix`

## UI の具体化

### MasterBar

対象:

- `src/components/layout/MasterBar.tsx`

現状:

- クリックで `OFF -> 弱 -> 強` を循環

拡張案:

- 初期段階では循環先を
  - `OFF`
  - `弱`
  - `強`
  - `学習`
  - `会場`
  に増やさず、MasterBar は簡易状態だけに留める
- 実運用向け設定はモーダルへ寄せる

表示追加:

- `学習中 67%`
- `学習済み`
- `会場モード`
- `話者検出中`

### AudioSettingsModal

対象:

- `src/components/features/AudioSettings/AudioSettingsModal.tsx`

追加セクション案:

- `AI ノイズ制御`
  - 有効/無効
  - モード
    - 標準
    - 学習
    - 会場
  - 学習開始ボタン
  - 学習状態
  - 強度スライダー
  - 声優先スイッチ

注意文:

- 学習中は喋らないことを推奨
- 会場モードは近接マイク前提
- BGM や周囲会話を完全に消すものではない

## 実装フェーズ

### Phase 1: Smart Noise Learn MVP

差分:

- IPC に学習開始/進捗/学習済み状態を追加
- エンジンに `NoiseProfile` と収集処理を追加
- 学習後に前段 suppression の係数を適用
- UI に学習ボタンと進捗を追加

完了条件:

- 3 秒学習できる
- 学習前後で持続ノイズが有意に減る
- レイテンシ増加が小さい
- 既存 `low/high` 互換が壊れない

### Phase 2: Venue Mode MVP

差分:

- エンジンに簡易 VAD ベースの補正を追加
- 話者不在時の抑制を強める
- 話者存在時は release を長めにする
- UI に `会場モード` を追加

完了条件:

- ゲームセンター想定の雑音で声の明瞭度が上がる
- 語頭欠けとロボ声の悪化が許容範囲

### Phase 3: 話者優先の強化

差分候補:

- 話者登録
- ターゲット話者の特徴量
- 話者一致時のみ前面に出す

備考:

- ここは研究開発枠
- MVP スコープから外す

## テスト方針

### 既存ユニットテスト更新

対象:

- `src/api/__tests__/audio.test.ts`

追加内容:

- 新 command の invoke パラメータ検証
- 新 runtime stats フィールドの取り回し検証

### 手動検証

最低限やるべき組み合わせ:

- WASAPI 48k / 512
- WASAPI 44.1k / 512
- ASIO 48k / 256
- ノイズ学習あり / なし
- VST なし / 軽量 VST あり
- OBS 経由

検証観点:

- CPU 使用率
- グリッチ回数
- 語頭欠け
- 無音時のノイズ床
- 会場音の減衰量

## 先に手を付けるべきファイル

優先順:

1. `src-tauri/src/ipc.rs`
2. `src-tauri/src/audio_engine/core.rs`
3. `src-tauri/src/audio.rs`
4. `src-tauri/src/lib.rs`
5. `src/api/audio.ts`
6. `src/components/features/AudioSettings/AudioSettingsModal.tsx`
7. `src/components/layout/MasterBar.tsx`
8. `src/api/__tests__/audio.test.ts`

## 判断

この機能は VST 化前提で設計するより、まずホスト機能として実装する方が良い。

理由:

- 既存コードに差し込みやすい
- OBS 連携、プリセット、トラブルシュート導線と一体で価値を出せる
- UI で学習や状態説明を持てる
- VST 単体競争に早期に落ちずに済む

ただし DSP 本体は将来の VST 化を見据えて、`core.rs` へ直書きしすぎず、後から切り出せる構造で組むこと。
