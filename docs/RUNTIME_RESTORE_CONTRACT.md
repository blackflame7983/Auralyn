# 未保存状態と確認済み復帰の契約（#221・#222）

これは現行実装の棚卸しと今後の契約であり、全構成のruntime snapshot／復帰は未実装。`BundleV1` は選択カテゴリの保存であって全状態のsnapshotではない。特に確認済み保存・復帰は `AudioHost::checked_snapshot_supported` の本番保護preflight、`live_modes.target == None`、`live_output::Config::default()` のすべてが条件。分離出力だけでなく非既定trim・mute・自分用設定も拒否する。未取得は成功にしない。この制限は全範囲の実装・検証まで外さない。

## 現在の所有と保存範囲

以下の「保存」は各機能での保存を意味し、全項目を同時・原子的に取得／復帰できることを意味しない。Engine停止中の保存値は最後の設定であり実際の稼働状態ではない。

| 項目 | 所有者・保存先と寿命 | 現在の取得／復帰と限界・根拠 |
| --- | --- | --- |
| 選択名、実機ID、rate、buffer、ch・routing、gain | Frontendの `vst_host_audio_config`、`vst_host_input_gain`、`vst_host_output_gain` はWebView永続。Host `ActiveAudioConfig` は `last_audio_config.json` に永続し名前・ID・rate・buffer・routingを持つ。Engineが実ch・gainを持つ | `src/lib/audioPreferences.ts`、`src/hooks/useAudioConfig.ts`、`src-tauri/src/audio.rs`。`EngineCapture` はch／routing／gain、`ProfileAudioConfig` は機器名を含むがIDを持たない。`RecoveryDevices` は別の復旧情報で全snapshotのIDではない。同名機器・実受理値・後編集の包括照合は未実装。 |
| NR設定・学習 | Engine寿命のNR状態、選択保存時は `broadcast-bundles/<name>.json` の `embeddedAuralynPreset.noiseControl` | `core/bundle_capture.rs` の `EngineCapture.noise` はenabled／mode／strength／voiceGuardを取得するが `learned_profile: None`。`bundle.rs::validate` は学習profileを拒否する。学習状態の復帰は未対応。 |
| 内蔵FX | Engine寿命の `builtin.config`、選択時は同bundleの `embeddedAuralynPreset.builtinFx` | `ProfileBuiltinFx` は種類・有効・量・歌／残響値を保持。稼働中の反映待ちは `capture_bundle_state` が拒否する。未保存状態を全構成で復元する仕組みはない。 |
| VST順序・state・enabled／mute／gain | Engineのplugin manager／VST component、Frontendの `vst_host_session_plugins` と `vst_host_session_restore_protected`、選択時はbundle内の `embeddedAuralynPreset.plugins` | `core/bundle_capture.rs` は順序に沿って `get_state`、失敗時は取得失敗。component内部の自発的変化や別controller stateは保証外。`session_rack.rs` は世代・revision・leaseを持つが全runtime復帰ではない。VST外部状態や欠落への無条件復元は保証しない。 |
| 二系統・枝trim／mute | Host `live_output.json` は永続、Engineの `live_output::Config` とsink状態はEngine寿命 | `audio.rs::live_output`、`audio_engine/live_output.rs`。停止中は保存設定を読むが稼働・到達を意味しない。`BundleV1` に構成・trimを保存しない。 |
| split_monitor／自分用処理 | Engineの `split_monitor::State`（modeとbuiltin config、revision／completed／pending／failed）、Hostの `live_output.json` の `monitorSinging`／`monitorTalk` は永続 | `audio_engine/split_monitor.rs`、`core.rs::mode_monitor_command`。現在状態は定義と異なり得る。分離構成の全状態をbundleで取得・復帰できない。 |
| 歌／雑談definitions・target、本番保護 | Host `live_modes.json` はdefinitionsを永続。`HostModes.target`、armed・bound・epochはHost寿命／Engine世代 | `audio/live_modes.rs::HostModes` と `sync_live_modes`。targetはbundle対象外。保護はアプリ再起動・Engine交代で解除される。保護中の構成変更はpreflightが拒否。 |
| peak保護 | Host `AudioHost.peak_intent` とEngine `peak_protection`、Host寿命 | `audio.rs::peak_protection` は設定成功時intent保持、再起動時はNone。bundle非対象でアプリ再起動時OFF。永続化・復帰方針の変更は別設計。 |
| global mute／VST bypass | Hostの `is_global_muted` とEngineのmute、Engineのglobal bypass。寿命中のintent／実値 | `audio.rs::set_global_mute`／`set_global_bypass`、`EngineCapture`。取得値を `BundleV1` の全状態復元と同一視しない。停止・緊急muteを優先し、復帰で無断解除しない。 |
| 録音・試聴・進行中適用 | Engine／Frontendの一時状態 | `core/bundle_capture.rs` は一部のgain試聴・VST準備・処理反映待ちを拒否する。録音や試聴の内容・途中位置、全進行操作をsnapshotして再開する機能ではない。 |
| OBS／OS／VST外部状態 | 外部アプリ・OS・VSTが所有。OBSの選択情報はbundle `obs` に含め得る | `bundle.rs::BundleV1` のOBS情報は外部側の全状態や到達を保証しない。外部の設定・機器・ファイルを一括復旧しない。 |
| 確認記録 | bundle内 `confirmation` は永続、現在の条件witnessはHost寿命・epoch／revision | `bundle.rs::Confirmation`、`audio/conditions.rs`。記録は過去の確認であり復帰後の現在の到達・合格ではない。影響した確認は失効し再確認する。 |

