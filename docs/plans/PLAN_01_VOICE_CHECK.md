# プラン1: Voice Check / Before-After 確認

## 目的

配信前に数秒間の声を録音し、加工前（Raw）と加工後（Processed）を聴き比べられるようにする。
「自分の声が今どう聴こえているのか」への不安を、配信開始前に解消する。

## ユーザーストーリー

- 配信者として、配信開始前に「ボイスチェック」ボタンを押して 5〜10 秒話すと、
  加工前後の音を交互に再生して比較でき、ノイズ抑制やエフェクトの効き具合を確認できる。
- 比較の結果、強すぎる/弱すぎると感じたら、その場で設定を変えて再チェックできる。

## 現状の確認結果

- ファイル録音機能は未実装（メータリングのみ存在）。
- エンジン (`src-tauri/src/audio_engine/core.rs`) の出力コールバック内には
  「ノイズ抑制前」と「VST チェーン後」の両方のバッファへアクセスできる箇所が既にある
  （Pre/Post メーターが同一箇所で計測している）。
- 既存 IPC (`src-tauri/src/ipc.rs`) は Command/Response/EngineEvent の JSON プロトコル。
- 再生はエンジンが出力デバイスを占有しているため、**録音物の再生もエンジン経由**で行うのが安全。

## 設計方針

### 録音（キャプチャ）

- エンジン内にタップ録音バッファを追加する。RT スレッドでは lock-free に
  リングバッファへ書き込み、別スレッドがドレインしてメモリへ蓄積する。
- **Raw（入力ゲイン・チャンネル選択直後）と Processed（マスターゲイン直前）の 2 系統を同時録音**。
  同一コールバック内でタップするためサンプル位置が揃い、A/B 切替時に位相ずれしない。
- 上限 30 秒・48kHz・f32 ステレオ想定で約 23MB ×2。メモリ保持で十分（ディスク書き込み不要）。
  完了時にのみ WAV 保存（プラン2 の分析入力、およびユーザーのエクスポート用途）。

### 再生

- エンジンに「プレイバックモード」を追加: 再生中はマイク入力の代わりに録音バッファを
  出力へ流す（マイクはミュート）。Raw/Processed をワンタップで切替。
- ループ再生 + 再生位置イベント（UI のシークバー用）。
- 出力先は現在の出力デバイスそのまま。仮想ケーブル運用中のユーザーには
  「モニターデバイス（物理ヘッドホン）を選んで再生」するオプションを付ける
  （cpal で一時的な第 2 出力ストリームを開く。失敗時は現在の出力にフォールバック）。

### IPC 追加（`ipc.rs`）

```
Command::StartVoiceCheckRecording { max_ms: u32 }
Command::StopVoiceCheckRecording
Command::PlayVoiceCheck { source: "raw" | "processed", loop_playback: bool, monitor_device: Option<String> }
Command::StopVoiceCheckPlayback
Command::ExportVoiceCheck { path: String, source: String }   // WAV 保存
EngineEvent::VoiceCheckState { state, position_ms, duration_ms }
```

### Tauri / フロント API

- `src-tauri/src/audio.rs` + `lib.rs`: 上記コマンドの橋渡し。
- `src/api/audio.ts`: `startVoiceCheck()`, `stopVoiceCheck()`, `playVoiceCheck(source, opts)`,
  `exportVoiceCheck(path, source)` を追加。

### UI

- 新規モーダル `src/components/features/VoiceCheck/VoiceCheckModal.tsx`
  （`ModalLayer.tsx` に lazy 登録）。
  - 録音ボタン（カウントダウン → 録音中インジケータ → 自動/手動停止）
  - 「加工前」「加工後」の大きな切替トグル + 再生/停止 + シークバー
  - 再生中でも切替即時反映（同一再生位置を維持して切替）
  - 波形の簡易表示（Raw/Processed のピークエンベロープを重ね描き）
  - 「WAV で保存」ボタン
- 導線: MasterBar にマイクチェックアイコン、Setup Wizard の最終ステップにも
  「ボイスチェックする」ボタンを追加。

## 実装フェーズ

| フェーズ | 内容 | 完了条件 |
|---------|------|---------|
| 1-a | エンジン: 2 系統タップ録音 + IPC | 録音開始/停止で Raw/Processed が揃った PCM を保持できる |
| 1-b | エンジン: プレイバックモード | 再生中マイクがミュートされ、Raw/Processed が切替再生できる |
| 1-c | フロント: API + モーダル UI | 録音→比較試聴→設定変更→再チェックの一連動作 |
| 1-d | モニターデバイス再生 + WAV エクスポート | 仮想ケーブル運用時でもヘッドホンで確認できる |

> **実装状況（2026-07 時点）**: 1-a〜1-c と WAV エクスポートは実装済み。
> モニターデバイス再生（cpal 第2出力ストリーム）は**未実装（deferred）**。
> 代替として、出力先が仮想ケーブルの場合は再生前に UI で警告を表示し、
> 物理出力への一時切替を促す運用とする。第2出力ストリームは今後の対応。

## テスト

- `src/api/__tests__/audio.test.ts`: 新コマンドの invoke パラメータ検証。
- Rust 統合テスト (`src-tauri/tests/integration_test.rs`): 録音開始→停止→状態イベントの往復。
- 手動: WASAPI/ASIO 両方、録音中のグリッチ発生数、切替時のクリックノイズ確認。

## リスク・注意点

- RT スレッドでのアロケーション禁止 → 録音バッファは開始時に事前確保。
- 再生切替時のポップノイズ → 短いクロスフェード（5ms 程度）を入れる。
- ASIO はデバイス占有のためモニター別出力が開けない場合がある → フォールバック必須。

## 触るファイル（優先順）

1. `src-tauri/src/ipc.rs`
2. `src-tauri/src/audio_engine/core.rs`
3. `src-tauri/src/audio.rs` / `lib.rs`
4. `src/api/audio.ts`
5. `src/components/features/VoiceCheck/`（新規）
6. `src/components/layout/MasterBar.tsx` / `ModalLayer.tsx`
