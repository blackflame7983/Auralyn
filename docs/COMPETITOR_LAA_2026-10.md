# 競合比較: Live Audio Assist（2026-10）

2026-10-27 時点の調査記録。Live Audio Assist（以下 LAA）は実機で動作確認しておらず、記述は公開資料からの読み取りである。Auralyn 側は当日の main（README、`docs/`、`src-tauri/src/audio_engine` の構成）を基準にした。この文書は製品方針の検討材料であり、実装・検証済みの証拠として扱わない。

## 調査対象

- LAA 販売ページ: <https://sayaka-aiart.booth.pm/items/8422440>（最新 v1.0.5、2026-10-26 更新。フル版 ¥4,000、Player 単体版 ¥2,000）
- LAA v1.0.0 マニュアル（ユーザーマニュアル、LAA Player マニュアル。販売ページの無料プレビュー ZIP）
- 次期構想（利用者からの伝聞、未確認）: ASIO 入出力、VST ホスト機能（LAA 単体で VST3 を利用）、空間系向けセンドバスを実装中

## 製品の性格

| 観点 | LAA | Auralyn |
| :--- | :--- | :--- |
| 形態 | OBS プラグイン（音声フィルター＋カスタムブラウザドック、`127.0.0.1:18080`） | 単体アプリ（Tauri UI＋別プロセスのエンジン／スキャナー） |
| 対象範囲 | OBS 内の音全体（Voice、BGM、歌枠、ASMR、Overlay） | マイクの音作り。送り先は OBS／Discord など任意 |
| 経路 | OBS 内で完結。仮想ケーブル不要 | マイク → Auralyn → 仮想ケーブル → 各アプリ |
| 対応環境 | Windows 10/11 64bit、Windows 版 OBS 30 以降 | Windows 11 x64 |
| 価格・ライセンス | 有料、GPL v2（配布 ZIP にソース同梱） | 無料、GPL-3.0-only |
| 開発の速さ | v0.2.0（2026-05-30）から v1.0.0（2026-08-09）まで約2.5か月 | 安定性・契約・検証を重視 |

## 機能比較

### LAA が上回る領域

- **BGM 運用**: LAA Player（ローカル／YouTube／Web 再生、YouTube プレイリスト追加）、BGM リスト／歌枠リスト、Slot 1〜3 のセットリスト、タグ・履歴、曲ごとのラウドネス補正（ローカル約 −10 LUFS、YouTube/Web 約 −14 LUFS 目安）、シーン別 BGM と自動切替、LAA Live Pad、Overlay（Now/Next/履歴、テーマ、アニメ）。Auralyn にはこの領域がない。
- **Voice と BGM の関係処理**: Ducking、BGM Masking、BGM 側 Auto Leveler、Master Mix Check。Auralyn は BGM を扱わないため構造上持てない。
- **リアルタイム Auto Leveler**: Off／Assist／Safe。Voice・BGM 個別。Auralyn の自動ゲインは提案→適用→復元で、発話へ常時追従する機能ではない（[AUTO_GAIN.md](AUTO_GAIN.md)）。
- **ノイズ低減**: DeepFilterNet 系の AI Clean と Silero VAD による検出表示。Auralyn は nnnoiseless（RNNoise 系）。強度・音質の比較は未実施。
- **内蔵 DSP の種類**: Limiter／Compressor／De-esser／EQ／Reverb を Current・Signalsmith・DSPFilters・Faust で切替。Airwindows 系 6 種。Voice プリセット 6 種（Natural／Bright／Warm／Live／Ballad／Radio）。
- **診断**: 自動チェック、DSP Tune Lab（Noise → Voice/BGM DSP → Level → Master Mix）、Audio Doctor v1（無音・通常・大声・BGM の4段階測定、読み取り専用の提案、OBS 構成 preflight、一時 A/B 録音、条件付き適用と読み戻し、Watchdog）。設計思想（勝手に変えない、適用後に読み戻す）は Auralyn と近い。
- **歌枠・ASMR**: Timing Check（BGM とマイクのずれ測定、Player の OBS 同期オフセットへ反映）、ASMR Dock（単一マイクの L/C/R 配置、Ear Motion、Opposite Ear Blend、Depth Delay）。
- **配信中操作**: 専用 Stream Deck プラグイン（BGM 操作、Ducking／Reverb トグル、Stream Deck+ のダイヤル、ASMR 操作）。Show Control（Scene Collection／Profile の preflight 付き適用）、セッションレポート。

