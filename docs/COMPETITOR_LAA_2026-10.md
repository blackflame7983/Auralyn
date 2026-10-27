# 競合比較: Live Audio Assist（2026-10）

Stream Gear MixerとPR #105後のAuralynを含む現在の評価・改善順序は、[競合比較と改善順序](COMPETITOR_STRATEGY_2026-10.md)を参照する。画面の作りと音楽鑑賞の位置づけは[競合比較の補遺](COMPETITOR_SGM_2026-10.md)を参照する。本書はLAAの公開資料を調べた記録であり、単独の機能差を現在の競争優位として扱わない。

2026-10-27 時点の調査記録。Live Audio Assist（以下 LAA）は実機で動作確認しておらず、記述は公開資料からの読み取りである。Auralyn 側は当日の main（README、`docs/`、`src-tauri/src/audio_engine` の構成）を基準にした。この文書は製品方針の検討材料であり、実装・検証済みの証拠として扱わない。

## 調査対象

- LAA 販売ページ: <https://sayaka-aiart.booth.pm/items/8422440>（最新 v1.0.5、2026-10-26 更新。フル版 ¥4,000、Player 単体版 ¥2,000）
- LAA v1.0.0 マニュアル（ユーザーマニュアル、LAA Player マニュアル。販売ページの無料プレビュー ZIP）
- 次期構想（利用者からの伝聞、未確認）: ASIO 入出力、VST ホスト機能（LAA 単体で VST3 を利用）、空間系向けセンドバスを実装中
- LAA の説明図「直接モニターなら、配信側の遅延はどう違う?」（利用者提供、2026-10-27 追記）: 「TotalMix＋DAW（RME）」と「LAA＋AG03」を比べ、自分の声は機器の直接モニターで返し、配信側の声と伴奏は速い側を待たせて揃えると説明している。図の注記どおり、数値は例であり AG03 実機の測定値ではない

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

### Auralynの特徴（性能・品質の優位性は未検証）

- **VST3 ホスト**: ラック、独自 GUI、状態保存・復元、プリセット。※LAA の次期構想で追随される見込み。
- **ASIO**: ※同上。
- **OBS 以外での利用**: Discord、ゲーム内 VC、通話アプリなど、OBS を起動しない用途にも届く。
- **プロセス分離**: エンジンとスキャナーをUIから分離する。VSTごとの隔離ではなく、Engine停止時は送信も停止する。LAAの将来のVSTホストの障害隔離方式や、同条件での安定性は未確認。
- **歌唱時モニター**: 自分用の出力は内蔵処理だけを通し、配信用 DSP（NR／VST）は別 worker に分ける二系統構成を実装済み（[SINGING_MONITOR.md](SINGING_MONITOR.md)。実機・聴感・長時間運転は未確認）。意味があるのは、加工した声（残響など）を自分の耳に返したい場合に限る。LAA の説明図は、自分の声を機器の直接モニター（AG03 など）で返す構成を前提にしている。この構成では配信側の VST の遅延が自分の返しに影響しないため、低遅延の返しだけでは Auralyn の優位にならない。
  - **配信側の声と伴奏の時間合わせ**: 説明図では、LAA は測定・同期オフセット・ずれの確認で、速い側（伴奏）を待たせて声に揃える。Timing Check（BGM とマイクのずれ測定）はこの手段で、自分の返しの遅延を補正するものではない（2026-10-27 訂正。初版は「LAA は OBS モニター経由の遅延を前提にしており、Timing Check はその補正手段」と記載していた）。Auralyn にも、OBS 録画を聴いて同期オフセットを手動で調整し、取り消せる機能がある。ただし伴奏を扱わないため、伴奏を自分の Player で再生する LAA と同じ自動測定は構造上できない。
- **無料・OSS**: 試用の障壁が低い。

## LAA 次期構想後の見立て

VST3／ASIOだけを差別化の根拠にしない。ASIOの同時利用はdriver・機器・アプリの構成、安定性は隔離・回収、CPU負荷は処理配置と映像負荷を固定して比較する。LAAの将来版がOBSと同じプロセスでVSTを動かすと決め付けず、外部通話へ送れる範囲も未確認とする。

Auralynの方針は、自宅・ゲーセンの配信／通話を、環境が変わっても準備・比較・復旧できる体験に置く。無停止・低遅延・任意経路への到達は、実測なしに保証しない。

## 方針の提案

1. **機能数で正面から競わない**: BGM、Overlay、セットリスト、ASMR は相手の得意領域で、後追いになる。
2. **共存を評価する**: 「マイクはAuralyn、OBS内のBGM管理はLAA等」を候補とし、二重NR・音量処理・取り込みとOBS接続を実機検証してから案内する。現段階で推奨構成にはしない。
3. **初回調査時の検討項目**（現在の優先順位は[競合比較と改善順序](COMPETITOR_STRATEGY_2026-10.md)を参照）
   - 歌唱時モニターの遅延を実測・公開する。現状は総遅延を測定していない（[LATENCY_MEASUREMENTS.md](LATENCY_MEASUREMENTS.md)）。
   - ノイズ低減の強化。#100後の現行NRを基準に#93で再比較し、DeepFilterNet3標準を追加候補として評価する。既定置換や別プロセス方式を先に確定しない。
   - VST のさらなる隔離（[ROADMAP_PENDING.md](ROADMAP_PENDING.md) のプラグイン単位の子プロセス化）。
   - OBS 以外の用途（Discord、ゲーム VC、通話）を前面に出す。
4. **設計として参考にする点**
   - リアルタイム Auto Leveler の Assist／Safe の2段階と、上げ方向を止める条件。
   - Audio Doctor の段階測定 → A/B 確認 → 条件付き適用の流れ。ボイスチェックと自動ゲイン導線の見直しに使える。
   - Stream Deck の状態同期（Auralyn は未対応と明記）。

## 注意事項

- LAA は GPL v2。「or later」の有無を確認するまで、コードを GPL-3.0-only の Auralyn へ移植しない。参考にするのは設計・操作の考え方に限る。
- 本文書の LAA 機能・挙動はマニュアルと販売ページの記述であり、実機での確認、音質・遅延・安定性の比較は行っていない。