## 一時利用と既存の安全境界

`temporary_session.rs::initialize` はconfig／data／WebView2／cache／logを新規一時領域に分離し、通常領域へ自動コピー戻ししない。既存一時領域をクラッシュ後に再開しない。旧PIDの終了待機失敗は起動を止め、削除失敗は `cleanup_pending`、markerはreview-onlyとする。明示開始後のVST session復旧は別途 `session_rack` の世代・lease・保存値照合を通る。これらを未完了録音・試聴・適用の自動再開と混同しない。異常終了や実機での原本保護の受入は未完了。

`capture_bundle_state` は `execute_running_command` で既存Engineに問い合わせ、停止中に暗黙起動しない。世代が取得中に変われば失敗する。`live_output(None)` はEngine非稼働時に保存ファイルを返せるが、その値は実経路の観測ではない。VST stateの取得失敗、準備・反映中、破損データは成功に読み替えない。

## 全対応構成に必要な設計・実装

1. schemaを明示し、各項目の存在／未知／対象外と保存値・実値・世代・revisionを区別する。旧schemaの変換、デバイスID・host・ch能力・実rate／bufferと同名機器の照合、VST識別・欠落と取得不能を定義する。名前だけで別機器へ代替しない。
2. 取得開始前に録音・試聴・進行中適用・OBS／OS／VST外部状態の対象外を示す。Engineを起動せず既存状態を取得し、全項目の完了ACKと世代・revision・後編集を取得前後で照合する。component内部変化の観測限界は表示する。
3. 復帰前に差分、停止／VST再ロード、欠落項目、両枝への影響を表示し、確認を対象とrevisionに結び付ける。保存先の原本を保護し、原子的な書込み・読み戻し・バックアップと中断時の回復を設計する。保存失敗・競合・途中失敗では原本を保ち、部分状態と再確認を示す。
4. 機器・schema・世代・設定revision・外部／後編集を直前と各ACKで照合し、遅いACK、二重実行、A→B→A、停止中の復旧を拒否する。両枝の遮断、適用、完了ACK、読み戻し、条件付きUndoを一体のトランザクションとして設計する。Stop・緊急muteを優先し、無断再開・mute解除・未加工音への代替をしない。
5. 復帰後は影響した確認だけを失効し、過去の `confirmation` を現在の成功として扱わない。旧schema、同名機器、VST欠落、取得中変更、両枝の部分失敗、Stop／mute競合を機器なしで試験し、さらにV-03／V-04の実出力・表示を別々に実機確認する。

## 受入条件の引継ぎ

以下は [COMPETITOR_STRATEGY_2026-10.md](COMPETITOR_STRATEGY_2026-10.md) のI-97a・I-98aの各5条件をそのまま転載した未完了条件。

### I-97a

- [ ] 音声選択・実機ID／ch／gain、NR／FX／VST state・順序、二系統構成・trim、自分用処理、歌／雑談・本番保護・ピーク保護について、保存値と稼働状態、永続とHost寿命を区別した対応表がある。
- [ ] 録音・試聴・進行中適用・OBS／OS／VST外部状態など対象外を開始前に示す。対応していない値を落として「元どおり」と表示しない。
- [ ] 復帰は機器・schema・Engine世代・設定revision・外部／後編集を照合する。取得不能・機器欠落・保存失敗・競合では原本を保持し、別機器や未加工経路へ自動代替しない。
- [ ] 通常終了・異常終了・再起動・旧PID待機失敗・一時領域削除失敗で、未完了の音声／試聴／適用を自動再開しない。通常設定への明示開始後のVST復元、空セッションの保存解除、二重通知・取消の回帰を保持する。
- [ ] 旧schema、同名機器、VST欠落、取得中の変更、途中失敗、Stop／muteとの競合を自動検証し、#98へ共通の範囲・差分・競合契約を提供する。

### I-98a

- [ ] I-97aの契約を使い、分離出力・枝別処理・trim・歌／雑談・本番保護の対応範囲を保存と復帰で一致させる。ピーク保護のHost内保持／再起動時OFFを変更するなら、互換性と利用者の明示選択を別途定義する。
- [ ] 適用前の差分、音声停止／VST再ロードの有無、欠落機器・プラグインを示す。古い確認履歴を復帰後の現在の合格として再利用しない。
- [ ] 緊急ミュート・明示Stopを優先し、本番保護中の構成変更を拒否する。保存しただけでは適用せず、復帰時のミュートを勝手に解除しない。
- [ ] 原本保護・読み戻し・部分失敗・条件付きUndoを両枝へ適用する。遅いACK、二重実行、保存失敗、停止中復旧で古い音や未加工音を漏らさないことを自動検証する。
- [ ] 復帰後は#94の影響した確認だけを失効させる。V-04で実際の出力と表示を別々に確認するまで実機完了としない。