### Auralyn が上回る領域（現時点）

- **VST3 ホスト**: ラック、独自 GUI、状態保存・復元、プリセット。※LAA の次期構想で追随される見込み。
- **ASIO**: ※同上。
- **OBS 以外での利用**: Discord、ゲーム内 VC、通話アプリなど、OBS を起動しない用途にも届く。
- **プロセス分離**: エンジンとスキャナーを UI から分離。OBS 内で VST3 を読み込む構成では、プラグインの異常がそのまま配信中の OBS の異常になる。LAA v1.0.5 の修正内容「特定の条件下でプラグイン読込時にクラッシュする不具合」は、OBS 内ロードの難しさを示す一例。
- **歌唱時モニター**: 自分用の出力は内蔵処理だけを通し、配信用 DSP（NR／VST）は別 worker に分ける二系統構成を実装済み（[SINGING_MONITOR.md](SINGING_MONITOR.md)。実機・聴感・長時間運転は未確認）。LAA は OBS モニター経由の遅延を前提にしており、Timing Check はその補正手段。
- **無料・OSS**: 試用の障壁が低い。

## LAA 次期構想後の見立て

「VST3／ASIO 対応」だけでは差別化できなくなる。一方、OBS 内に ASIO と VST3 を入れる構成には構造的な制約が残る（いずれも推測で、LAA の実装は未確認）。

- **ASIO の排他**: 多くの ASIO ドライバーは1プロセスからしか開けず、OBS が掴むと DAW 等と併用しにくい。
- **VST の安定性**: プラグインのクラッシュ、GUI スレッド、DPI が OBS 本体の安定性に直結する。
- **CPU 競合**: OBS の音声スレッドに重い DSP／VST が載り、映像エンコードと競合する。
- **OBS 専用**: Discord や通話の音は改善されない。

LAA は「OBS の中でそれなりに全部できる」方向、Auralyn は「OBS の外で、落ちずに、低遅延で、どこにでも届く」方向に分かれていく。

## 方針の提案

1. **機能数で正面から競わない**: BGM、Overlay、セットリスト、ASMR は相手の得意領域で、後追いになる。
2. **共存を前提に打ち出す**: 「マイクは Auralyn、OBS 内の BGM 管理は LAA 等」という構成を正式に案内する。OBS 連携・接続確認が LAA 同居環境で壊れないかを検証して文書化する。
3. **差別化軸へ投資する**（優先度順）
   - 歌唱時モニターの遅延を実測・公開する。現状は総遅延を測定していない（[LATENCY_MEASUREMENTS.md](LATENCY_MEASUREMENTS.md)）。
   - ノイズ低減の強化。DeepFilterNet 級を別プロセスで扱えるか検討する（[PROPOSALS_AI_NOISE_HOST.md](PROPOSALS_AI_NOISE_HOST.md) の延長）。
   - VST のさらなる隔離（[ROADMAP_PENDING.md](ROADMAP_PENDING.md) のプラグイン単位の子プロセス化）。
   - OBS 以外の用途（Discord、ゲーム VC、通話）を前面に出す。
4. **設計として参考にする点**
   - リアルタイム Auto Leveler の Assist／Safe の2段階と、上げ方向を止める条件。
   - Audio Doctor の段階測定 → A/B 確認 → 条件付き適用の流れ。ボイスチェックと自動ゲイン導線の見直しに使える。
   - Stream Deck の状態同期（Auralyn は未対応と明記）。

## 注意事項

- LAA は GPL v2。「or later」の有無を確認するまで、コードを GPL-3.0-only の Auralyn へ移植しない。参考にするのは設計・操作の考え方に限る。
- 本文書の LAA 機能・挙動はマニュアルと販売ページの記述であり、実機での確認、音質・遅延・安定性の比較は行っていない。
