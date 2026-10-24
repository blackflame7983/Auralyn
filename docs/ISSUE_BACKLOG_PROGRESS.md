# Issue 対応の進捗（2026-10-23着手、10-24継続）

対象は着手時に open だった40件と、途中で追加された #69 の計41件。基準はローカル `1efb62a42a43f66df3ff59600fc25f57fbfb672b`。
以下は作業ブランチ `codex/issue-backlog` の記録であり、公開版の動作保証ではない。
基準には `origin/main` に未反映の既存9コミットがあり、今回の変更と区別する。

この文書はPR作成前までの実装・検証記録。以後の公開状況はGitHubのPRを参照する。

10月24日の追加read-only照合でもopenは同じ41件、新規番号・対象から消えた番号は0。Issueの更新／close、push／PR作成はこの作業で行っていない。

#66は利用者の指定により後日手動確認とする。[実DPI・キーボード・Narratorの確認手順と記録欄](ACCESSIBILITY_MANUAL_CHECK.md)を追加したが、実施結果は全条件で未確認。通常の設定データを消して初回状態を作らず、別Windowsテストアカウントで初回／既存を隔離する。

## ローカルで修正した22件

| Issue | 変更内容 | 検証の境界 |
| --- | --- | --- |
| #40 | 再検出を Begin/Poll/Cancel に分割。待機中のホストmutexを解放し、単一worker・取消・期限・世代・同時要求の結果共有を管理。プロファイル適用も非同期取得を共有 | 制御されたworker・取消・古い応答を非実機テスト。旧GetDevicesは完了済みcache用。実際の長いドライバー応答は別確認 |
| #41 | 必須レート変換の準備失敗を開始失敗にする。処理失敗は無音化・atomic通知・制御側停止 | 実rubato失敗注入、無割当。実音声の故障条件は別確認 |
| #42 | 両streamの開始成功後だけ公開。入力build失敗時は出力を回収してから再試行。callbackのVST所有値を制御側へ返し、終了処理を共通化 | 失敗注入・回収順・破棄スレッド・無割当。全VST／ドライバーの互換性保証ではない |
| #43 | 今回の有効設定から処理容量を決定。明示Fixedの上限超過は開始前拒否、Defaultは報告上限を最大65,536へ制限。実callback超過時は全体無音化と理由付き停止 | 小→大→小、WASAPIの無制限能力上限、超過callbackを制御テスト。3core bufferの要求生存量を6条件で比較・独立監査済み。Engine全体／VST／実機Defaultの性能比較は未実施 |
| #50・#64 | ASIO入力を名前付き標準radioにし、選択失敗と信号監視の準備・待機・受信・失敗を日本語表示。点滅を除去 | APIモック・表示復元・失敗。実画面で名前と状態を確認。OS実キー／読み上げは #66 |
| #51 | 診断エラー要約を本文用の赤色へ変更 | 暗色画面の表示と、全テーマの実コントラスト確認は区別する |
| #52・#56・#57 | 外観はテーマを先頭に整理。移行・更新・ホットキーをシステムへ移動し、かんたん表示でも移動先へ進める。OS追従・性能影響ゼロの誤説明を修正 | 900×600のゲーミングテーマで外観と移動先を確認。全DPIの確認ではない |
| #53 | 機器未選択の「次へ」を無効化。戻った際の選択を表示・aria-pressedで公開 | 両ガイド・分岐変更のUIテスト |
| #54 | プラグインの検索不一致と未登録を分け、検索・カテゴリ解除と全件表示を追加 | 一覧復帰・検索欄へのフォーカスをUIテスト |
| #55 | 試聴先の誤選択を避ける説明と設定導線を整理し、後続の #33 で通常経路を変えない独立試聴へ統合 | 設定への委譲と独立試聴のUIをモック確認。実際の別出力再生は #33 で検証中 |
| #58・#59 | 並べ替えの属性・イベント・フォーカスを専用buttonに統合。説明と状態通知を日本語化 | 両表示のSpace開始・Escape取消をUIテスト。実OSの移動・確定・読み上げは別確認 |
| #60〜#62 | プロファイル操作を常時表示。入力・対象名のラベル、検索解除、一覧取得失敗・再試行を追加 | 専用モックで行の識別、長い日本語名、検索復帰と取得失敗を確認 |
| #63 | レート比較をWASAPIの一意な選択出力・既知の対応入力に限定。ASIO／曖昧な対応は手動確認へ。全デバイスへの48000Hz統一警告を除去 | CABLE/A/B、同名、無関係デバイス、取得不能をテスト。音声到達や不調原因の確定ではない |
| #65 | 修飾キー・通常キーの選択式、登録解除、未保存取消、失敗説明を追加 | 既存設定保持・未完組合せ・保存失敗をモック確認。OS登録・Stream Deck実機は別確認 |
| #67・#68 | 保存した非機密host/portを共有し、ウィザードの一時値・既存接続との関係を説明。選択ポートに応じた固定文のエラー案内を出す | パスワードの共有範囲は拡張しない。生エラーの非出力、非標準ポート、接続中入力固定をモック確認。OBS実通信は別確認 |

## 当初40件のうち未完了18件と追加 #69

#33 は独立試聴backendとUIを統合済み。Soundblasterでの短時間再生は成功したが、利用者は聞こえたことを確認できず、聴感・OBS混入・長時間などは未確認。
#37 は最終録画ガイドと手動測定に基づく追加遅延の予定・適用・復元を実装。統合レビューで見つかった接続寿命と音声条件変更後の失効を修正し、再レビューで重大な未解決の指摘はなかった。実OBSへの書込み・最終録画による確認は未実施。

#44 B はVSTのロード・保存状態・初期bypass/mute/gain・遅延接続をまとめる要求へ移行した。成功前にprocessorを公開せず、開始時prepare失敗を開始拒否として返す。停止中の保存状態復元成功は、音声開始時のprepare完了と区別する。起動セッション・プリセット・プロファイル・削除undo・editor再読込を移行し、期限切れ・世代変更・部分失敗時の保存原本保護を維持する。独立レビューは重大な指摘なし。Aの起動試行内snapshotも実装・独立レビュー済みで、固定debug成果物による3経路の短時間比較を完了した。OSキャッシュを消したcold比較・長時間品質は未確認。
#38 は部分復元後の原本上書き防止と再試行UIを実装し、開始直後のミュート・ゲイン保持をテストした。復旧状態・長時間等の残要件があり、全面完了件数には含めない。

#34 は [歌向け内蔵処理の設計](SINGING_BUILTINS.md) に基づき、HPF・連動コンプレッション・高域シェルフ、設定CAS、実送出サンプルのピーク取得、候補生成・保存・core接続・UIを実装・ローカル統合検証した。独立レビューの指摘を修正し、短時間実機と900×600の実画面も確認した。利用者の指定により歌唱聴感は未確認として進め、全面完了件数には含めない。

#35 は声処理と独立した初期OFFの4FDN残響、保存・復元、余韻を含む候補生成とUIを実装した。旧profileの内蔵カテゴリに残響がなければOFF、カテゴリ自体がなければ従来どおり現在値を保持する。UIの独立レビューPASS。backend初回レビューの候補duration不一致P2を修正し、1回の再レビューPASS。歌唱聴感・クリック・長時間品質は未確認で、詳細と実機条件は下記へ記録する。

| Issue | 残る作業 |
| --- | --- |
| #4 | 全体方針。追加LUFS需要OFF／ONは単体の壁時計／構造体サイズを限定比較済み。全Engine／Host／WebView／OBSのCPU・メモリ、Store／配布条件等の残要件と子課題を照合する |
| #28 | 原入力cohortから通常mic出力buffer完了までの観測、継続streamの条件別窓切替、段別の申告／計算／不明を追加し、各sliceの対象検証・独立レビューが限定PASS。旧raw／batchは維持。最新全体検証、固定release Engineの48k通常mic窓切替・NR段別情報、instrumentation単体負荷／保持量を追加確認。実VSTのGUI変更時追従・異率実機・全体負荷／長時間等は残る。DSPの内部信号対応を実測したとは扱わない |
| #30 | 録音の共通活動区間からHPF／コンプレッションの限定評価を行い、本人の5項目の希望を固定したv2候補を追加。旧v1互換・候補世代／録音／設定CAS・適用／Undoを維持。古い取消失敗が新候補へ干渉する競合を修正し独立再レビューPASS。最新全UI909件／Rust416件等が成功。最新固定release Engineの既知信号・2希望候補・旧ID／録音／CAS拒否・RT適用／Undoが成功。実OBS／全カテゴリ実機・本人歌唱聴感・専用Stream Deckは未確認／明示後続 |
| #32 | #33〜38と一連の実機操作・利用者確認を含む親ロードマップ |
| #33 | 独立WASAPI試聴・同位置A/B・寿命・録音条件表示を実装。Soundblaster短時間再生は自動成功したが、利用者は聞こえたことを確認できず。可聴性・OBS混入・切断・連続運転は未確認 |
| #34 | 歌向け内蔵初期設定・下書き・試聴・CAS適用・Undo・保存を実装し短時間実機確認。利用者指定により歌唱聴感は未確認 |
| #35 | 初期OFFの4FDN残響・tail・即時消音・保存互換を実装。合成信号／単体CPU／短時間実機と歌唱聴感・連続運転を区別する |
| #36 | 内蔵モード・保護・UI・短時間実機は実装確認済み。実OBSシーン連動／OS hotkey・Stream Deck／聴感・長時間は未確認 |
| #37 | OBSテスト録画による経路・音量・同期の手動リハーサル支援 |
| #38 | 復旧状態・部分復元に加え、v3で到達確認の時刻／対象／条件・readback・失効・古い操作拒否を実装し独立レビュー／自動検証PASS。別の固定旧Engineで同率仮想endpoint20分を確認。実OBS変化と専用環境48〜72時間は未確認で、短時間試験を代替完了にしない |
| #39 | #40〜48の起動・安定性・低遅延化の親ロードマップ |
| #44 | 起動能力取得の重複削減とVST初期状態の一括復元。cold/warm等の比較 |
| #45 | ASIO入力先行構築を実装し、96k／512の短時間比較で内部queue対応の1ブロック待ち削減を観測。物理遅延・別ASIO条件・release・長時間は未確認 |
| #46 | WASAPI同率優先と検証済み4rate組だけFFT512を実装。単体の離散品質・CPU予算・無割当、最新EngineのASIO同率短時間を確認。実拒否fallback、異率512実機・22ch全帯域・独立clock・聴感・連続運転は未確認 |
| #47 | 段階Aの不足・破棄・滞留観測と完全frame読出しを実装・実機確認。段階Bの有限滞留回復を比較・実装し統合確認。軽量ASRC候補は事前品質基準に不合格で採用保留。実機での回復発火、共通／独立clockでの連続比較は未確認。可変比補正は必要時の比較候補であり必須実装と決めていない |
| #48 | 合成信号546条件・単体CPU39条件の旧候補に加え、実出力rateを使う有界NR factoryへ修正。対応8k〜384k／最大3840frames、Start／両setter guard、旧≤192k数値一致・RT alloc/free0を対象検証し独立限定PASS。実歌唱・聴感・実Start／fallback・高rate実driver・最新全体性能・長時間は残る |
| #49 | UI子課題の実画面・OS検証を含む親一覧。子のコード修正だけで全面完了にしない |
| #66 | 実200%拡大・DPI・実キー・スクリーンリーダー・初回／既存状態の隔離確認。[手動確認手順と記録欄](ACCESSIBILITY_MANUAL_CHECK.md)を用意。利用者の指定で後日の手動確認とし、今は未確認 |
| #69 | 明示ja/en・主要導線・Settings・VoiceCheck・メーター・遅延詳細・プラグイン一覧・Guide／Wizard・プリセット等と通知hooks・typed OBS表示・共通確認／ライセンス枠を翻訳。日英2183keys、補助文整理後の全UI909件・型検査・Viteが成功。最新lib416件等も成功し、各表示sliceは独立レビューを通過。プリセット1890key時の実画面に加え、最新固定Hostで#28停止中詳細と#30希望の日本語／英語切替を確認。Browser／OS tray実表示等は未確認で、英語対応全体は未完了 |

## 検証記録

- #33・#38を含むUI全体：56ファイル・394テスト、TypeScript、Vite build成功。実機音声・OS操作の代替ではない。
- #37同期調整と #33占有案内を追加したUI全体：接続寿命・音声条件失効の修正後に57ファイル・420テスト、TypeScript、Vite build成功。実ModalLayerとuseObsUsageを使う往復・接続・閉じる操作と、適用中の条件変更による失効を含む。
- #37音声条件witness・OBS条件失効通知とVST処理状態通知の互換修正後のRust：全209 libテスト、関連integration・queue・maintenance・共存・OTT editor試験、all-targets check／Clippy成功。OTT module lifetime試験1件は明示指定が必要なためignored。incremental cacheのhard link失敗によるcopy警告はあったが、Clippyの指摘はなかった。
- #44 B追加後：Rustのfactory・lifecycle・Host・profileを対象とする21テスト、all-targets check／Clippy成功。UI対象45テスト、全58ファイル425テスト中414成功、旧migration mockだけの11失敗を新APIへ修正して該当11件が全成功（その他57ファイルは未変更）。最終TypeScript／Vite build成功。
- #44 A追加後：能力snapshotと起動回収の対象14テスト、all-targets check／Clippy、全218 libテスト成功。Aの3ファイルは独立レビューで重大な指摘なし。debug成果物の再生成は空き不足で失敗し、古い増分キャッシュを整理して再開した。
- #34 backend追加後：対象20テスト、all-targets check／strict Clippy成功。旧3preset互換、実sample meter、CAS／undo、停止中の最新値保持、候補取消／原本不変、旧profile欠落値と新値roundtripを含む。DSP／CAS／meter限定レビューは重大な指摘なし。backend統合レビュー・UI・実機は継続中。
- #34 backend統合の初回レビューではP2を2件確認。候補完了通知を非RT workerの確実な配送へ変更し、192kHz超の歌係数も実レートへ統一した。満杯キューで取消済み2件→最新結果の順序を固定するテストと384kHz応答一致テストを含む対象5件、check／strict Clippyが成功。1回の再レビューは重大な未解決指摘なし。
- #34修正後の `cargo test --locked` 全体：227 lib、queue 2、engine lifecycle 1、maintenance 1、MSIX共存2、OTT editor 1が成功。OTT module lifetimeの実機指定試験1件はignored。Host／各bin／doc testは0件で成功。コンパイラーのhardlink→copy警告のみ。実機stream・UI・聴感の代替ではない。
- #33着手前のRust：178 lib＋queue 2＋MSIX 2テスト成功。all-targets check／Clippy、ホスト・エンジン・スキャナーのdebug build成功。
- #33・#38開始時保持修正後のRust：194 lib＋queue 2＋MSIX 2テスト、all-targets check／Clippy、3バイナリのdebug build成功。制限環境で失敗したファイル操作・並列時の期限超過は、権限付き再実行で成功を確認した。
- #38では開始前に保持ミュートを同じEngine接続で確認し、最初のcallbackへ入力／出力ゲインを引き継ぐ。停止中ゲインの旧revisionが再送される問題も独立レビューで修正し、cleanupなしの再開を回帰テストに含めた。
- 独立レビューで、Default容量拡張後に稼働中追加・遅延VSTが4096のまま準備される問題を修正。起動時・追加時・遅延時はEngineが保持する同じ有効容量を使う。
- 実機でASIOのデバイス解決失敗を確認。複数driverを同時保持する探索をASIOだけ逐次解放へ修正し、単一driver制約の非実機テストと実際のASIO開始で確認した。
- 900×600、100%の既存Tauri開発アプリで、ASIO選択のセマンティクスと外観／システムの移動を確認。既存backendを使った画面確認であり、新Rust実装の検証とは分ける。
- 実機停止・切替はユーザー許可済み。元の設定はASIO／96kHz／512frames／Voicemeeter Insert Virtual ASIO／入力インデックス6・7（表示7・8ch）。
- push・PR作成・Issueクローズ・リリースは未実施。

### 固定debug binaryによる短時間の実機確認

ホストSHA256 `8B516A0FF28868ECE15302093A119A731CE9D5CB746557F2CB903D8B29EF531D`、
エンジンSHA256 `95F39921215F404A0A13B6C05C6F44D3C04E21C2B9E85EC46909528C54A8C08C`。
#33 backendの追加前の成果物であり、以降のソース変更を検証したものではない。

| 条件 | 観測 |
| --- | --- |
| ASIO・Voicemeeter Insert・96kHz・512指定 | 開始成功。実callbackは512frames。入力6・7を再適用。短時間の処理時間・通知遅れを取得したが、可聴音切れ・全経路遅延の測定ではない |
| WASAPI・マイク(1)→CABLE Input・44.1kHz・512指定 | 約2.48秒区間、225callbacks、実441〜1036frames、streamFailed=false |
| 同経路・48kHz・512指定 | 約2.46秒区間、219callbacks、実480〜1056frames、streamFailed=false |
| 再検出中の音声停止 | 再検出全体3914msに対し停止応答41ms。停止後running=false、入力20件・出力22件を取得 |

WASAPI試験後はASIO／96kHz／512指定へ復元した。
開発中の画面再読み込みでVST数が変わったため、この区間を固定VST構成の音質・性能比較には使わない。
既知信号・実録音・OBS到達、releaseでの比較、44.1/48kHzのASIO、48〜72時間運転は未実施。

### 保存セッションの保護と回収

再起動時にOzone 12 Equalizerの復元が失敗し、部分復元したInsight 2だけを自動保存して元の2件構成を置換する問題を確認した。
Chromium LevelDBの既存記録から最新の2件保存データを回収し、保存原本へ戻して保護フラグを設定した。
回収原本と上書き後の1件構成は `.git/issue-backlog-recovery/` に別々に保管し、コミットしない。
回収できた保存値と停止前の未保存パラメーターが同一かは未確認。

部分・失敗・除外・中断では原本の自動／定期／明示保存を止め、全件復元成功時だけ保存を再開する修正と、常設の理由・再試行表示を追加している。
独立レビューで見つかった再試行中のresetと手動編集の競合も回帰テストで修正する。
画面再読み込みによる重複ロードを避けるため、固定条件を作り直すまで開発ホストと音声エンジンは終了している。

### 独立試聴の実機確認（継続中）

ユーザー指定のスピーカー（Soundblaster）を対象とし、ユーザープロファイルを読まない検証用エンジンで実施する。
通常出力は最初のcallbackからミュートし、別の検証用エンジンが仮想ケーブルへ1kHz・-42dBFSを送出する。
1秒の録音はメモリ内だけに保持し、音声ファイルを保存しない。

初回はエンジンSHA256 `CFBE7399FB34D55533037F8442E9B721BD818AEFC8460DB01223C3AAC50A94D6`、
WASAPI・48kHz・512指定・VSTなしで録音ピーク0.007946を取得した。
独立出力の開始ではCPALのDeviceNotAvailableエラーとなり、再生成功とは判定しない。試験用子プロセスは終了済み。
診断用の更新バイナリSHA256 `DDFE32427DE9B866FA8C08F921F3E0EA9C6835A0927018F9222308FBA07E9229` では、
Soundblasterの既定96kHzと録音48kHzの両方でstream生成が失敗した。
Windows APIを再生せずに確認し、結果 `0x8889000A`（AUDCLNT_E_DEVICE_IN_USE）を取得した。
VoicemeeterのA1が同じSoundblasterを使用していた。

Voicemeeterの現在設定を非公開XMLへ保存し、直前にも一致を確認してからA1だけを一時解除した。
同じ固定バイナリ・48kHz録音で、以下の独立試聴を確認した。

| 通常側の条件 | 独立WASAPI試聴の観測 |
| --- | --- |
| WASAPI・48kHz・512指定・VSTなし | Soundblasterで再生成功。A/B更新前後の位置213ms。通常callback数142→179、出力ピーク0、ゲイン1を維持。音量合わせ使用可、停止状態stopped |
| ASIO・Voicemeeter Insert・96kHz・512指定・VSTなし | 同じ48kHz録音をSoundblasterで再生成功。録音条件は古い状態と表示。A/B更新前後の位置223ms。通常callback数1→50、出力ピーク0、ゲイン1を維持。停止状態stopped |

両条件で旧通常出力再生APIとの競合を拒否した。試験後のVoicemeeter設定を再保存し、バックアップと全XML設定が一致することを確認した。
追加で、WASAPI・CABLE Output入力→Voicemeeter VAIO3 Input出力・48kHz・512指定・VSTなし・通常ミュート解除の条件でも成功した。
独立試聴前／中の通常出力ピークはいずれも0.007946、ゲイン1、callback数127→159、A/B更新位置213ms、停止状態stoppedを確認した。
当初指定したCABLE-Aは未導入で開始前に拒否され、実一覧にある出力を再選択した。どちらの試験後もVoicemeeterの全XML設定はバックアップと一致した。
試験用エンジンはすべて終了済み。利用者の可聴確認は「確認できなかった」であり、聞こえたことや聴感品質は未確認。
通常構成のままではVoicemeeterの占有により独立WASAPI試聴を開始できない。アプリから外部ルーティングを自動変更する実装は追加していない。

ASIOは通常ミュート条件のみ、WASAPIの未ミュートは既知信号・VSTなしの短時間試験に限る。
OBS到達・混入、歌唱の聴感、実VST構成、デバイス切断、長時間の連続性はこの結果で保証しない。

### 元のVST構成の隔離確認

同じ `DDFE3242…` エンジンで、ユーザープロファイルを読み書きしない直接IPCの試験を実施した。音声録音・保存は行わない。
保存済みOzone 12 EqualizerとInsight 2は、停止中のロードと状態復元では両方成功した。
一方、ミュート状態のASIO・96kHz・512指定、およびWASAPI・48kHz・512指定の稼働中追加では、Ozoneだけが `VST set_processing failed` で失敗した。
停止中に両方をロード・状態復元してからASIOを開始しても、Ozoneのprepare失敗をログで確認した。
この場合も管理上の登録／有効件数は2であり、両VSTの実処理成功の証拠にはならない。
検証用エンジンは終了済み、保存原本の保護は継続する。Ozoneの処理失敗と、prepare失敗後も開始成功・登録件数だけを表示する境界を追加調査する。

SDKの既定AudioEffectが処理状態通知に `kNotImplemented` を返すことを公式ソースで確認し、その値だけを許容した。
通常の拒否と内部エラーは引き続き失敗にする。実factory経路の模擬テストでは、未実装通知の処理準備成功と、拒否／内部エラー時のprocessor非生成・解放を確認した。
独立レビューで重大な指摘はなかった。
修正版エンジンSHA256 `D64551139D0050A494922F73D1DD9E0F386B52EA39338E6DCA3F4D7A09A9D1D4` で、
停止中に両VSTをロード・保存状態復元→ミュート状態のASIO・96kHz・512指定の開始が成功した。
27callbacks、実512frames、prepare警告なし・EngineErrorなしを確認。これは短時間の準備・実行確認であり、聴感・ピーク品質・長時間性能の保証ではない。
参考：[SDK AudioEffectの既定実装](https://raw.githubusercontent.com/steinbergmedia/vst3_public_sdk/master/source/vst/vstaudioeffect.cpp)。

### VST一括復元の短時間比較と実アプリへの復元（#44 B）

比較前は `C685C7F4FC3979613D2D7B79CE825AF22973B23CB70378AC01566DB56EC5F42D`、
一括復元後は `9F981920F23093747178FC8ED6E10BE0CF90F40AE4902319DA392A68A675DB2E` の固定debug engine。
ユーザープロファイルを読み書きしない直接IPC、全体ミュート、VSTなし／保存済みOzone・Insightの2本を対象とし、音声を保存していない。
同一プロセスで停止・削除して再ロードする条件を別にしたが、OSキャッシュを消したcold起動ではない。

| 経路・要求バッファ512 | 停止中の初回2本復元・合計ms（前→後） | 同一プロセス再ロード・合計ms（前→後） | 一括復元の稼働中追加 |
| --- | --- | --- | --- |
| ASIO・96kHz | 208.5→202.8 | 182.9→194.9 | 2本ともprepared=true、成功 |
| WASAPI・48kHz | 268.4→211.3 | 228.9→176.2 | 2本ともprepared=true、成功 |
| WASAPI・44.1kHz | 214.7→199.6 | 184.2→182.3 | 2本ともprepared=true、成功 |

各VSTの制御要求は5回から1回へ減少。停止中はprepared=falseを正常な開始待ちとして返し、続く開始・実callbackを確認した。
ASIOの実callbackは512frames、WASAPIは48kHzで480〜1056、44.1kHzで441〜1036frames。
prepare警告・EngineErrorはいずれもなかった。短い単発比較でばらつきがあり、起動時間や可聴の音切れの改善を保証しない。
当該binaryのloggerは環境のRUST_LOGを読まないため、追加debug phaseの内訳はこの段階では取得していない。後続Aで既定Infoを維持した明示debug設定を追加する。

同じengineとホスト `A3E2EEACD2D945C43E53048EBC2CCC67119263AB4E3D5E3C98F1E6A2F3B46F50` で実アプリを再開し、
ASIO・96kHz・512、入力インデックス6・7、入力／出力ゲイン100%、全体ミュートOFF、NR／内蔵処理OFF、2本有効を確認した。
保存済み2件のstate保持と復元保護解除、保留ロードなし、900×600／DPR1の実ラック表示を確認した。
メーターが無音の区間は故障と判定しない。callbackのjitter/glitchCountは可聴の音切れ件数ではなく、聴感・元の未保存値との一致・OBS到達・長時間品質は未確認。
開発サーバー停止による初回空画面はVite再開と検証ホスト再起動で解消した。
表示を元のかんたん表示へ戻し、ストリーム停止を確認してから今回のホストだけを終了した。次の固定成果物の比較中はアプリを停止している。

### ビルド用容量の整理

利用者の許可後、コンパイラーが稼働していないことを確認し、`target/debug/incremental` の各ビルド条件で最新の完成世代を1つ残した。
古い世代・中断済みの一時世代334件を削除し、716世代を保持。対象パス・更新時刻・件数・サイズを事前に記録し、適用直前にも一致とworkspace内の実パスを確認した。
論理サイズ約14.6GBに対し、実際の空き増加は約7.1GB（D空き約1.3→8.4GB）。共有領域を含むため論理サイズを実回収量とは扱わない。
debug／比較用バイナリと回収原本はSHA256不変を確認し、release成果物・音声・設定・検証記録は削除していない。削除対象はprivateなtarget内manifestに記録した。

#34のRust検証・build終了後、同じ条件で不要となった旧世代70件を追加削除し、最新716世代を保持した。実回収は約2.24GB、累計404世代・約9.35GB。ビルドによる消費後のD空きは約7.56GB。初回manifestは `.git/issue-backlog-recovery/cache-cleanup-manifest-first.json` に別保存し、追加回のmanifestと区別する。比較用の固定engine／Hostと回収データは削除範囲外。

#35の最終build後も同じ範囲で旧69世代を削除、最新716世代を保持。実回収2,315,735,040bytes、累計473世代・11,664,711,680bytes（約11.66GB）。D空き7,511,003,136bytes。第2回manifestは `.git/issue-backlog-recovery/cache-cleanup-manifest-second.json`、第3回はtargetのmanifestへ保存した。最終engineとHostのSHA256が整理前後で不変なことを確認した。

### 能力snapshot追加後の短時間比較（#44 A）

容量整理後のdebug buildは成功。固定engine SHA256 `A5B9DAEAED222E2AF4BB6608D52374676CBCB4940C2499E755FD4EC4AB9946D2` を使用した。
全体ミュート、ユーザープロファイルを書き換えない直接IPCで、VSTなし・保存済み2本の停止中初回復元・同一プロセス再ロード・稼働中追加を順に実行した。

| 経路・要求バッファ512 | VSTなし開始ms | 初回2本の開始ms | 再ロード後の開始ms | 稼働中追加前の開始ms |
| --- | --- | --- | --- | --- |
| ASIO・96kHz | 1796.6 | 1503.9 | 1476.7 | 1446.8 |
| WASAPI・48kHz | 150.1 | 86.5 | 88.4 | 40.3 |
| WASAPI・44.1kHz | 155.3 | 49.5 | 44.0 | 40.4 |

すべて開始・復元に成功し、停止中はprepared=false、稼働中はtrue、実callbackと終了を確認した。EngineError・prepare警告なし。
ASIOのdevice解決は約1.41〜1.79秒で支配的、能力snapshotの取得は合計約14〜42µsだった。今回の単発比較から起動時間の有意な短縮は主張しない。
WASAPI 44.1kHzの初回2本では20callbacks中の最大処理時間11.194msを観測した。短時間・全体ミュートの確認であり、可聴の音切れや期限超過がないことの証拠にはしない。
restoreのdeferred_wait計測には状態適用時間も含まれるため、各phaseを相互排他的な内訳として合算しない。OSのcold cache、release、聴感・OBS到達、長時間は未確認。

開始失敗のロールバック、自動バッファの無制限上限、再検出完了直後の同時要求などは独立レビューと失敗注入で確認する。
自動テスト、実画面、実音声、OBS到達、長時間、公開版の証拠を混同しない。

### 歌向けDSP単体の予備計測（#34）

音声デバイスを使わず、実際のsinging.rs／core/dsp.rsを独立helperへ取り込み、rustc 1.92.0・opt-level=3・LTO・panic=abortで計測した。アプリ全体のrelease buildや実機CPU使用率ではない。
環境はAMD Ryzen 7 7800X3D（8core／16logical）、Windows 11 Pro 10.0.26300、電源プランはバランス。優先度・affinityは変更していない。
helper SHA256 `44E638C456FBCB288DCA3AE3D02BCD25F4AA5D540C4833E08EABA8DDE6D22B4C`、singing.rs `4D71CEF7A3AD31C4EB766ACBE68E010554031915BECDFC133D72752ABD0FFA2F`。
44.1／48／96／192kHz × 既存3preset／singing × 無音／微小信号／正弦の48条件。入力は同じ512 stereo framesを繰り返し、64block warmup後に512block×3trial。初回31値と連続1536値を別集計し、外れ値除去・空の時計コスト差引きなし。コンパイラー・アプリの音声処理は並行実行せず、OSの背景処理は隔離していない。

| 入力0.4の正弦、512 stereo frames | 旧3presetの連続中央値µs | singing連続中央値／p95／最大µs |
| --- | --- | --- |
| 44.1kHz | 各6.7 | 16.0／20.1／88.1 |
| 48kHz | 各6.7 | 16.1／20.2／128.0 |

singing初回中央値は8.9／9.2µsだが、初回は圧縮検出器の履歴も短く、コードcacheだけの差と解釈しない。単一プロセス内の予備計測で、統計的有意差・最悪時間・全エンジン性能を保証しない。
構造体本体のsize_ofは旧voice chain 32bytes、SingingChain 172bytes。歌向けchainは旧chainと併存する。この値はstack上の構造体だけで、係数メッセージ・Host・キュー・録音・候補buffer等を含む全保持メモリ増加量ではない。RT割当は別の対象テストで0を確認した。
helperと集計JSONはignoredの `src-tauri/target/issue-backlog-singing-performance.*` に保持。集計JSONだけから全生サンプルの再集計はできない。歌唱音質・実VST併用・実機連続運転は未確認。

### 歌向け候補の短時間実機確認（#34）

debug buildは成功。固定engine SHA256 `A05035A16464BD9B53B326D67E32AF93BC9367C24967AA149A19533443629210`、Host `1C6EA309B85DCF3DB3A18F603B4A00E0722264ACA0CAC22B7FC784B38733AD7D`。
実機確認はユーザープロファイルを書き換えない直接IPC・VSTなし。通常出力は開始前から全体ミュート、8kHz／−42dBFSを仮想ケーブルへ送り、1秒をメモリにだけ録音した。

| WASAPI、要求512 | 原音sample peak | 内蔵候補sample peak | 候補生成中の通常callback |
| --- | --- | --- | --- |
| 44.1kHz | 0.007947 | 0.011488 | 202→206 |
| 48kHz | 0.006912 | 0.010583 | 204→208 |

候補は低域整理80Hz・dynamics 0・明るさ+3dBで、各44,100／48,000framesの生成を完了した。開始前のCAS適用・1回undo・古い世代の拒否、開始初回で最新revision一致、候補生成前後の通常config不変と出力peak 0を確認した。
ASIO／Voicemeeter Insert／96kHz／512でも歌向け設定の適用・undoのRT応答、31callbacks（実512frames、最大処理1175µs）を確認。ASIO区間の入力は既知信号ではなく、音質試験とはしない。

独立試聴の別実行では、直前の全設定が以前のバックアップと一致することを確認後、許可済みのVoicemeeter A1を一時解除した。48kHzの歌向け候補をスピーカー（Soundblaster）で開始し、同一カーソルのA/B更新位置203→213ms、音量合わせ利用可、停止stoppedを確認した。通常config不変・出力peak 0を維持。試験後のVoicemeeter全XML設定はバックアップと一致し、試験用engineは終了した。
これはデバイスstreamと候補の接続確認で、可聴確認は未取得。以前の利用者回答「確認できなかった」を聞こえたという結果へ変更しない。歌唱・実VST併用・OBS到達／混入・長時間品質は未確認。実アプリの新UI操作確認も別に行う。

#34 UI初回の全体は60ファイル440テスト、TypeScript、Vite buildが成功。その後の独立レビューで、内蔵設定revisionが同じまま音声停止／再開した際に稼働表示が古いままになるP2を修正した。streamFailedを含む実stream状態の追従と古い応答の排除を追加し、対象26テストと1回の再レビューが成功。

実画面の初回独立試聴では、StrictModeの後始末が旧通常再生の停止APIを呼び、その条件変更通知で新しい試聴を終了させる競合も確認した。所有する独立sessionのcloseと録音停止だけへ修正した。録音停止は通常送出を変えないため条件変更から除外したが、録音開始は旧通常再生をマイクへ切り替える場合があるため変更扱いを維持。試聴の再準備は録音開始応答直後から録音完了ready遷移へ移した。新しい条件変更だけで試聴を復活させない。

この追加範囲はUI30テスト、Rust条件4テスト、TypeScript、all-target check、strict Clippy、Vite、Host buildが成功。独立レビューの開始分類P2を修正後、1回の再レビューPASS。生成Host SHA256 `809F7AE95A16532F34B08FF2673791C46679CD93D56B213481D4C470E6EAE978`、engineは上記A050のまま。

900×600／DPR1の実アプリで、歌向け下書き90Hz→初回独立試聴が停止中idle→設定へ戻る90Hz保持を確認した。ASIO／96kHz／512・2本VSTを保持し、通常内蔵設定はbroadcast OFFのまま。入力ゲイン0・全体ミュートで10秒のゼロ入力をメモリ録音し、自動完了後の試聴idleと歌向け候補960,000frames・sample peak0の生成を確認した。私的音声ファイルの保存・試聴再生はしていない。

入力ゲイン100%／ミュートOFFへ戻した後、同じ内蔵revisionで音声を停止→再開し、表示が「次回の音声開始」→「稼働中の処理」へ追従することを確認。実streamは元のASIO／96kHz／512、VST2本、NR／内蔵OFFを確認した。合成DOM操作の確認であり、OSの実キーボード・高DPI・読み上げ・聴感の証拠にはしない。次の変更前に音声停止とrunning=falseを確認し、今回のHostだけを終了した。

### 独立残響の統合検証（#35）

声activeと独立した初期OFFの4FDN残響を追加。旧声APIは残響を保持し、旧profileの内蔵カテゴリがあれば残響欠落をOFFとして復元する。exact-frame allocatorで原音＋tailを確保し、64MiB payload超過は事前拒否。通常OFFのフェード、send cutとtail outputの分離、全体mute／停止でのtail消去、RTの無割当と制御側への所有値回収を維持した。

初回backendレビューは候補のdurationMsが原音長のままのP2を検出。選択中候補の封印済み全長を使い、停止後も保持し、取消時はposition0と原音長へ戻す。回帰追加後の1回再レビューPASS。UIレビューもPASS。最終UI全体60files／454tests、Rust234lib＋関連統合（queue2／lifecycle1／maintenance1／MSIX2／OTT editor1）が成功。OTT module lifetime1件は既定の明示実行条件によりignored。all-target check、strict Clippy、TypeScript、Vite、debug engine／Host build成功。環境のhardlink→copyと既知の空vendor-react chunk警告を観測。

最初の固定engine `0857DCF911BC99696A7397ACB597D9C314F120C2A6B45740DBBF6CFA667FA371` で、WASAPI44.1／48kHz・要求512、VSTなし、出力gain0・mute OFF、仮想ケーブル8kHz／−42dBFSを1秒メモリ録音。声OFF・残響ON（mix0.25／decay0.3／damping0.5）の候補が各 source44,100→render74,971frames、48,000→81,601framesを生成した。端数1frameはf32設定値からのceilで、実封印長と一致。候補生成前後の通常設定不変、通常output peak0、残響だけのlive apply／undo RT応答を確認。

時間表示P2修正後の固定engine `7375C84C8FA67244FB2DF9C08D07D0964A198B16FF63DCDF47D45FF7383AA706`、Host `AD6916BDA7B013D4F8B176AC697F84545CA8091E66EF03749327B183E127967E` で48kHzを追加確認。Soundblasterの独立試聴でA/Bの同じcursor更新とtail区間 position1003ms／duration1700ms、停止stoppedを確認。通常設定不変／output peak0、Voicemeeterの全XML設定が試験前バックアップと一致して復元された。ASIO／96kHz／512でも残響apply／undo RT応答と31callbacks（最大処理1407µs）を確認。ASIO入力は既知信号ではなく、短時間の接続・反映確認である。

同じHostの900×600／DPR1実画面で、初期残響OFF、声OFFのまま残響ONの下書き、独立試聴画面との往復、通常残響nullの保持を確認。入力gain0・全体muteで2.40秒をメモリ録音し、source230,400／render470,401frames・peak0と原音への無音追加／tail窓の説明を表示した。実際の歌唱、OS実キー、高DPI、読み上げの検証ではない。入力gain100%／mute OFF、元のASIO96k／512と2本VSTを確認し、音声停止・running=falseの後で今回のHostだけを終了した。音声ファイルの保存なし。試験用engineも終了した。

DSP予備計測は、実singing.rs＋reverb.rsをrustc1.92／opt3／LTO／panic=abortの独立helperへ取り込んだもの。5rates×声のみ／残響OFF／ON×無音／微小／正弦の45条件、512stereo frames、64block warmup、512block×3trial、初回31値。入力は同じblockの反復、外れ値除去・時計コスト差引きなし。CPU／OS／電源条件は上記#34と同じで、コンパイラー／音声アプリを並行実行していない。背景OSは隔離していない。

| 0.4正弦、512frames | 声のみ median／p95／max µs | 残響OFF median／p95／max µs | 残響ON median／p95／max µs |
| --- | --- | --- | --- |
| 44.1kHz | 16.1／20.8／314.5 | 16.2／21.7／174.4 | 27.1／37.0／138.8 |
| 48kHz | 16.0／20.6／232.7 | 16.3／23.0／116.3 | 27.5／37.1／111.8 |

初回の各512framesは最初の反射より短く、検出器・ring履歴も異なるためcacheだけの比較ではない。1プロセスの予備測定で、最大値の大小を統計的な改善と扱わない。Reverb構造体272bytesに加えてringは192kHz約114KiB／384kHz約228KiBを保持する。Host・queue・原本・候補等を含む全エンジンのメモリ増分ではない。helper `DB9352267E56249895198FC41B21ED59CAD1A8CA4C173C7C802149D5D48D5662`、reverb.rs `4D287871A0E14EB916102E6646B20FE3AA60E69B0795AEB0508F8E5CFAEE3C83`。集計JSONとhelperはtargetに保持し、全生サンプル再集計はできない。

利用者は以前の試聴を聞こえたと確認していない。今回もstream／cursor成功を可聴・歌唱音質・クリックなしの証拠としない。OBS混入／最終録音、歌唱、実VST併用時の残響品質、release性能、長時間運転は未確認で、#35全面完了や公開を宣言しない。

### 歌／雑談モードの統合途中（#36）

[本番モードの契約](LIVE_MODES.md)に沿い、内蔵処理だけの独立定義保存、明示歌／雑談指定、固定2voice・20msクロスフェードと最新1目標、音声callback受理／完了、自然tail、個別変更後のCustomを実装した。デバイス・VST・NR・gain・muteはモードに含めない。保護は明示操作・アプリ再起動でOFFとし、保護中の経路／ラック／全profile変更は開始前に拒否する。停止・緊急mute・具体的な同設定復旧は許可する。

frontendはOBS連動を方式排他の単一routerへ集約した。明示保存した連動だけ背景接続を保持し、接続時の現在sceneを適用せず、接続世代・最新連番・操作Intentを照合する。未割当や古いイベントを旧presetへのfallbackにしない。既存8操作に歌／雑談の明示hotkeyを加え、登録上限8を維持する。実OBS・OS hotkey／Stream Deckは未確認。

初回backend独立レビューは、遅い旧Disarmが新しい保護を解除するP2を確認した。Arm／DisarmにもHost世代とclient順序を必須化した。複数IPCの旧preset／profile復元はBegin／End予約で囲み、復元途中のmode／arm／定義保存を拒否する。異常交代時も旧workflow終了まではcanceled予約を保持する。tokenless IPC自体を強制中断する保証ではない。対象14tests・all-target check・strict Clippy成功、再レビューと統合検証は継続中。

frontend初回の全体64files／476tests成功。その後の独立レビューで、復旧のsnapshot／実設定取得待ちをStart中と誤認し、手動Stop後に再開するP2を確認した。実Startだけを世代付きで所有する修正と、遅いsnapshot／実設定応答・新旧復旧の交差の3回帰を追加し、最終検証中である。

初回固定engine SHA256 `C8DFEEB221E0F1994C96B8F0DBA6EC220F53A9DA039FF84A87577C4A3D0877CC`（上記Intent／予約修正前）で、ASIO／96kHz／512に元のOzone 12 EQ・Insight 2を復元した。歌→雑談→歌→雑談の最新目標へのsettled、同じ指定でrevision不変、停止後の同設定再開、旧epoch拒否、保護中のscan／異rate／VST削除拒否を確認。VST IDは維持され、2本のserialized stateが前後一致した。WASAPI44.1／48kHz・要求512でも同じmode／停止再開を確認した。WASAPIの実callback長は可変で、要求512を実値と扱わない。

通常output gain0・output peak0、試験engineは終了済み。WASAPIの8kHz／−42dBFS source起動成功だけでは、受信周波数の一致を保証しない。最後の統計は再開後1〜2callbacksのみで、性能や長時間の証拠に使わない。修正後成果物での追加確認は別記する。歌唱聴感・クリック・OBS最終録音・実キー・長時間は未確認である。

### レート変換の数値比較と予備時間計測（#46）

固定依存rubato 0.14.1の実FftFixedInを、44.1↔48kHz・mono／stereo・target128／256／512／1024の16構成で比較した。製品標準1024と依存は変更していない。数値helperはrustc1.92／opt3／fat LTO／panic=abort、4秒入力と可変callback・端数73frames、64 impulseと136 tone条件を使用。2秒の整数周期窓・4開始位相で振幅を計算した。音声デバイスと実音声ファイルは使っていない。

| target | 最初の出力までの入力収集（44.1→48／48→44.1） | APIのfilter delay | 高域の振幅 |
| --- | --- | --- | --- |
| 128／256 | 5.805／5.333ms | 約1.66ms | 20kHz約−5.63dB、21kHz約−36.03dB |
| 512 | 11.610／10.667ms | 約3.33ms | 20kHzほぼ0dB、21kHz約−5.11dB |
| 1024 | 23.220／21.333ms | 約6.67ms | 20／21kHzほぼ0dB |

128／256は同じFFT長に丸められる。収集とfilter delayを合計遅延として足さない。impulse peakはAPI delayによる予測から±1output frame、完全な収集分のフレーム対応とwrapper残余／FFT内部carryを別々に確認した。高いalias射影抑圧だけを全雑音保証にせず、f32の総残差約−138〜−142dBと区別する。小単位化は高域品質も変えるので標準1024を維持し、まずWASAPIの同ch／同形式の対応能力に基づく同率優先と有限fallbackを検討する。ASIO共有driverのrate変更を独立WASAPIと混同しない。

別helperでFftFixedIn process_into_bufferだけを事前確保したplanar bufferで計測した。31初回、64warmup、連続1536calls、同じ正弦block反復、16構成、外れ値除去・時計コスト差引きなし。計測中のalloc／deallocは全構成0。stereoの128／256／512／1024順の入力1秒あたり処理時間は44.1→48で約0.492／0.474／0.456／0.411ms、48→44.1で0.552／0.500／0.439／0.433ms。各構成p95は1.6〜15.9µs、最大13.0〜94.4µsだった。単位が異なるcall時間だけでCPU改善を主張しない。

Ryzen 7 7800X3D／Windows 11 Pro 10.0.26300／バランス電源、通常priority／affinity。コンパイラー・Auralyn音声プロセス不在を確認し、OS背景処理は隔離していない。1回の短い予備測定で、全wrapperのinterleave／収集・callback・VST・全engine CPUや最悪時間の保証ではない。初回値もreset直後のcold cacheだけを意味しない。

数値helper SHA256 `0A9F1DD1CEA094C2553E5CF72BAA852C0B635A4576D4E41F2702A58A408662C3`、数値JSON `2B7941A07AC86EEF237107C73EC2B627AA7EFA07D1266C9C0D22D2C0ABCCAF26`。時間helper `F9D574A344CCAA58D7FA04E55D55E5A8ACE7B26A22115168469E7A6FB156C2F6`、全sampleを含む時間JSON `7AD677A33B05B2377DB31D0D121411C20DC991808BA93A8744BE749483C6A583`。helper・raw JSON・manifestはignoredのsrc-tauri/targetに保持した。実機・独立clock・聴感・長時間は未確認。

### キュー監視とフレーム対応の設計調査（#47・#28）

現行audio ringはそのままに、入力到着／出力生成と出力消費の数値だけを固定容量の別SPSCへ記録し、非RTで絶対frame位置を照合する案を整理した。入力received、変換後generated、queue offered／accepted／dropped、consumed、zero-filledを別計数し、現在量／最大量／容量と実出力rateを使うmsを分ける。metadata不足・順序逆転・世代変更はunknownとcoverage欠損にし、計測情報が足りないことを理由に音声を待機・破棄しない。製品実装はまだない。

測定境界は共通Instantによる入力callback到着→対応queued frameを消費する出力callback開始／終了。NR・VST・残響で変形／保持された実信号の到達時間ではない。CPAL 0.17.3のWASAPI playbackは空きframeからの推定、ASIO capture／playbackはdriver時刻±buffer/rateの計算である。CPALのstream時刻と共通Instantを無根拠に減算しない。申告／計算／観測／不明を別表示し、binによる分布・frame加重・coverageを併記する設計とする。

段階Aの監視だけでクロック差補正完了としない。段階Bは周期差／速度差／停止の制御試験、observer OFF／ONの割当・CPU比較と実機長時間を先に行う。無測定のqueue jump・自動補間・可変比変換の導入はしていない。

#66の実200%表示・実キー・Narratorは利用者から「後で手動確認する（今は未確認として進める）」の回答を受けた。合成DOM操作や自動a11y testをその代替完了にしない。

#36の最終統合結果：backend／frontendとも初回P2の修正後に1回の独立再レビューPASS。UI全体64files／479tests、Rust248lib＋queue2／lifecycle1／maintenance1／MSIX2／OTT editor1、all-target check／strict Clippy／TypeScript／Vite／debug buildが成功。OTT module lifetime1件は通常の明示実行条件によりignored。hardlink→copyと空vendor-react chunkは既知警告である。

修正後の固定engine SHA256 `666F884271C0CACFEB192ED47A403CB190EAD8E874B6BF75D3026F537C3779CD`、Host `B6127723653FD1D2E0887CE784E0B2A9ECFEA2D6AB553F4FF44CFEFD26FF086F`で3経路を再確認した。ASIO96kHz／512／2VSTで最新目標・重複・停止再開、serialized plugin state2本一致、旧epochと逆seq Disarm拒否、保護中のscan／別rate／unload拒否を確認。再開後76callbacks・512frames・最大処理2612µs。WASAPI44.1／48kHzでは各41callbacks、441〜1036／480〜1056frames、最大1247／1690µsだった。いずれも通常output gain0／peak0・EngineErrorなしで、短時間の機能確認であり性能保証ではない。

WASAPIの観測input peakは0.008042／0.007191。既知8kHz sourceを起動した区間で信号量を観測したが、周波数一致や全波形は確認していない。ASIO入力peak0を既知信号の通過試験と解釈しない。全helper子engineは終了した。

900×600／DPR1の実Hostでは、未登録の歌指定が日本語エラー、適用済みのbroadcast OFF／残響nullを歌・雑談へ登録、歌settled→本番保護ON→雑談settled→保護中Stop→停止中目標保持を確認した。保護解除後、同じ内蔵設定を手動applyしてCustomへ戻した。別Host probeで二重Begin・予約中mode／arm／save・不一致End・旧Endを拒否し、snapshot不変／pure preflight許可／finally End成功も確認。実画面のテストは合成DOM操作で、OS実キーやNarratorの代替ではない。

試験前に存在しなかったlive_modes.jsonだけを、試験が書いたSHA256 `3CFF52A661A15870B5B1DE5E5B118D99490337A112CCE9BA4A0473FDFA5E581F`との一致・絶対pathを確認して削除し、元の未登録状態へ戻した。元のASIO96k／512・VST2本・NR／内蔵OFF・gain100%を保持。停止はAutoGain status running=falseとlive mode running=falseで確認した。既存get_audio_state.is_runningはsidecar生存を示すため、停止判定には使っていない。自分が起動したHost PID84516だけを終了し、Host／engine不在を確認した。元のVSTバックアップSHA256 `C90B35B06E2544B0D7633303BB24F44FA6020DEDCD38F341EDFEC3F45D27C6AF`も不変。画面画像はsrc-tauri/target/issue-backlog-live-modes-900.png、私的probe結果は.git/issue-backlog-recoveryへ保持した。

実OBSのscene連動、OS hotkey／Stream Deck、歌唱／クリックの聴感、長時間は未確認で、#36全面完了には含めない。

### 同率入力選択の実装（#46）

[入力レート選択の契約](INPUT_RATE_SELECTION.md)を追加。既存の起動能力snapshotを再利用し、WASAPIで既定入力と同ch／F32の対応rangeが出力rateを含む場合だけ、ch／bufferを保持して入力を同率へ変更する。能力取得失敗・別形式／chを対応と推測しない。優先入力のbuild拒否後は同じ出力rate／有効bufferで既定入力へ一度戻し、その後は従来の出力既定fallbackを一度使う。各fallback予算を一方向に消費し、最大3試行。毎回stream／callback所有値を回収してからprocessorを再準備する。ASIOとrubato1024は変更していない。

新規4testsと既存snapshot回帰を含むcore対象40tests、all-target check／strict Clippy、rustfmt／差分チェック成功。独立レビューと実機は継続中で、対応能力どおり実機が受理すること、拒否時fallback、音質・CPU・総遅延の削減量を自動テストだけから保証しない。

#46独立初回レビューPASS後、実機照合用の非RT debug rate logだけを追加した。最終Rust全252lib＋関連統合試験、all-target check／strict Clippy、debug engine／Host build成功。engine SHA256 `166846ED41F5994551A61B0A162F9B31C87B29592EC987A6ACAD078ECBB9BACF`、Host `B13CFF98C632599464C06DCB17E671BB5FC512B6CB7D7EA8AE836D23B8EB9292`を生成した。

仮想CABLEのWASAPI44.1kHzで、非RT logの選択input44100／output44100／ch2／preferred_input=trueと、build／play成功、停止後同設定再開を確認。48kHzはinput48000／output48000／preferred_input=falseで既存同率を保持した。どちらもmodeの連打・重複・保護中拒否・旧Intent拒否・出力gain0／peak0・EngineErrorなし。実callbackは44.1で441〜1036frames／48で480〜1056frames、各再開後41callbacksで、要求512とは区別する。ASIO96kHz／512／元2VSTも開始・再開・serialized state一致を確認した。入力だけの実拒否fallback、他機器・多ch・連続運転は未確認。内部の無変換経路を使える選択確認であり、機器内変換や総遅延削減量の実測ではない。試験子プロセスはすべて終了した。

第4回のcache整理では、全compiler停止を確認し、同じ限定scriptで古い69snapshotだけを削除、各crate/profileの最新716を保持。空き5,291,307,008→7,266,107,392bytes、実回収1,974,800,384bytes。第3manifestを事前退避し、第4manifestも.git/issue-backlog-recoveryへ保存した。ここまでの実回収累計13,639,512,064bytes／削除542snapshot。削除対象の論理size3,201,024,390bytesを実回収値に代用しない。今回の固定engine2本とHostのSHA256は削除前後一致し、ソース・保存原本・release・最新cache・比較用binary・数値検証原本は保持した。

### 音声キュー段階Aと完全frame読出し（#47）

[音声キュー観測の契約](QUEUE_DIAGNOSTICS.md)に基づき、入力受取、変換後生成／投入対象、受入／満杯時破棄、要求／読出し／不足補填、不足callback、現在／最大観測／容量、frameに満たないslotを分けて追加した。input/output rateが異なる場合は入力frameと出力frameを差し引かない。制御側observerとcallback単位の固定個数atomicだけを使い、sample別履歴、RTの時計・ログ・割当・lockは追加しない。既存sample ringは共有し、Engineが最後のArcを制御側へ保持する。

producerがf32を個別公開する途中にconsumerが片chだけpopする境界を修正した。output chの完全frame分だけを読み、不完全な末尾slotは次callbackへ残し、足りない全frameをゼロ補填する。既存のpush予算／mapping／満杯時破棄・callback容量・NR／既存推定遅延式は変更していない。

独立初回レビューPASS。新規Rust6tests／UI3testsを含め、対象Rust48unique・UI25、最終全Rust258lib＋関連統合、全UI65files／482tests、all-target check／strict Clippy／TypeScript／Vite／debug buildが成功。初回ClippyのIPC enum肥大化は非RTのOption<Box<QueueSnapshot>>へ変更し、JSONを維持して解消した。OTT module lifetime1件は通常の明示実行条件によりignored。

固定engine SHA256 `7B2CC29A36F61C710BC4A841B04559F0A14D0B02299AB2A557E0170BD06F0EB5`、Host `CDD3104B19EEA4F5837B0E48D52C5C0A73416C451C628897496E21887D3A20F4`。mode／保護／VST状態不変の3経路回帰に、停止後の保存則3組と同epoch／現在量nullを追加して成功した。

| 経路・停止後値 | 入力受取＝出力生成＝投入＝受入 | 読出し／不足補填／停止残量 | 最大観測frame | 満杯破棄 |
| --- | --- | --- | --- | --- |
| WASAPI44.1k／2ch | 18,050 | 18,050／1,067／0 | 882 | 0 |
| WASAPI48k／2ch | 19,680 | 19,200／1,056／480 | 960 | 0 |
| ASIO96k／22ch／2VST | 39,424 | 38,912／512／512 | 512 | 0 |

accepted+dropped=offered、consumed+zeroFilled=requested、accepted−consumed=queuedAtStopを停止後に確認。要求512と、WASAPI実callback441〜1036／480〜1056framesを区別した。ASIO容量は96,000slotを22chで割った4,363frame＋余り14slotで、ステレオ500ms容量をそのまま当てはめない。最大キュー量のmsは信号通過時間の実測ではない。不足には開始直後の読出しも含み、可聴音切れ件数や既存glitchCountと同一視しない。通常output gain0／peak0、engine errorなし、元2VSTのserialized state一致、全試験子engine終了。

900×600／DPR1の実Hostでは、元ASIO96k／512・2VST・NR／内蔵OFFを保持して詳細の稼働／停止を確認した。公開途中の381slot＝17完全frame＋7slotという観測も得たが、音声の部分frame読出しは行わない。停止後4,483,072frame受入、4,482,560読出し、512不足補填、512残量、満杯破棄0・不足callback1を表示。約47秒の短い表示確認で、長時間安定性ではない。通常gain100%を保持し、AutoGain status running=false後に自分のHost PID62048を終了、子engineの終了も実確認した。読み上げ・OS実キー・高DPI・聴感ではない。画像はtarget/issue-backlog-queue-900-running.pngとstopped.png。

単体予備計測はactual queue moduleをincludeし、両条件共通のmapping／完全frame push/popへ、ONだけatomic記録を加えたもの。1／2／22chの9組合せ、固定128／256／512と可変、空／定常／満杯の108条件、3trial×64warmup＋128paired sample、41,472組。入力／出力・受入・読出しのpaired一致assertは全成功。維持用drain/refillは計時外なので、helperの最終累積値を実キュー保存則の検証に使わない。

512frame同ch定常のOFF／ON中央値はmono1.6／1.6µs、stereo3.0／3.0µs、22ch27.4／27.4µs。108条件とも差の中央値0nsだが時計100ns刻み、0ns sample6,134件もあり、追加負荷ゼロとは結論しない。外れ値除去なし、OS背景非隔離、同一threadで短時間の観測である。producer／consumerの別thread競合、poll、全callback、実機CPUは未測定。

QueueDiagnosticsのsize_of192B／align64、Arc配置256B＋例epoch capacity27B＝283Bは計算値。allocator丸め・OS RSS・Engine総layout差を含まず、既存ringのsample payloadを追加負荷へ足さない。module SHA256 `166C0AA9B453EF82D5D0593EA5B4F64D218C98F365387777EDDB07EEF4869366`、helper `1FFBE106228FF50512A741C8CBD887422C042E5317B3E8DFA0B224EE6CE63B3C`、全時刻JSON `9B9DFCF1030AFECCB0C8B701269DC0400964CD36B2646012E6457476D78F0623`。private helper／raw／summary／manifestはtargetに保持。

段階Bのclock差補正／自動trim、到着時刻の対応付け、実機長時間・音質・OBS最終録音は未実装／未確認で、段階Aだけで#47全面完了にしない。

### ノイズ低減の数値・単体CPU検証（#48）

actual core/dsp.rsのRtNoiseReducerを直接includeし、固定nnnoiseless0.5.2の既存release artifactを使った。mode／strength／profile／voice guardの最終mixはhelperへの式の転記であり、実engine通過と区別する。NN artifactはdep-info／fingerprint／hashを記録したが、現sourceからのclean rebuild証明ではない。package限定Cargoによる出典の追加確認は、同名registry依存の曖昧性とworkspace外feature指定の拒否でbuild前に停止し、artifact／sourceを変更していない。

44.1／48／96kHz、OFF＋4mode×strength.25／.75／1.25、cold impulse／同一状態対照との差分warm impulse／coded noise／合成声／sweep／帯域burstの546条件、非finite0。coded-noise wet相関lagは各881／959／1,919sample、約19.98msで、相関係数.8913／.9129／.5722だった。cold impulse peakも同じ位置。閾値onset、peak、相関lag、10ms処理フレームを集める計算値は別の量である。dryを含む混合後は即時成分も残り、単一のNR総遅延として約20msをruntimeへ置換しない。

解析は0〜40msの全lagと間引いたsample対を使う近似。初回private helperの粗いlag探索ミスを修正して全数値を再実行した。周期信号・alias・競合peak・NN非線形／状態依存の限界を記録し、唯一の普遍的な遅延や帯域変化の原因分離を主張しない。reset／OFF→ON後はzero peak0、freshとの差0、true→trueは連続処理との差0を確認。実detector／学習profile作成は通さず、固定条件を区別している。

standalone CPUはNR＋再構成mix＋checksumだけで、39構成、512frames、3trial×64warmup＋128計時block。Get-Processでcompiler／Host／engine不在を直前確認した正式runだけを採用。ON p50は44.1k75.7〜77.2µs、48k70.9〜72.0µs、96k76.9〜77.5µs、p95は各150.3〜171.7／138.4〜172.1／82.9〜138.5µs、最大486.3／585.3／546.1µs。OFF約.3µsはdry-read／checksumで空engineのNR段ではない。全callback／実機CPUの保証にしない。全raw時間値を保持し、相関修正前の正確なtimed source／exe hashと現在numeric helperを区別した。

独立read-onlyレビューPASS。helper SHA256 `8C1D96841818ABF47A68C4A7ECE2AD4F4BC393CCA376458DC0D0FF297A88C5AF`、最終numeric `6270B3E23919AD8F7B71E10CD2EE3E30322B14B7F673CA59B0400B3D801B921B`、正式timing `724C71B35C5A760F6C52CF077469275A594553CA82572830F15EE7F202E7FFCF`。helper／numeric／timed-source／raw time／summary／manifest／reportはignored targetに保持。私的音声ファイルの保存なし。

利用者は今は歌唱素材を用意しないと指定している。実歌唱／聴感／クリック／実driver遅延／長時間は残る。原音へ無条件に遅延を足す変更や、NNモデル／フレーム／標準mixの置換は行っていない。表示契約は下記で整理した。

### 計算・申告値と未測定の表示（#28・#48）

[遅延表示の契約](LATENCY_MEASUREMENTS.md)に沿い、実行状態・公称出力rate・固定buffer要求・NR設定／処理rate／処理frame・VST申告sampleを任意のlatencyMetadataとして追加した。Default bufferの内部仮値512を固定要求と扱わない。旧APIの数値は互換目的で維持し、UIでは非ASIO固定20ms加算・2bufferの総遅延換算・遅延評価を取り除いた。NRの10msは処理frame長の計算値で、約20msの数値研究結果も全信号遅延へ置換しない。全通過時間は未測定と明示し、停止後の現在値や古い世代の応答を表示しない。

独立レビューPASS。全Rust260lib＋queue2／lifecycle1／maintenance1／MSIX2／OTT editor1、全UI66files／488tests、all-target check／strict Clippy／TypeScript／Vite／debug build成功。OTT module lifetime1件は通常の明示実行条件によりignored。最後の音声キュー説明文の整理後は、対応UI3testsとViteを再確認した。最初の旧文言期待だけの失敗を修正し、3件すべて成功した。

固定engine SHA256 `ED81B5CB40F937588568C97B5A0B6DA4242C109466B7C8463F13FDE5A4D968DB`、Host `C9DFA21A85F475CB2498465C427B3D8BE6F6BB6EA9E6BC014F9FFE483B6B0706`。900×600／DPR1の実Hostで96kHz／固定512／実callback512、NR OFF／処理960frameの計算10ms／VST申告0、総通過未測定を確認した。停止後は現在数値が消え、累積キュー観測だけが残る。画像target/issue-backlog-latency-metadata-900.pngを確認済み。元のASIO96k／512・VST2本・gain100%・NR／内蔵OFFと保存原本hashを保持し、AutoGain running=false後に自分のHost PID21028を終了、子engineの終了も確認した。OS実キー・DPI・Narratorの代替ではない。

独立engineでWASAPI48k／Default buffer開始を確認し、旧Startedの512とmetadataの固定要求nullを区別した。VST global bypass中のNR ONも設定ON、内部48k／480frame、全信号対応未測定のまま。停止後running=false、固定512での再開は512、NR OFFを確認。出力gain0／peak0、EngineErrorなし、試験子engine終了。private helper SHA256 `CC36D4F878864E17A56D265AAC73DD82947D6137EF8817D6306540CA678C9FE7`とrawはtarget／.git/issue-backlog-recoveryへ保持した。

ASIOの48kHz要求は現Voicemeeter Insertでoutput build時に拒否され、既存fallbackで96kHzへ戻った。入力／出力96kHz、停止再開、出力gain0／peak0、EngineErrorなしを確認。Voicemeeterの全XMLとpreferred rate96000は前後一致し、設定書戻しは不要だった。48kHz動作や共有rate競合の再現成功とは数えない。入力・出力buildが共有driver rateを書き換える可能性はCPALの現sourceで確認したが、input-first比較の前提として整合が必要であり、順序変更はまだ行っていない。

#47予備CPU計測も独立レビューPASS。時計の100ns刻み／0ns sampleを追加負荷ゼロと解釈せず、単threadのqueue処理と全engine CPUを区別した。

第5回cache整理は全compiler停止後、同じ限定scriptで古い69snapshotだけを削除し最新716を保持。空き4,332,429,312→7,148,847,104bytes、実回収2,816,417,792bytes。第5manifestを.git/issue-backlog-recoveryへ保存した。複数のbuildを挟んだ累計は削除611snapshot／実回収16,455,929,856bytesで、作業開始時からの正味減少量ではない。論理候補size3,220,792,296bytesを実回収値に代用しない。固定engine／Hostのhashは一致し、source・保存原本・release・最新cache・比較binary・数値原本を保持した。

### 固定FIFO方針のclock差モデル（#47段階Bの事前調査）

private Pythonで同率の完全frame受入prefix・古い順の読出し・不足ゼロ補填をモデル化した。48k／2chと96k／22ch、512frame、入力−100／0／+100ppm、周期jitter±.25ms／入力250ms省略／出力250ms省略／なし、同時刻の入出力順2通りの48条件。各600秒は仮想時刻の計算で、実機600秒運転ではない。全eventで3保存則・容量範囲、全消費spanのsource ID単調性と非負滞留時間、末尾の保持量一致をassertして成功。独立read-onlyレビューPASS。

出力先行・差0の場合、48k／2chは通常512frameから出力250ms省略後12,288frameとなり、終端まで約256msのcallback到着→読出しの滞留を残した。96k／22chでは同省略で容量4,363frameに達し20,213frameを破棄、終端の滞留は約42.7ms。96k／22chの+100ppm・省略なしも600仮想秒で容量へ達し2,293frameを破棄した。これは現FIFO方針が同率再開だけで増えた滞留を自動回復しない条件の計算例で、実際のASIO clock差や発生頻度ではない。

callback全体を原子的に扱い、実Rustのf32逐次公開／同時thread／partial frame、mapping、resampler、DSP、波形、機器、driverの遅延callbackまとめ配信はモデル化しない。時間はspan単位の入力callback到着→読出しで、capture／playbackや総通過時間ではない。実Rust moduleを呼んだ結果、音質・CPU・長時間実績、自動補正完了とはしない。helper SHA256 `C63556A3CF2868E5A558B0E2A84B55A940204464DC7C08FFB5188D99A4F6F59E`、raw JSON `3EBCAF5DD6BA73B7159C347C05A2E5896DCC7D9985F77C54B359C30A5F70AEE0`。参照queue moduleと容量式を持つcoreのcopy／hash、条件・限界をtargetのmanifestへ保持した。

ASIO順序の追加read-only調査では、同じ名前のsys driverを再利用しても、個別resolveのCPAL Deviceは別のasio_streamsを持つと確認した。同一Device cloneならstream状態も共有する。順序候補の前に同じDevice状態・同じrateへ整合し、失敗時はstreamだけでなくlocal Deviceも回収して有限fallbackへ進む設計が必要。現機器で障害を再現した証拠とは区別する。

### 同率frame観測の初回実装・予備検証（#28）

[対応frameの測定契約](FRAME_TIMING.md)に基づき、入力callback到着から対応する完全frameのpop直後までを観測する。input／output各1024件の固定Copyイベントを非RTで絶対queue frame範囲により結合。sourceの破棄穴、metadataの逆転・欠落、世代、回収待ちを分け、frame加重0.1ms bucketのp50／p95範囲とcoverageを返す。常時bounded drainでUI pollへ依存しない。異率のresampler対応とASIO timestamp周期分類は初版未対応で、全信号通過は未測定のまま。pop直後の固定FnOnce観測をhelperへ加え、音声受入／破棄／DSP方針は変更しない。IPC callback統計のBox化はJSON互換である。

初回独立read-onlyレビューPASS。音声範囲139tests、関連UI64tests、all-target check／strict Clippy／tsc／Vite成功。rootの全体検証はRust270lib＋関連統合、UI67files／491tests成功。OTT module lifetime1件は通常の明示実行条件によりignored。debug bins build51.57秒、固定engine SHA256 `693DD4B5AE476D277D265CAE62404FE0D7B08DFE0239DCCF0F6EDE29CE184EFE`、Host `408B42EA3222447DDAAE061147531ADC04B80C551E404E151204FBE683E0FBE7`を保持した。

各12秒の統計IPC無取得後、停止sealのmatched=consumed、pending=unknown=0、metadata欠落0、再開epoch分離を確認した。通常出力gain0／peak0、テスト音送出・音声保存なし、子engine終了、ASIO元2VSTのserialized state不変。timestampとframe位置の照合であり、ゼロ入力も含む実信号の到達確認ではない。

| 経路・要求buffer／実際の開始buffer | 停止読出し＝対応frame | p50／p95のbucket範囲 |
| --- | --- | --- |
| ASIO96k・2VST・512／512 | 1,150,464 | 5.4〜5.5／8.4〜8.5ms |
| WASAPI44.1k・VSTなし・512／512 | 528,318 | 20.1〜20.2／20.2〜20.3ms |
| WASAPI48k・VSTなし・128／128 | 575,040 | 20.1〜20.2／20.2〜20.3ms |
| ASIO96k・VSTなし・128／512 | 1,149,952 | 5.6〜5.7／8.7〜8.8ms |
| ASIO96k・VSTなし・256／512 | 1,149,952 | 5.7〜5.8／8.5〜8.6ms |

ASIOは固定512へ補正され、128／256の実callback検証とは数えない。WASAPIは開始要求と実callback長を別に扱う。12秒の単発観測で、負荷／音質／長時間安定性や全経路遅延を保証しない。helper／raw／各engine logはtargetと.git/issue-backlog-recoveryに保存した。

actual moduleのprivate CPU予備比較はOFF／ONのqueue push/popと既存atomic counterを共通にし、ONへ固定時計・SPSC記録を追加。1／2／22ch、128／256／512／可変、3trial×64warmup＋256paired、9,216組。32組ごとのnonRT drainは別計時、snapshotとassertは計時外。全条件paired差中央値100ns、時計の刻みも100nsだった。2ch／512の各中央値OFF3.6µs／ON4.9µsの差1.3µsは、paired中央値.1µsと別の量。負の差・外れ値も全保存し、差中央値だけで追加負荷を一定としない。drain32組の中央値2.0〜3.6µs、p953.1〜8.7µs。単thread直列・入力後出力・初期空queue・CPAL timestampなしで、全callback／thread競合／実機CPUの保証ではない。UTC12:22:15.120〜12:22:15.446、全体テスト後にcompiler／Host／engine不在で1回計時し、OS背景は非隔離。独立レビューPASS。

イベント各80B、Shared32B、Observer288B、入力／出力Recorder80／72B、Snapshot208B。ring header384B／align128とTx／Rx24Bを別計上。2ring payload163,840B＋2pending163,840B＋histogram80,008B＝407,688Bは確保payloadで、構造体／Arc／epoch／allocator／OS RSSを含まない。RT recordとhandle dropのalloc／free0をscope testで確認した。固定source A134858C…／queue F6057701…とhelper／raw／実行条件／依存artifact hashをprivate manifestへ保存。旧#47の17788bytes moduleも、以前の完全SHA一致を確認した復元copyへ保存し、履歴の再現元を保護した。

実Host900×600／DPR1では約64秒、元ASIO96k／512・2VST／NR・内蔵OFF／gain100%を保持し、停止後6,130,688frame読出し＝対応、欠測0を確認。一方、稼働中に未回収の末尾1024frameを一時的に欠測と表示するsnapshot分類のP2を発見した。次tick／停止で全件対応しても、回収待ちと欠測は区別すべきである。停止とAutoGain running=falseを確認し、所有Host PID65828を終了した。現在この表示分類の修正と回帰検証を進めており、初回PASSを最終完了の証拠にはしない。

### 未回収末尾の分類修正と再確認

稼働中は、既に非RTへ届いたoutput終端より後の読出し分を「結合待ち・判定待ち」へ含めた。後続eventで途中の欠落が確定したらunknown、停止seal後の未対応末尾もunknownとし、metadata満杯や不正を永久に成功へ置換しない。3回帰と既存Engine sealを含む対象13tests、all-target check／strict Clippy成功。独立再レビューPASS。UIに未回収・判定待ちを含む補助文を追加し、関連12tests／Viteも成功した。

全Rust再実行の初回はWindows mmapのos error1455（仮想メモリ不足）でplugin_scanner testのコンパイルが失敗した。依存破損と断定して削除せず、`-j 1`で再実行し273lib＋関連統合が成功、debug bins buildも42.20秒で成功。固定修正版engine SHA256 `CAECD4F55D4D466C630F9EF2D9CD3B4C3768FF9366B8AB63A58CC4BB95EA043C`、Host `521AADB98F1BE3DC4EBCDBDAC8E18CE401AB3CA38A7D913D9EA80D360864AEA5`。変更は非RT snapshot分類とテスト・説明文で、前述のRT予備比較は旧固定sourceの結果として保存し、修正版全engineの追加CPU保証へ読み替えない。

修正版の実Host PID5040／900×600／DPR1では、稼働中読出10,398,208／対応10,397,184／判定待ち1024／欠測0から、Stop後全10,398,208対応・待ち0／欠測0への遷移を確認。約108秒、元ASIO96k／512・2VST・NR／内蔵OFF・gain100%を保持。画像target/issue-backlog-frame-fixed-900-running.pngを実表示確認し、AutoGain running=false後に所有Hostを終了、子engineの終了も確認した。OS実キー／DPI／Narratorや長時間品質の代替ではない。

修正版のVSTなしASIO96k／512・12秒統計IPCなしのfixtureは、1,150,976読出し＝対応、欠測／metadata欠落0、p505.9〜6.0ms／p958.6〜8.7ms、再開epoch分離・出力peak0・子終了で成功。2VSTありもframe観測は同1,150,976対応・待ち／欠測0だったが、追加のopaque plugin state完全一致assertでInsight 2だけ不一致となり、fixture全体のPASSとはしない。最初のassert失敗に診断が不足したため、private fixtureへtraceback・既取得stats保存を追加し、次の実行でこの不一致を特定した。

別のprivate調査で、計測追加前のafter47 engineと修正版の両方に、Insight 2の12秒処理後のstate変動を再現した。Ozone EQは不変、Insight 2の停止中連続取得は一致し、原本再適用後は初回restore後のstateへ完全一致。元の保存原本SHA256も不変。差の意味は未同定で、プラグイン設定の意味的同一性をbyte不一致だけから成功／失敗と断定しない。生state・音声は新規保存せず、hash／size／差の位置／圧縮部分のhashだけを私的reportへ保存した。helper SHA256 `3CCB67A4A45469C85543E0A142F66E5F3231089B5AA7F37B86E914217E290A53`。両試験子engineは終了済み。

アプリの既存セッション保存は30秒ごとにもGetPluginStateを読むため、実Host試験中にこの内部変動が通常セッションへ反映される可能性がある。最終の環境復元では元の保護原本と現在セッションのstate・flagsを照合し、試験による保存変更を残さない。immutableな.gitの元2VST原本は保持している。

第6回cache整理では先に旧manifestへApplyを試みたが、既に削除済みのpath検証で停止し、削除前に中断した。その後、全compiler停止・第5manifest退避済みを確認して新たにinventoryし、古い70snapshotだけを削除・最新719保持。空き4,226,105,344→7,092,813,824bytes、実回収2,866,708,480bytes。第6manifestを退避し、固定engine／Host hashも維持した。複数buildを挟んだ実回収累計19,322,638,336bytes／削除681snapshotで、開始時からの正味減少量ではない。

### 有限callback traceと現順序の基準観測（#45）

通常RuntimeStatsへrawを増やさず、`GetFrameTimingTrace { expectedEpoch }`の明示readで直近callback計64件と対応segment64件を取得する。既存80Bイベント／RT Recorderは初回保存sourceと一致し、trace保持は非RTだけ。callbackは共通std開始順、segmentはqueue対応順で、ingest順を実行順と混同しない。CPAL時刻はpublic Ord／duration_sinceのみで符号付き相対ns文字列へ変換。None・逆行・重複・seq飛びとtrace上限evictionを別計数し、物理的な同周期やdriver callback欠落と断定しない。Hostの新readは未起動時のensure／syncと条件witness失効を避ける。未開始・旧epoch・異率はError、seal後のtraceは固定。

frame19＋conditions5の対象24tests、all-target check／strict Clippy成功。独立read-onlyレビューPASS。root全Rust279lib＋関連統合、debug bins buildを`-j 1`で成功。固定engine SHA256 `A1348D3EC5607909ED6F8BB020940C1F40C087E569AE29B2B2CBDAFF1475EEBA`、Host `2B7A81DBB688437A114CFBD7D7A5F490A93D2D10D7F7AF9F55E45796F684BDC1`。frame D9779246…とcore／capability／lifecycle／devices／Host／IPCの固定copyをtargetへ保持した。ASIOのDevice共有・rate・build順はこの時点で変更していない。

ASIO96k／512のVSTなし・Ozone EQ1本、WASAPI48k／512のVSTなしで各短時間fixture成功。未開始／旧epoch拒否、通常稼働の維持、停止seal固定、再開epoch分離、通常output gain0／peak0、子engine終了を確認。EQ1のserialized stateは一致。Insight 2の未同定内部変動とは分離する。callback／segmentは各64以下、上限evictionはmetadata欠落とは別である。

ASIOの2条件とも64segment全てでoutput ordinal−input ordinal＝1。同じordinalを持つ入出力callbackが両方残る32組は、32組ともstd開始が出力先行だった。trace窓に直前outputが残る31segmentでは、inputのCPAL時刻ラベルが直前outputと31／31一致した。これは現登録順の数値的な基準観測で、物理的な捕捉／再生周期の保証ではない。対応frameの読出し時間はVSTなしp505.9〜6.0ms／p958.7〜8.8ms、EQ1はp505.6〜5.7ms／p958.6〜8.7msという単発累積bucketだった。

EQ1条件ではinput／output双方に時刻ラベルの重複1件があり、対応segment1件はequal labelでもordinal差1だった。ラベル一致だけを同周期と判定すると誤るため、分類は補助のままにする。観測したASIOラベル差は−1〜−10ms等で、公称512／96kの5.33msと一致する固定差を仮定しない。WASAPIでは入力ラベル重複99件も観測し、汎用stream時計の共通原点／一意性を前提にしない。rawと集計はtarget/issue-backlog-frame-trace-native-*.log、asio-baseline-analysis.jsonと.gitの私的reportへ保存した。

trace追加のprivate予備CPU比較は、元helperのOFF／ON共通queue処理に、計時外のexplicit Trace readout→black_boxを追加し、LTOで履歴記録が未使用として省略されない形で実施した。最初のreadoutなし試行はDCE未解決の探索値として除外し、retainedのrawだけを採用。12条件・9,216paired、全raw分位／manifest hashを独立レビューで確認してPASS。paired差中央値は10条件100ns／22ch256・512の2条件200nsで、時計も100ns刻み。drain32組の中央値10.6〜13.7µs／p9511.2〜27.3µs。UTC13:06:03.583〜13:06:03.949、compiler／Host／engine不在、OS背景非隔離の1run。CPAL None・単thread直列で、Trace生成自体は計時外だが後続cache／allocatorへ影響し得る。実運用cadence・新たなSome timestamp経路・thread競合・全engine CPUの保証ではない。

追加保持payloadはCallbackRecord176B×64＋SegmentRecord184B×64＝23,040B、従来407,688Bと計430,728B。Observer544B／TraceState256B、返すTrace232B／CallbackTrace160B／SegmentTrace152B、Vec／String／JSON一時値とArc／allocator／epoch／OS RSSは別計上。retained helper／exe／raw／run／frozen sources／既存CPAL0.17.3・ringbuf0.5.3・serde1.0.228 artifactsのhashをmanifestへ保持した。

次段は出力先行順序を維持したまま、ASIOの同一Device clone・同率選択・有限fallbackと資源回収を整合する。その後に入力先行候補を比較する。現環境は96k／512へ制約され、44.1／48kや128／256の実ASIO条件は未確認のままである。

### ASIO入出力のDevice・rate・有効buffer整合（#45前提段階）

同一の公開Device IDを確認したASIOだけ出力Deviceのcloneへ統一し、両方向の既定ch・F32能力を確認して出力rateと補正後bufferを入力へ共有した。従来のlocked512補正は保ち、128／256要求を入力へ再適用しない。出力先行build／play、WASAPI選択・fallback、rubato1024は維持。ASIOの独立入力fallbackを避け、出力default再試行は一度だけ。再試行前にstream／callback回収→共通cleanup→ローカルDevice解放→次のsnapshotを明示した。外部driver clockの巻戻しは保証しない。

独立read-onlyレビューPASS。実装側関連58tests／all-target check／strict Clippy成功、rootの全体Rust284lib＋関連統合も成功（直列-j1）。cache hardlink不可のcopy警告は残るがテスト失敗はない。固定binaryのbuildと実機の受理・再開・trace比較はこれから行う。この段階で入力先行化や遅延改善を完了扱いにしない。

固定debug engine SHA256 `B11B394BF8921EAAC47B78D08E92DDE4F815DC7BE95E78D1AE4E192E5AA49012`、Host `4FDA5190D690088CF5772ADA3813BF15D4A5AEDC26BA93DCF211331A96B91052`（build76秒）。ASIO96k／512のVSTなし・Ozone EQ1本、WASAPI48k／512、ASIO128／256要求→実512の計5条件でtrace取得・誤epoch拒否・停止seal・再開新epoch・出力peak0・子終了が成功。EQ serialized stateも一致。各約2秒の観測で、全信号／音質／長時間／release性能の検証ではない。

ASIO4条件とも保持64segmentでoutputSequence−inputSequence=1、保持された同ordinal31組はすべてoutputのstd開始が先、入力ラベルは前出力ラベル31／31一致だった。共有化だけでは順序待ちを解消していない。VSTなしp505.8〜5.9ms／p958.7〜8.8ms、EQ p505.4〜5.5／p958.4〜8.5ms。差は短い単発観測のbucket範囲で、改善の断定に用いない。48kを要求した別fixtureは出力既定96k／512へfallbackして成功し、Voicemeeter全XMLとpreferred96kは前後一致した。48k実ASIO動作の証明とはしない。sourceの固定copy・raw・集計・hashはtargetに保持し、次段の入力先行候補の比較基準にする。

第7回cache整理はcompiler不在でinventoryを更新し、古い73snapshotだけ削除・最新719保持。空き4,458,135,552→6,970,572,800bytes、実回収2,512,437,248bytes。累計754snapshot／21,835,075,584bytes（buildを挟んだ実回収累計、開始時の正味減少ではない）。適用は成功したが後段のwrapperが古いLASTEXITCODEを誤参照して停止したため、削除を再実行せずmanifestだけ第7archiveへ保存した。固定binaryとユーザー原本は維持した。

### #38 古いメーター値と手動復旧のStart失敗

共通useMeterLevelsへ停止／error時の値・peak・clip消去、非ゼロ通知の1秒timeoutを「更新待ち」へ移す処理を集約した。連続ゼロ通知の省略を考慮してsilentは保持し、タイムアウトを音声障害やOBS到達判定へ変換しない。Header／大メーターへ実稼働stateを接続。手動復旧Start reject時にVST復元・closeへ進まず、失敗表示と再試行を保つ。明示セッション破棄の動作はこの修正では変更していない。

関連16tests・tsc・Vite成功。最初のVitestはTemp rename EPERMで収集前失敗し、workspace内Tempを使って成功。独立reviewと全UI検証は進行中。実機・OBS到達・長時間品質は未確認。

#38の全UI検証は70files／503tests成功、独立read-onlyレビューもPASS。実Host900×600／DPR1で元ASIO96k／512・VST2本が稼働し、詳細表示の入力／出力が「レベル表示中」からStopで「音声停止中」へ変わり、AutoGain running=falseを確認。画像issue-backlog-recovery-meter-stopped.pngを実表示確認した。実OSキー・DPI・NarratorやOBS到達の証明ではない。

Host起動後に保存保護を有効にし、通常SESSIONの2state hashとflagsが.git原本の2件に一致することを確認した。既存BACKUPはInsight1件なので復元元へ使わず、検証済み通常SESSION原文をWebView内だけで保持。停止後に公開set_plugin_stateで2件を再適用し、公開get_plugin_stateのhashが両方とも原本へ一致、flagsも一致。通常SESSION原文を戻し、元のかんたん表示へ戻した。原文不変を再確認して保存保護を起動前のnullへ復帰し、自分のHostだけ終了した。raw stateを新たにログ／コマンド引数へ出していない。元.git原本はC90B35B0…のまま。

#45次段の固定依存再確認で、CPAL ASIOはcallback登録後のdriver.start失敗時にStream未返却のままcallback登録を残す経路が見つかった。asio-sys最終Driver破棄でcallbackがclearされるため、従来helperのcleanup→local Device dropではprocessor_return receiverを先に破棄し得る。DeviceManager activeはDeviceInfoでDriver強参照ではない。成功時の実機PASSやmockの通常build失敗だけではこの依存境界を保証できない。receiver保持中にDevice破棄・返却・制御回収を終える修正と回帰を先行し、未解決のまま入力先行化を完了にしない。

未完了Issue一覧の再取得で、開始時40件に加えて #69 English Language Support（2026-10-23T04:23:36Z作成）を確認した。現在41件。英語UIの要望で詳細仕様は未指定。#69も未着手の残件へ加え、40件すべてを完了したとは報告しない。

#45依存境界の追補: CPALはmessage callbackもprepare前に登録し、失敗時に解除しない。asio-sysのDriver破棄はBUFFER_CALLBACKのみ対象で、destroy失敗時にはそこにも到達しないため、Device drop順修正だけを全回収保証としない。固定CPALのrepo-local最小patch（message登録をprepare成功後へ移し、両callback IDを持つStream構築後にdriver.startして失敗時Dropで解除）と、Device破棄→制御回収順を第一段として進める。依存registry直接編集や他依存の更新は行わず、対応ソース・license条件も確認する。入力先行化はこの段階の受入後に分ける。

#69のread-only棚卸しではi18n／locale保存がなく、通常UIに加えbootstrap失敗・ErrorBoundary・trayも日本語固定、index.htmlのlangだけenだった。TS ASTによる初期候補はtests/assets/commentsを除き1,891箇所／1,639重複除去断片／72file。Rust近似351箇所／40fileはログを含み選別前で、確定翻訳key数ではない。typed catalog＋React provider、明示ja/en（未設定ja）、初回と設定の言語選択、起動前失敗とnative trayの一致を基盤とし、主要導線→詳細/OBS/保存/内蔵→Rust起点error codeへ段階移行する設計。文言による復旧分岐は翻訳前にcodeへ分ける。ユーザーのVST/デバイス/プリセット/OBS名やpath、第三者GUI、OS dialogは翻訳対象から区別する。調査段階であり英語UI実装は未着手。

### #45 開始失敗時のCPAL登録rollback（入力先行より前）

固定CPAL0.17.3をthird_party/cpal-0.17.3へ置き、Cargo patchで選択した。prepare成功後にmessage callbackを登録し、data/message両IDを持つStreamをdriver.start前に構築して、start失敗時もStream Dropで解除する。本番で使用するgeneric所有境界を非実機mock回帰3件で検証する。retry helperもDevice破棄→receiverによるprocessor回収→plugin停止へ修正。input-firstはまだ実装せず、出力先行build/playとRT処理は維持した。

上流とのhash比較はstream.rs変更＋build_lifecycle.rs/PATCHES追加だけ、LICENSE保持。Cargo.lockはcpalのregistry source/checksum2行削除だけで、他package版は不変。SOURCE-DISTRIBUTION／NOTICE／policy備考に同梱・来歴を記載。sourcearchiveはGit全treeから生成するが、新vendorは未commitのため配布archiveは生成していない。

実装側lifecycle18tests／all-target check／strict Clippy-j1成功、独立review PASS。初回はSDK環境不足で自動downloadが失敗した。既存D:/Programming/SDK/ASIOSDKとclang_llvm/bin明示で解消し、SDKの取得成功・更新は行っていない。初回Clippyのmock Arc非SyncだけRcへ修正して再成功。検査後の追加はApache変更表示のコメント1行のみで動作不変。rootの配布51testsとrelease policy checkもPASS、公式配布／署名buildの実施ではない。全体Rust・固定binary・実driverは検証中で、実driverの失敗注入やStop/Dispose/Exit成功はまだ保証しない。

rootの全体Rustは287lib＋関連統合が成功（3分48秒、-j1）。CPAL第一段の固定binary buildを開始した。次の#38停止維持は、現Host.stopがensure_engine_running経由でchildをspawnし得るため、TS事前is_running確認だけを完全保証にせず、execute_running_commandによる局所Rust補強も追加する。

第8回cache整理は全compiler終了後にinventoryし、古い31snapshotだけ削除・最新782保持。空き3,312,730,112→3,858,251,776bytes、実回収545,521,664bytes。manifestを第8archiveへ保存。累計785snapshot／22,380,597,248bytesは複数build中の回収累計で、開始時からの正味減少ではない。依存成果物・固定binary・原本は維持した。

#30優先2のread-only設計はsealed rawの左右別finite/maxabs・20ms channel-energy・活動量/音量差から控えめなdynamicsだけ提案し、lowCut80／brightness0は固定初期値と明示、reverbは自動推定せず既存下書き保持／新規OFFとする。既存QualityReportはL+R平均やnoise不明時-96dBのため提案許可へ流用しない。既存candidate worker／A-B／CAS apply／一世代undoを再利用し、原本不変・無音/clip/短時間/休止不足/noise不明/条件変更で不可を返す設計。実装は未着手で、実歌唱・聴感・部屋残響や最終mix改善は未確認。

CPAL第一段の固定debug engine SHA256 `0ACCA5D6F545277D92C0C74E9C9C584F9C8BAAD3785C4D9BE16A30F921533117`、Host `10F42BD651AF7211504583BDFA0D7B50685B0DC4C976977A12FC7233FE1CD900`（build2分59秒）。14source hashと、lifecycle／CPAL stream／build_lifecycleの一致copyをtargetへ保存した。

実機ASIO96k／512のVSTなし・EQ1本、WASAPI48k／512でtrace／stop seal／epoch／再開／出力peak0／errorsなし／子終了が成功、EQ stateも一致。停止時matched=consumedは各190,464／190,976／95,040、pending・unknown・metadata欠落0。ASIOは保持64segmentすべてordinal差1のままで、入力先行化や同物理周期・全信号遅延改善はまだ確認していない。短い単発のp50/p95はVSTなし5.2〜5.3／8.5〜8.6ms、EQ4.5〜4.6／7.6〜7.7msで、従来値との差をこのstartup修正の効果と断定しない。

追加の有限5cycle（48k要求3回・96k要求2回）はすべて最終96k／512、各36,352frame対応＝読出し、pending／unknown／metadata0、queue保存則・出力peak0・errorsなし・子終了が成功。Voicemeeter全XML／preferred96kは前後一致。helper SHA256 `ada2336a601f99a223b4a7072e34788916d214ed5c7f82728da6c64eb6c37810`。48k実ASIO動作の証明や、driver.start失敗を特定注入した証明ではなく、受理不可要求からの有限fallback反復確認である。raw／集計はtargetと.gitに私的保持した。

#38安全選択の初回独立reviewはP1でFAIL。reader終了後もHost.childのhandleが残るためget_stateはis_running=true、新しいno-spawn Stopはreaderfalseで拒否し、復旧3経路が全て再試行不能となる。TS mockは最初からis_running=falseとしていて実状態を捉えていなかった。終了をChild.try_waitで確認した場合だけ旧child/stdinを制御側回収し、無childも停止済ACKにする修正へ進める。reader終了だけで生存プロセスを停止済みと扱わず、pipe断で生存する場合はfailclosed。停止維持の無spawnに加え、再開時の旧ID破棄と保存gain初期化も維持する回帰が必要。初回TS38tests/check成功を、このP1解消・実クラッシュ確認の代替にはしない。

#38のP1は修正後の独立再reviewで解消（新P1/P2なし）。確実終了/無childだけをkill_engine共通経路で回収・停止済ACK、生存pipe断はErr。Stop後に状態を再取得して旧ID破棄・保存gain初期化を保つ。追加のloading取消finallyは自分の世代だけを解除するdeferred回帰で確認する。現在はさらに、取り消した復元の遅い返却ID cleanupがremove_plugin経由で新childを起動し得る境界を修正中。削除だけのために新engineを起こさず、既存接続に限定する。初回TS41tests／Rust config_storage10／check／strict Clippyは成功したが、この追加後の検証・再review・実クラッシュ確認はこれから行う。

第9回cache整理は全compiler不在でinventory、古い46snapshot削除・最新790保持。空き1,782,599,680→2,833,334,272bytes、実回収1,050,734,592bytes。第9manifest退避済み。累計831snapshot／23,431,331,840bytesはbuildを挟んだ回収累計で、開始時の正味減少ではない。固定binary／原本／依存成果物は維持。

第10回cache整理は古い45snapshot削除・最新790保持。空き1,795,063,808→2,834,731,008bytes、実回収1,039,667,200bytes。第10manifest退避済み。累計876snapshot／24,470,999,040bytesはbuildを挟んだ回収累計であり、開始時からの正味減少ではない。

### #38 実クラッシュの追加確認と背景pollの未解決

最終sourceの独立reviewはPASS、root全UI71files／525tests、Rust293lib＋関連統合が成功。Hostのみbuild46.67秒、SHA256 `A3625A7B87F5C5340E23AB6AAE4DAB3546D7E6938CF54DEBF5F9411D4B7349DF`。全体Rusttest時に通常engine binaryも更新されており、使用engine SHA256 `8EE563389779889A55ADCC0E7653495D2C340422E02550103A651284B10EB941`（mtime23:23:49、CPAL/coreは出力先行のまま）を確認・固定copyした。Host-only buildで古いengineを使ったとは推測しない。

所有Host78440の実ASIO96k／512・VST2本でstream稼働を確認し、通常出力gain0・保存保護の上で子66512をkill/waitして実終了を再現。900×600／DPR1のRecoveryModalで未知原因と3選択を表示、stale handleのgetAudioState.is_running=trueも再現した。画像issue-backlog-safe-recovery-crash-900.pngを実表示確認。Stop選択でmodalは閉じ、原本／保護は維持されたが、背景pollにより別childが起動するため実NoSpawn確認はFAIL。子27348→80336→74484の繰り返しも確認した。

source上、useAudioConfigの2秒status、MasterBarの1秒status/initializeがHost.auto_gain→execute_command→ensure_engine_runningへ進む。GetRuntimeStatsの事前child確認後にも同じensureのraceがある。CLI IPCmonitorとinvoke wrapperは取得0件で、command名捕捉の証拠はない。実際の新child観測とsource経路を根拠に、Status／Initialize／GetRuntimeStats／GetPluginStateを既存接続限定にする追加修正へ進める。全テストPASSを実NoSpawn成功へ読み替えない。

このHostの起動後保存保護が遅れ、Insight 2の処理中stateが通常SESSIONへ保存されていた。音声を停止して保護し、EQの現state＋保持BACKUPのInsight stateそれぞれのhash、全metadataを.git原本と照合して2件を再構成した。JSON全内容のcanonical SHA256 `8045bc0e7e1d2b753eb32faac649e7776d47f81569168d8bc8387c9f29d49970`が原本2件に一致。任意のBACKUPを盲目的に戻したのではなく全内容を検証した。生stateはtool引数・出力・新ログへ出していない。試験終了時にSESSION原本内容／音声設定原文不変・outputGain100・保存保護nullへ戻し、所有Host78440を終了。全Host/engine不在とimmutable原本C90B35B0…不変を確認した。

背景pollの追加修正はStatus／Initialize／GetPluginState／GetRuntimeStatsを既存接続限定とし、cold時のstream照会とgain初期化を抑制。関連UI38tests／Rust15tests、tsc／Vite／all-target check／strict Clippyは成功した。一方、独立した常時mounted caller監査で、LoudnessCheckの障害通知・unmount時の測定停止Noneと、開いていたAutoGainDialogの障害後Cancelもensure経由で新childを起こすことが判明した。この2つの取消処理も追加修正対象とし、実Hostの停止維持成功はまだ未確認である。

第11回cache整理は全compiler不在でfresh inventory後に実施。古い62snapshotのみ削除・最新790保持、manifestを.gitへ退避した。論理ファイル量3,200,813,919bytesに対し実空きは909,778,944→2,710,933,504bytes、実回収1,801,154,560bytes。累計938snapshot／26,272,153,600bytesは反復buildを挟んだ回収累計で、開始時からの正味減少ではない。固定binary・原本・依存成果物は維持した。

取消処理の追加修正は確実終了の共通回収を用い、測定停止None／AutoGain Cancelを既存接続限定にした。不在Cancelはsettled=falseの未確認gainを返し、実callerのpublishOutputGainが保存・同期しない。生存reader断／pipe断は成功扱いにせず、新childも起動しない。正常接続の実gain応答・条件／OBS witness・本番保護の分類は維持。独立read-only reviewは追加P1/P2なしでPASS、関連UI3files47tests／Rust17tests、tsc／Vite／all-target check／strict Clippyが成功した。4poll版の親全UIは71files531tests成功（取消追加はbackendと3testの変更）。最終audio.rs SHA256 `20045F74475BF2F530637AAE19C7BA3FE75C696487233EE8E8B63F0694FC8566`。最終版全Rust／更新Hostの実確認はこの後に行う。

第12回cache整理もcompiler不在のfresh inventory後、古い45snapshotだけ削除・最新790保持。空き1,660,207,104→2,707,337,216bytes、実回収1,047,130,112bytes。第12manifest退避済み。累計983snapshot／27,319,283,712bytesはbuildを挟んだ実回収累計で、正味減少とは区別する。

最終poll／取消版の親全Rustは`cargo test --locked -j 1`で298lib＋関連統合が成功。OTT module lifetimeの明示指定1件はignored、repro_ottの実editor試験は7.71秒で成功し、その子engineも終了した。Host build初回は中間archive生成時のOS error112（ディスク不足）で失敗。全compiler終了後、第13回fresh inventoryで古い16snapshotのみ削除・最新796保持、実回収750,170,112bytes、空き1,219,915,776→1,970,085,888bytes。manifest退避済み、累計999snapshot／28,069,453,824bytes。追加の中間.lib削除コマンドは実行ポリシーで拒否され、実行していない。旧cache整理後の通常build再試行だけで32.13秒成功した。

固定Host SHA256 `AD394444B189A6DEF270A0312D263EE100D0D54BA65D6FAA024D0589A913A8EA`、engine `1EE96318348013377BF9B1FC5269CA2D530AE62BB3C9CF7139A76EF179235255`。private実機helperの独立reviewでは、保護変更途中の失敗で原文復元が飛ぶ点と、プロセス照会エラーを不在扱いにする点を修正。runtime停止IPCの失敗後もLS復元を試す境界まで再reviewでPASS。最初の試行はCLIのJSON指定・説明suffixの扱いでhelper全体FAILとし、実NoSpawnの部分観測と混同しない。JSON指定と限定suffix処理後、所有Host53672／子38128の実クラッシュでは音量調整dialogを開いた状態からkeepStopped→8秒全tick子不在、RuntimeStats／Cancel／測定停止None後も子不在が成功。SESSION全内容・音声設定原文不変、gain100／保護nullへ復元、所有Host・子不在を確認した。900×600のcrash／停止後画像を実表示確認済み。

このhelper初回成功時は起動時保護timerを残していたため、保存保護の維持を製品単独の証拠とはしない。起動復元後・crash前にtimerを解除する条件での再確認を追加し、NoSpawnの結果と区別する。

timer解除後のkeepStopped試験は所有Host88644／子64364でPASS。8秒全tickで子不在、明示RuntimeStats／Cancel／測定停止None後も不在、modal閉・SESSIONと音声設定の原文不変・保護trueを確認した。終了時はgain100／保護nullへ戻し、所有Host終了。次のVSTなし再開試験もHost71848／子91712を確実終了後、新子68872が全tick同一で維持されPASS。開始前activePluginCount=2、再開後active=0／pendingUnload=0／running=true／gain0、SESSION原文と音声設定原文不変、保護true。起動時timerはこの試験でもcrash前に解除済み。終了時に停止・gain100・LS原文・保護nullへ復元し、全Host／engine不在とimmutable原本SHA C90B35B0…不変を確認。900×600のVSTなし再開画像も実表示確認した。

この結果は実クラッシュ後の停止維持とVSTなし再開の局所確認で、全セッション再読込／全VST互換／OBS到達／音質／長時間運転の完了とはしない。private報告はtarget/issue-backlog-nospawn-native-report.jsonとissue-backlog-without-native-report.jsonへ分離した。

第14回cache整理はcompiler／Host／engine不在でfresh inventory、古い2snapshotのみ削除・最新796保持、manifest退避済み。空き1,777,537,024→2,000,097,280bytes、実回収222,560,256bytes。累計1,001snapshot／28,292,014,080bytesは反復buildを挟む回収累計で、正味減少とは区別する。

#38の最終実機報告・helper・画像の独立read-only照合もPASS。timer解除後の停止維持とVSTなし再開にP1/P2・偽PASSは見つからず、短時間の局所受入とした。長時間・全経路品質やIssue全体の完了には拡張しない。

### ASIO入力先行候補（#45）

ASIOのみ入力→出力のbuild登録へ変更し、WASAPIの出力→入力buildと両方式の出力→入力playは維持した。型付きFnOnce helperで失敗方向を保持し、生成済みstreamと未実行closureを返却前に破棄。receiver保持中にDevices→共通cleanup→次試行の順を守る。既存vendorのstartup rollback・retry予算・rate／有効buffer・gain／mute・RT処理は変えない。lifecycle対象20tests成功、独立read-only reviewは追加P1/P2なしでPASS。core.rs SHA256 `116B5D5C788ED2F7E6BF1F12E770769A935C528FACEDB00DB6E09A7CECB4AE73`、lifecycle.rs `B0139AB692DE7B4099B8D5E35EACE6F391CC77892CF32D5288F4D36674BDBB1A`。全体検証と固定binaryでの実比較はこれから行う。

候補のall-target check／strict Clippyも成功。第15回cache整理は古い45snapshot削除・最新796保持、実回収1,049,219,072bytes、空き943,587,328→1,992,806,400bytes、manifest退避済み。世代整理の累計1,046snapshot／29,341,233,152bytes。それでも親全体testはstatic archive生成時にOS112でコンパイル失敗し、テスト失敗とは区別した。

世代整理だけでは、過去の複数条件で作られた同packageのdev生成物が残るため、`cargo clean --package vst-host --profile dev --dry-run -v`の全pathを先に確認。絶対path76,250件はすべてtarget/debug内で、同packageのfingerprint／build／incrementalだけだった。独立read-only範囲reviewもPASS。他package・release・source／vendor・.git原本・target直下の比較用binary／private報告は対象外と確認した。

compiler／Host／engine不在で、明示target-dir付きの同package dev cleanを実施。実結果は27,752files／46.5GiBというCargo表示、実空き1,395,052,544→46,450,458,624bytes、実回収45,055,406,080bytes。dry-runの重複を含む列挙／論理総量115GiBとは区別し、開始時からの正味減少とも呼ばない。全Rustを同じsource／SDK環境・直列-j1で再試行中。

容量確保後の全Rust再試行は300lib＋関連統合で成功（コンパイル3m32s）。OTT module lifetimeは明示指定1件ignored、直前poll版で成功したrepro_ottは今回は再実行していない。engine明示buildも1m40sで成功し、固定SHA256 `0F0844BBD0A0FA39CFB2105FCA3A5B38BA1C7011776EFC485D64F87018E98F5A`をtarget直下へ保存した。比較元はpoll修正版の出力先行engine `1EE96318348013377BF9B1FC5269CA2D530AE62BB3C9CF7139A76EF179235255`。

compiler／Host／engine不在から、出力先行ASIO96k／512のVSTなし・Ozone EQ1、入力先行の同2条件、入力先行WASAPI48k／512の計5条件を順次実行し全PASS。各約2秒、通常出力gain0／peak0／errorsなし、停止seal・旧epoch拒否・再開新epoch・所有子終了を確認した。全条件consumed=matched、pending／unknown／metadata欠落・不正／重複対応0。EQ2条件はserialized state不変。保存音声／OBS／通常セッションへの書込なし。保持履歴のevictionやclock label重複は音声metadata欠落とは別である。

ASIOは両VST条件で出力先行版の保持64segmentすべてoutputSequence−inputSequence=1、同ordinal32組すべてoutput std開始先行。入力先行版は64segmentすべて差0、32組すべてinput std開始先行となり、候補のCPAL labelは64segment全equalだった。baselineのlabelはinputTimestampEarlierであり、両版全equalとはしない。入力arrival→zero-fill前の対応frame読出しbucketは、VSTなしp50が6.2〜6.3→0.8〜0.9ms／p95が8.5〜8.6→1.0〜1.1ms、EQ1はp50が6.1〜6.2→0.8〜0.9ms／p95が8.6〜8.7→1.2〜1.3ms。0.1ms bucketの短い単発累積で、総往復・物理capture／playback周期・音質・長時間改善とはしない。分類unknownUnverifiedClockを維持する。

WASAPI新候補は48kで95,040frame対応、停止／再開成功。今回WASAPIの旧版比較は行っておらず、改善を主張しない。ASIO matchedは旧190,464／190,976、新191,488／191,488。raw最終JSONと集計script／analysisを独立read-only再集計しPASS。private rawはtarget/issue-backlog-input-first-*.log、analysisは同native-analysis.json。#45の今回局所改善は受入とし、実44.1／48k ASIO・128／256実buffer・release／長時間・全信号の未確認は残す。

### 実queue moduleによる周期差・一時停止の機能確認（#47 A）

既存Python FIFOモデルと別に、実`queue_diagnostics.rs`（SHA256 `F60577013414B51050A8E3B6A96B17E20BA8F000D3D8183DBFFD2073473B04D2`）をprivate Rust helperへ直接includeし、HeapRb／push_mapped_frames／read_complete_frames／QueueDiagnosticsを動かした。入力は2ch固定、出力2／22ch、48／96k、512frame固定、両callback順、steady／入力速度±100ppm／入力停止窓／出力停止窓／周期jitterの48条件、各60**仮想秒**。FIFO参照でsource順序・mapping・全frame境界・zero-fillと3つのcounter保存則をassertし全成功。識別用f32マーカーであり、可聴音源や音量ジャンプ検査ではない。22ch入力や、同じR値を複製する出力ch同士の交換検出まで検証していない。

出力停止窓は3.0〜3.25仮想秒。512frame周期と同時刻順に量子化され、正確な250ms遅延とは呼ばない。stereoでは4秒以降も最大age245.333〜256msが残った。96k／22出力chは容量4,363frame＋14slot・drop20,213を再現し、4秒以降最大age42.667〜48ms。実moduleの無補正動作として観測したもので、自動回復の実装・音質保証ではない。

単threadの仮想eventで、resampler／DSP／VST／実機clock／実時間60秒／CPU／RT無割当の証拠ではない。既存release ringbuf／serde artifactを再利用した機能helperで、製品sourceの変更なし。helper／exe／compile log／48rows／module／依存artifact hashをtarget/issue-backlog-queue-controlled-manifest.jsonへ保持。独立read-only reviewで重複なし48条件・全hash・保存則・数値を確認しPASS。StageBの滞留回復・clock補償は引き続き未実装として追跡する。

### #30 配信状態の保存・復元：実装と初回独立レビュー（10月24日、継続中）

Auralynの選択カテゴリと、明示選択した既存OBSソースの音量・ミュート・モニター・既存フィルター有効状態を一組として保存するbackend／UIを実装中。OBSの任意settings・資格情報・URL・新規作成・録画開始停止は含まない。実OBSへの書込みは実施していない。実行前差分・操作固有backup・Auralyn確認後のOBS適用・履歴からのUndoを設け、部分失敗／結果不明は次の適用へ自動archiveしない契約とする。

実値captureは既存engine限定の非RT IPCとし、VST順序・状態・flags・gainおよび現在の制御設定を採取する。複数VSTのopaque stateは同一瞬間のatomic snapshotではない。OBS待機前後でstateが変化する場合は保守的に保存拒否するため、処理中に内部stateが変わるVSTでは保存できない場合がある。この制約を黙って緩めない。

初回backend凍結時はbundle11tests、all-target check／strict Clippy成功。OBS関連46testsのうち、agentでは既存loopback handshake取消試験1件がlistener待機で失敗した。親は同じsource・timeoutのままSDKとworkspace TEMP/TMPを明示して当該exact testを再実行し成功（compile23.65秒、test0.00秒）。環境差を記録し、最終全体検証で再確認する。UI関連38testsとTypeScriptは成功したが、個別のAuralyn差分表示などは追加中。

14backendファイルのhashを固定した独立read-onlyレビューはFAIL。再起動の最初のcallback前にgain等が反映されない経路、未選択全体bypassのリセット、保存カテゴリとpayloadの不整合、UndoのHost lock内再検証不足、Undo途中失敗で旧completeが残ること、OBSのawait後の失効再検証不足、応答のopaque state混入を確認した。writerへ一括修正を依頼した。レビュー通過・最終統合検証・実画面確認前であり、#30の優先1を完了扱いにしない。優先2の声解析提案、専用Stream Deck対応は未実装。

### #33 Soundblasterの読み取り専用確認（10月24日）

指定名の出力を一意に確認してCoreAudio getterのみで照会した。endpointはactive、ミュートOFF、master／channel音量は約12%。既存4sessionはミュートOFF・音量1、短時間のidle meterは0だった。再生・録音・stream開始・音量変更はしていない。既存sessionの値は将来の試聴sessionを保証せず、idle値0から故障や可聴性を判定しない。利用者が前の短い試験音を確認できなかった事実は変わらず、聴感は未確認。

読み取りhelperはSDK headerからvtableを限定照合し、実行前の独立reviewもPASS。証拠はtarget/issue-backlog-endpoint-readonly.json。#66の実200%DPI・実キー・Narratorは利用者の指定どおり後日の手動確認とし、追加の操作権限やCSS拡大で代替しない。

### #47 段階Bの実装境界の整理（未実装）

read-only調査で、固定rubato0.14.1のFftFixedInは比率変更をSyncNotAdjustableとして拒否し、SincFixedInは相対比変更とrampに対応することをlocal依存sourceで確認。共通ASIOの通常passthroughを維持し、独立／不明clockの補正を別の非同期変換経路にする必要がある。pause由来の大きい滞留は微小ppm補正と分け、consumer所有・完全frame・最終送出のfade・回復破棄専用counter・対応frame観測の失効が必要になる。

target／highwaterを処理容量65,536や単なるring容量から決めない。96k／22出力chの容量4,363frameでは可変Default callbackとburstの余裕が成立しない場合があり、固定確保上限と実callbackでの有効判定を分離する。10ms fade／100ms継続／500ms再発防止／±500ppm等は比較用候補に留め、採用値や音質保証ではない。製品の回復／可変比変換はまだ追加していない。

#30の先行StartIntentレビューは再度FAIL。setterをStart前に並べる案では、各ensure付き送信の間にchildが終了すると別engineへ再起動して前のACK値を失う。またfresh engineのSetInputChannelsはhost／ch確定前の既定stereo条件でASIO任意chを補正するため、成功ACKだけでは初callbackのchを保証できなかった。凍結5files＋adapter copyの開始終了hashは一致、実機では未実行。typed初期intentをStart自体へまとめ、機器条件確定後・callback構築前に反映する修正へ進める。

### #69 翻訳前に分離する制御契約（read-only追加調査）

単なる文言置換では動作が変わる現経路を特定した。OBS履歴の「適用済み」完全一致はbundleのcompleteと同期調整の採用条件に使われるため、applied/restored/conflict/unknown等のtyped statusを先に分離する。音声復旧はStream Error本文、VST editor復元はPlugin not found／旧loaded_count=0本文、保存原本の説明重複回避は「保護中」、bundleのARIA通知種別は「保存しました」に依存している。cancel/cancelledも固定取消トークンとして扱い、自由文翻訳と混ぜない。

PluginBrowserの日本語カテゴリはMap／選択値にも兼用されるため、dynamics／eqFilter等の安定IDへ移す。OBS接続の生エラー解析は固定の失敗分類へ寄せ、資格情報を含む原文の直接表示・翻訳を導入しない。OBS実ソース名「Auralyn マイク」、ユーザー指定名、device／scene／filter／collection名、VB-CABLEのInput／Outputは実体の識別子として保持する。LiveModeとbundle差分状態は既に型付き値であり表示だけを翻訳できる。既存日本語アクセシブル名のUIテストは維持し、英語の主要導線で同じ副作用を確認する。現段階は調査のみで、英語対応はまだ完了していない。

### #30 Start同梱・全体凍結後の検証（継続）

再修正では旧Start JSONとの互換を持つoptional initial_controlsを同梱し、bundle restartのensureを一度に限定した。同engine世代の既存接続へStartを送信し、実host/ch条件で入力を正規化してcallback構築前にgain/mute/bypassを保持する。scope18tests、all-target check／strict Clippyが成功。初回の実ASIOch fixture誤り1件とClippy記法警告1件は修正後再成功した。Undo／OBS失効回帰はproductionの再検証関数を通すdeferred mockであり、外部RPC・実Host mutex競合の結合試験ではない。

29filesをmanifest/hashで凍結し、親も一致を確認。Auralyn個別diffとOBS実filter一覧選択を含む親全UIは73files／548tests成功、親TypeScriptも成功。writerの関連6files／41tests・Vite成功を区別して保持する。親全Rustは実行中。backendとUIの独立再レビューも並行中で、まだ最終受入ではない。証拠はtarget/issue-backlog-bundle-final-manifest.jsonとissue-backlog-bundle-root-full-ui.log／root-tsc.log／root-full-rust.log。

凍結版の親全Rustは318lib＋関連integration／queue／maintenance／MSIX／OTT editor（7.75秒）／doc testで成功、OTT moduleの明示指定1件はignored。全テスト成功後も独立レビューはFAILだった。UIは初期一覧とpreviewの世代共有およびWindows大小文字違いによる上書き確認迂回、既存OBS filter名trimによる別対象選択、source名constructor等がprototypeを拾うMap lookupの3件。backendはcapture後child終了→statsの既存接続回収→選択setterが再spawn→新世代を成功基準にする1件。旧P1／6指摘は解消を確認したが、この4件の修正へ進む。終了済childをstatsがspawnするとの初期説明は訂正済みで、実際のspawn経路は後続setterである。

修正方針は、bundle同期適用区間の既存接続・同世代scope（明示Start以外は交代拒否）、backend保存先の存在確認とoverwrite明示、一覧準備完了の待機と独立世代、既存名のexact送信、prototypeを持たないMap。実機QAは修正・再レビュー後まで行わない。

### #69 言語store／Provider基盤（未統合）

src/i18nへ明示ja/enのstore、LocaleProvider、型付きcatalogを追加した。保存不能でも当回表示を切り替えて失敗をcallerへ返し、設定移行後refreshとdocument.lang同期を提供する。子の再mount／音声・録音への依存を持たない。6testsとTypeScript成功、独立read-only reviewも重大指摘なしでPASS。#30の凍結29filesは変更していない。現時点のcatalogは基盤8keyだけでmain／設定への統合もまだなく、英語UI対応の完了ではない。

### #30 実Tauri保存・復元試験と未選択設定の永続化（継続）

最後のrestore scope修正は対象回帰・check／strict Clippy成功、独立再レビューPASS。直前版の親全Rust320lib＋全関連統合は成功し、最終1境界の修正は対象検証と明示bins build（1m42s）で確認した。固定Host SHA256 44C0D62D46C97953E3847066D55EEB47F7F21768E8037F9B55AC3DB8540AC274、engine E0AB109B07E22F701880682AA0CD4EDC35124399C91116FEB033CE1B66801B4A。

初回実機は検証helperの不具合でFAIL。かんたん表示で管理buttonがなく、CLIのError文字列を例外にしないため後続へ進んだ。製品のsave／direct previewは成功したがUI適用の証明ではない。Error即停止、必要時のVST詳細切替、その表示設定原文の退避・復元を追加し独立reviewPASS後に再試行した。自作QA1fileのみname／revision／実path照合で削除し、初回証拠は別名保持。

2回目は所有Host78900、900×600／DPR1、停止中NRカテゴリのみで、実UIの個別diff→Apply→Undoが成功。VST2本を維持し音声は停止のまま、Undo後NRは適用直前値へ戻った。画像の実表示とスクロール領域（client356／全体1236px）を確認。実OBS操作・試験音送出なし。

ただし全体QAはFAIL。SESSION原文と保存保護は維持されたが、未選択Audio設定のlocalStorage原文が変わった。原因はcurrent DTOに全control値が含まれ、hookが実ラック同期と同時に未選択の全controlをsyncLocalStateFromProfileへ渡すこと。currentをラック専用へ限定し、確認済み選択summaryだけを永続化する修正へ進める。部分成功を全面受入にしない。

2回目終了時にはSESSION／Audio／inputGain／beginnerMode原文の一致、outputGain100・NR元値、Host／子の終了を確認した。自作NR-only bundleと完了済みUndo backupの2fileはname／revision／所有operation ID／厳密pathを照合して削除。証拠report／preview／undone／failure画像はsecond名で保持し、ユーザーのpreset／bundleは削除していない。

### #30 停止中NR-onlyの局所受入（実Native最終PASS）

current DTOをラック専用へ限定し、control同期をcomplete＋summaryの選択済みカテゴリだけへ変更。関連UI28tests、Rust DTO1test、check／strict Clippy／tsc／Vite、backend／UI独立再レビューがPASS。親全UIは英語基盤6testsを含む74files／562tests成功。更新Host-only build1m04s、SHA256 B1CFC3150857A961A391EB942E7458FF028DDB0F006D1928D31C5BE52A602AB7。engineはcore／IPC未変更の固定E0AB109B…を照合して使用。

所有Host63132の3回目実試験は全体PASS。元audio intent ASIO96k／512／入力6・7を確認し、停止中NR-only save→実UI差分→Apply→Undoが完了。2VSTのID・順序を維持し、SESSION／Audio／inputGain原文と保存保護を保全。finallyでoutputGain100・NR元値・表示設定原文・protection nullを読み戻し、全Host／engine不在とimmutable原本C90B35B0…不変を親が確認した。900×600／DPR1の差分・復元画像を実表示確認。

最終自作bundle／完了済みbackup2fileは厳密path／name／revision／所有operation IDで照合し削除。target/issue-backlog-bundle-native-manifest.jsonにfixed binaries／source manifest／helper／report／PNG hashを保持。独立read-only evidence auditもPASS。これは停止中NRカテゴリの局所受入で、実OBS／全カテゴリ／音声品質／OSキー／別DPI／長時間の受入へ広げない。#30の優先2と専用Stream Deckは残る。

### #38 通常起動時の入力ペア適用競合（追加調査）

#30の2回目実機で、停止後のpreviewに入力0・1が現れた一度の観測を別途調べた。通常warmupは入力ペアを含まないActiveAudioConfigで起動し、新規engineの初期ペアは0・1。useAudioConfigの初期状態取得中にaudio-startedが届くと、engineRevision不一致で初期化を終了し、保存済みASIO入力6・7の送信に到達しない経路がある。停止処理とget_audio_state自体によるペア書換えは見つからなかった。コード上の競合は確認したが、一度の実測との因果関係は未確定。

read-only調査では、停止・エラーをstopRevisionで取消し、開始通知で古くなった状態取得だけを最大3回取り直す限定修正を提案。古いfalse応答からStartしない、Start自体を再試行しない、停止後の開始通知で元の初期化を復活させないことを条件とする。#69 writer完了後に直列で修正・検証する。現在は未修正であり、native条件付き開始やStartへの通常入力ペア同梱まで保証する案ではない。

### #69 主要画面の英語対応と失敗境界

明示ja/en・未設定jaのstoreをmainへ統合。初回／設定の言語選択、主要Header／MasterBar／復旧案内とBootstrap／ErrorBoundaryを型付きcatalogへ移行した。翻訳callbackは安定参照で、通知は表示時に文言を解決する。実Wizardの入力・選択・開いたdialogの保持、実VoiceCheck hookの録音／試聴／取消の要求が言語変更で増えないこと、ja/enのRecoveryが同payloadであることを対象テストで確認。

初回UI独立レビューでは、移行失敗画面までThemeProviderの未保護storage操作とnative projectionの書換／削除が始まるP2を確認。失敗時は安全な表示用locale読取と案内だけに限定し、ThemeProvider・native bridge・言語selectorを開始しないよう修正。storage getter／setter拒否でも案内が表示され、native言語commandと保存がゼロである回帰を追加。修正後18製品sourceの独立レビューは開始終了hash一致でPASS。

writerの対象UI11files／114tests、native locale2tests／migration1test、tsc／Vite／all-target check／strict Clippyが成功。private凍結manifestはtarget/issue-backlog-locale-phase1-manifest.json、SHA256 299E16633FB18B748933847466F057C436D6CF510D14E26DFDCC41A8A9603ABC。詳細Settings／OBS／VoiceCheck／Presets／builtin／LiveMode／診断／一部通知／チュートリアルは日本語が残り、#69全体の完了ではない。

native独立レビューでは、旧frontendのbegin処理がblocking poolで遅れると、新sessionを失効させ続けるP2を確認。beginを現在page世代のatomic読取だけへ変更し、mainのPageLoadEvent::Startedでのみ世代を進める修正を親で実施。setはmenu gate取得後に現在pageを照合し、旧setを拒否する。旧begin返信遅延／新pageの連続更新／世代上限のfail-closedを含むnative4tests成功。再レビュー・最終check／Clippy・実webview確認は継続中。

### #38 起動時入力ペアの限定修正と統合UI確認

writerの製品source凍結・handoff後、親がuseAudioConfigの状態取得だけを最大3回取り直す修正を実装。Startはretry loop外で一度だけ送る。stopRevisionは試行全体を取り消し、開始通知が後から届いても旧初期化を復活させない。3回とも不安定なら古い結果を採用せず、診断ログを残して初期化表示を解除する。

起動対象21tests（既存7＋追加14）、TypeScript成功。#69との統合全UIは77files／592tests、17.98秒で成功。独立レビューも対象2sourceの開始終了hash一致でPASS。証拠target/issue-backlog-startup-pair-tests.log／startup-pair-tsc.log／locale-startup-root-ui.log。native通知がまだfrontendへ届いていない競合と、通常Startへの入力ペア同梱までは保証しない。元の一度の実測との因果関係、実機での修正後再確認は未確定。

### #69 実画面の切替・reloadと #38 ラック重複の発見

native page fenceの再レビューはPASS。言語selectorには実際の同期応答が返るまでaria-busyを公開し、最新要求だけで完了／失敗を確定する処理を追加。対象3tests・UI独立レビュー成功。更新版の全UI78files／595tests（15.81秒）、tsc／Vite、全Rust326lib＋関連integration／OTT editor（7.56秒）が成功。OTT module試験1件は従来どおりignored。fmt確認で今回所有3filesの整形漏れを修正しfmt成功、通常Host＋engine build1m02s成功。書式だけの後続差分に全Rustを重ねてはいない。

最初の実画面試験はVite停止によりHTML未到達でFAIL。2回目は検証用observerがTauriの非writableなinvokeを差替えられると仮定して待機に失敗し、observerを除去した。前提確認を追加した次の試行は、HTTP拒否をHost起動前に検出した。Vite終了の原因は、workspace直下targetへ置いたRust TEMP内のlink一時ファイルを監視したEBUSYとログで確認。検証専用Viteでtarget／src-tauriを監視対象から除外し、今後のテストTEMPもsrc-tauri/target配下へ置く。製品Vite設定は変更していない。

実Host4788の900×600／DPR1では、同じ設定dialogを保った英語切替、native projection保存、reload後の英語保持、page epoch2→3、旧page要求の拒否、日本語への切替完了を確認。親も英語の画像を実表示確認した。詳細本文が日本語のままであることを画面にも案内するphase1の証拠で、実trayのOS表示・実キー・Narrator・200%DPIの確認ではない。

ただし全体probeはFAIL。同じHostでのreload後、実ラックが2VSTから4VSTへ増えた。初期usePluginsは毎ページ空UIから保存SESSIONを既存ラック照会なしで追加し、追加した2本だけをUIに渡す。保護フラグは保存防止であり追加復元を禁止しないため、この重複を防げなかった。現在は既存ラックのmetadata-only照会／実IDのUI引継ぎと、空ラック復元の世代・順序CASを別修正として実装中。言語切替部分の成功で全面受入にしない。

失敗時finallyでSESSION／保護／outputGain／Audio／inputGain／beginnerMode／localeの原文7件がすべて一致し、native projectionも原文復元、Host終了を確認。親は全Host／engine不在、immutable原本C90B35B0…不変を確認し、専用Viteも終了した。通常Host0581482576C2D4914B0D3EE6D20FB8FB2D07C62EA743E2953E678DCB89740065、engine80D4D358FDB6C9A18F2E715F7F89C4B1A02E25A935008B932E7C01462F24FE2F、34source snapshotとhelper／report／PNGをbefore-rack名で固定。evidence manifestはtarget/issue-backlog-locale-before-rack-evidence-manifest.json、SHA256 81C054958D0EA9E30CEFB1556D458F5076EE10D8339410F8DE4C109A1B959D8B。生VST stateの回復用コピーは.git内だけに保持し、公開しない。

独立した証拠・原本保全監査は、証拠7件とsnapshot34sourceのhash一致、2→4で失敗する経路、言語切替の限定成功、LS／projection復元、opaque state非出力を確認してPASS。これは保全監査の判定であり、製品probeのFAILを変更しない。追加調査で、同一マウントのStrictMode保護だけでは実reloadを防げず、非空実ラックのhydrationを保存JSONの解析・gain復元より先に行う必要を確認した。

### #38 ラック引継ぎの実装中レビュー

metadata-onlyの実ID／順序照会と、Host世代・復元token・Engine公開前の照合を追加中。既存の実ラックは保存JSONの解析や音量復元より先に表示し、保存済み原本との一致を推測しない。実unmount／remount、同じpathの別instance、壊れた保存JSON、保護中の自動／手動保存、遅延照会、StrictMode、明示retryの回帰確認を準備している。まだ凍結後の受入ではない。

途中の独立nativeレビューでP2を1件確認した。Begin後、別の通常Load→最後のUnloadでラックが再び空になると、ID配列だけの照合は途中の変更を見逃す。利用者が空にしたラックへ古い復元処理が再追加するため、単調な構成世代などによる追加前／STA完了前の照合を修正対象とした。未知／Busyを空扱いしないこと、古いFinishで新tokenを解除しないこと、生stateを照会DTOへ含めないことは途中版で確認できたが、最終レビューは修正後に行う。

単調rack revisionをSnapshot→Begin→Add entry→STA commit→Finishへ通し、通常Load／Unload／Reorder／Restoreでも進める修正後、native対象9tests・all-target check・strict Clippy・対象fmtが成功。初回の稼働中・未変更・空ラックだけに保存inputGainを反映し、停止中／不在へgain setterのためのspawnは行わない。native10filesの独立再レビューはPASS、前回ABA指摘の解消と新規P1／P2なしを確認。manifest SHA256は488447698CFD4BD39A1CF7EC07ACD61A37ED8F3C594D3566FDE32B7F351404AF、開始終了とも全10files一致。全Rustと実機QAはまだ別途必要。

UI側の最初の統合確認は79files／612tests中、78files／601成功・MigrationRestartの旧API mock11件失敗。独立UIレビューも空savedのretain待機中に保存原文が変わる場合と、手動復旧の後続Start失敗前に保護解除するP2でFAILとなった。空成功経路も原文照合・手動復旧の全成功ガードへ合流させ、旧mockと回帰テストを修正中。途中の対象テスト成功を最終受入へ広げない。

空retainの原文照合・手動復旧ガードと2回帰、MigrationRestart11件の新API mockを修正後、独立UI再レビューPASS。親の全UI79files／614tests、全Rust335lib＋関連integration／OTT editor7.53秒が成功、OTT module1件はignored。TypeScript／Vite／全fmt／diffcheckも成功。Viteのmain chunk501.38kBは500kB超のadvisoryが残る。通常Host＋engine build1m28s成功後、249製品入力をhash固定した。

次の実Host18444では、同dialogの英語切替とpage epoch2→3／旧要求拒否までは成功したが、reload直後に停止済みstreamが再開して全体FAIL。強制stopで検証結果を隠さず、停止維持assertで検出し、画像でもASIO running／出力gain0を確認した。useAudioConfig初期化がstreamRunning=falseで常にStartへ進む既存経路を調査・修正対象とする。ラック重複・不正JSONの後続assertへは到達しておらず、その成功は未確認。

finallyでSESSION／保護／outputGain／Audio／inputGain／beginnerMode／locale／SESSION_BACKUPの原文8項目すべて一致、native projection原文復元、Host終了を確認。親も全Host／engine不在、immutable原本C90B35B0…不変を確認し、専用Viteを終了した。Host F596BD16D71A4591581179ABC88CEF2005488BC560D39F1858002E7DAA229400、engine B20816076E3904101A6A1DDE93C5FA6B95A4D304E0ECEB7D4D2FF261578C0EFDと249source snapshot／helper／report／画像をbefore-stopped-fix名で保持。原本回復用データは.git内に限定し、生stateを公開していない。

独立証拠・保全監査はPASS。manifest SHA A64236744788F359292C3FEA25F3A71E25A42A8ECCB821DC1FAEDB590B562626、凍結249sourceと両binary、run／reportの一致と保全ガードを確認した。生statusをこの試行では記録していないためreport単独でrunning／gainどちらの条件が失敗したかは分離できず、runningの判断には今回画像を併用する。次のhelperは安全なrunning／gainの2値も記録する。製品probeのFAILは変更しない。

read-only追加調査では、child存在時の停止だけでなく、同Hostの停止回収／crashでchild不在になった状態も真coldと区別できないことを確認。初回frontend用の単一bootstrap要求をHost寿命の一度だけ許可し、warmupと同じmutexで調停する修正へ進める。同Hostのreloadは現在状態へのattachのみ、保存pair／gainとStartの再適用を行わない。通常Start／Stop／復旧が先なら初回権限を失効させ、bootstrapが先なら後続Stopを最後に適用する。初回warmup成功時の保存pair適用、warmup失敗後の手動開始、native設定なしの真cold fallbackを区別して検証する。

### #38 停止後reloadと初回自動起動の分離

単一audio_frontend_bootstrapをHost寿命で一度だけ実行し、先行warmupと初回frontendの起動を同じmutexで調停する。同Hostのreloadは無操作attachに限定。通常Start／Stop／gain・入力pair操作／復旧予約が先なら初回権限を失効させる。先行session初期gainとinitializeの実ACKは再利用し、古いbootstrap値で再送しない。sessionの初回認識もHost寿命で保持し、child退役後の自動復元を防ぎつつ、移行確認後や明示restart／復旧／retryの保存chain復元を許可する。

途中の独立nativeレビューで、warmupのspawn／初期化失敗だけがfrontendで再試行されるP2を確認。全warmup失敗で自動権限を失効させ、初回へ固定のinactive／手動開始案内を返すよう修正した。新規9境界testsと既存session9tests、all-target check／strict Clippy／対象fmtが成功。native7filesの最終独立レビューはPASS、manifest063680A20F98AE50AC0B73999032372C679397CF42464E49AB26992013CAD0C7の開始終了hashが全件一致。

MasterBarのmount／reload状態取得はread-onlyとし、engine既定gainを保存値へ公開しない。稼働中hotkeyは新しい明示要求通知と世代付き観測でtarget／revision／settledを確認してから保存する。slider入力直後〜30ms debounce前の旧hotkey応答が表示とLSを戻すP2も、入力時点のintent失効と実MasterBar連携のdeferred回帰で修正した。最終独立UIレビューは製品6source＋関連3testsの開始終了hash一致でPASS。

親の修正後全UI80files／629tests（18.20秒）、全Rust344lib＋関連integration／OTT editor7.54秒が成功。OTT module1件は従来どおりignored。TypeScript／Vite／全fmt／diffcheckも成功、Vite main chunk502.62kBのadvisoryとcache hardlink→copyの環境警告を区別して保持する。17filesの最終manifest SHA256は6CCE9CC5676BABFEE28537716603D2F0BF4A010D3EF7B35559144D08A554F535。通常bins再生成後に実Hostを再確認する段階で、実機合格はまだ未確認。

cold fallbackはStartControlsを同梱するが、先行warmup成功には初回frontendから後付けする。全cold起動の最初callbackから保存pair／gainが反映される保証ではない。実hotkey登録、聴感、物理遅延、長時間、DPI／Narratorもこの自動検証では確認していない。

### #38 修正後の実Host reload確認（局所PASS）

通常Host＋engineを1m24sで生成し、252製品入力をhash固定。Host82396、900×600／DPR1で同じ設定dialogを保った英語切替、page epoch2→3／旧page要求拒否、日本語切替が成功。reload直後の生statusはrunning=false／gain=0。前後のengine世代1と2VSTの実ID・順序・全metadataが一致し、再読み込みによる追加はなかった。

保存SESSIONを検証用の壊れたJSONへ一時置換して再度reloadした場合も、同じ実ラックを引継ぎ、壊れた原文と保護キーを保持、停止／gain0を維持した。最後にSESSION／保護／outputGain／Audio／inputGain／beginnerMode／locale／SESSION_BACKUPの原文8項目すべて一致、native projection原文復元、Host終了を確認。親も全Host／engine不在、immutable原本C90B35B0…不変を確認し、専用Viteを終了。英語／日本語設定と引継ぎ案内の画像3枚を実表示確認した。音声環境は停止したままで、元の稼働streamを再開したとの報告ではない。

Host438772232771B805E6EF8BEBCEDD4940E82E4446D7D3473683420221D0A75CE3、engine8A9CDC983D992F9BF8153611379398840725A93BF44B2F4EB5B2B1C7853593A3と252source snapshot、helper／report／画像を固定。helperが読むAST transport・保護JS・入力manifestの3依存も対応表付きで凍結した。evidence13filesのmanifestはtarget/issue-backlog-stopped-reload-native-evidence-manifest.json、SHA256 8F33F40822B4B97CB8C75E001847C7BE0BB231E367788C68E1BCCA08FEFE5E53。独立の証拠・保全監査はPASS。13証拠と252sourceのhash一致、3画像と判定条件、ASTの6transport関数のみ実行する境界、所有PID／engine実pathによる回収、原文復元・生state非出力を確認した。

この合格は停止中reload・実ラック引継ぎ・原文保護・主要言語導線の局所条件に限る。#38全体、全cold初回callback、実hotkey、長時間・音質、#69全画面やOS読み上げの合格へ広げない。次の高優先#47段階Bは、既存48制御条件を使い過剰滞留の回復policyを比較する。ASRCは別sliceで、観測追加や回復だけでclock差補正まで完了としない。

### #47 有限回復policyの比較と統合レビュー中

実HeapRbと製品push/read helper、参照FIFOを使う単一threadの比較で、48条件×3policy、各60仮想秒の144条件がframe・チャンネル順序・保存則を満たした。512frame、48/96kHz、2/22出力chの範囲で、T=1B/H=3Bは容量非対応0、output pause8条件で各1回回復、他40条件の不要回復0。pause後4秒の最大音声ageはbaseline42.67～256msから0～10.67msへ減少した。T=2B/H=4Bは48kHz/22chで容量不足となり、対応条件だけを抜き出して全条件の結果と混同しない。比較manifestと依存rlib・helper・実結果を固定し、独立監査はこのモデル範囲で限定PASS。

通常マイク最終出力だけへ約10msの独立fadeを適用し、ゼロ境界で完全frameを除去する実装を統合中。1開始試行最大1回、再超過・容量不足を診断し、producer満杯破棄とは別計数にする。skip前のframe対応失効と、次Startまで時間分位を復活させない境界も含む。ASRC、独立clock補正、実機CPU、可聴品質、長時間挙動は未確認。

独立レビューでは、回復途中に開始したloudness測定へのfade混入と、旧Engineのqueue DTOに新回復fieldがない場合のdeserialize失敗をP2として確認。測定要求は最新1件だけ保持し、unityへ復帰した次blockで新規積分するよう修正した。取消・置換と実LoudnessMeterの無割当回帰を追加。新fieldはOption＋serde(default)、UIも欠落／nullを未取得として扱い、既存統計を維持する。旧説明も有限回復とASRCを区別する表現へ修正した。録音tapは送出fade前なので、回復途中から始めた録音と実送出の完全一致は保証しない。

凍結後のnative・UI独立再レビューは両方PASS、新規P1／P2なし。10filesの最終manifest SHA256は774EBC026610C0D614521996BBB6FEFBE9032B0A422FDDF91CB4B801312860F9で親も全hash一致を確認。対象Rust回復9／queue7／frame timing20、all-target check／strict Clippy／対象fmt、UI6tests成功。親の全UI80files／632tests（16.44秒）、TypeScript／Viteも成功。Vite main chunk503.53kBはadvisoryとして残る。全Rust・通常bin・実機の短時間定常比較は継続中で、まだ実機受入済みとしない。

親の全Rustは352lib（5.22秒）＋関連integration／OTT editor（7.55秒）が成功、OTT module1件はignored。通常Host＋engineを2m04sで再生成し、253製品入力snapshotを固定。source manifest SHA256は70FAF21375785E9819A73C3A009F7E35C94B85A92ECBDA3D4455CBC84B305F57、Hostは3C629476690690DC095EB291AA3D0A4E81D3311507F2C0C48A6DC481E1D9824F、engineは655C8AA69F256A097D6C92D858B7599381E1CF794A681702CC51AD0BAC0F5D66。

#38修正後の固定engineをbaselineとし、新旧各1回のASIO96kHz／22chとWASAPI48kHz／2chを、各約8秒・gain0・VSTなし・強制pauseなしで直列観測した。4runとも停止後の保存則・出力peak0・Engine Errorなし・所有child終了が成功。新Engineの回復破棄0・status0、producer満杯破棄は新旧とも0。ASIOの読出しcallbackは旧1499／新1497、最大観測音声量は両方5.33ms相当。WASAPIは旧802／新800、最大観測音声量は両方20ms相当。不足callbackは旧ASIO1／WASAPI3、新ASIO0／WASAPI5で、起動直後も含む内部読出し不足の数であり、可聴音切れや性能優劣とはしない。旧Engineに新回復fieldがないことも未取得として記録し、0回復の実測値へ変換しない。

元のVST保全原本C90B35B0…不変、全Host／engine不在を親で再確認。保存設定へ書き込むHostは起動しておらず、元のaudio streamは再開していない。実行時のレビュー文書2件も別原文コピーで固定した。証拠19filesのmanifestはtarget/issue-backlog-queue-recovery-native-evidence-manifest.json、SHA256 85F660065EBC4331049FAAD92ADEA719BE3E2BF2AF46D122CD031317FFC62AB5。独立保全監査は19証拠・candidate253入力・baseline252入力・固定両engine・保全原本のhash一致、停止保存則・未取得の維持を確認して限定PASS。実機での回復発火、音質、release成果物、clock差・長時間は未確認。次は本番処理を置換する前に固定Sincと現FFTを比較し、可変比の品質・処理負荷・無割当条件を判断する。

### #47 可変比候補の前提となる固定Sinc比較（製品変更なし）

固定rubato0.14.1 release artifact、製品resampling wrapperのsnapshot、実FFT／Sincを使うprivate helperを作成。48→48、96→96、44.1↔48、48↔96kHz、2／22ch、既存wrapper・FFT1024／512・Sinc1024／512の60条件を比較した。Sincは128tap／cutoff.95／oversampling128／Cubic／BlackmanHarris2の暫定1候補であり、最適化や採用済み係数ではない。依存の完全なhermetic再ビルドではなく、固定直接rlib・fingerprint・sourceのprovenance範囲をmanifestへ記録した。

数値60・heap60・計時60条件は成功。親もrawを読み、impulse／tone全有限、逆相pair誤差0、process／reset／ratio更新＋processの割当・解放全0、allocator自己校正2alloc／2free／live0／peak8192を確認した。公開resetを持つ52条件はfreshと一致。Sincの±100／500ppmのsetter成功は確認したが、queue制御器・速度差補正の収束は未実装・未確認。選択rlibはlog featureなしで定常traceがcompile時除外される条件であり、任意の製品log設定でのRT安全保証ではない。

単一process、64callback warmup後に3trial×64callback、非追跡System allocatorで探索計時した。1024chunkにはemitなしcallbackが混ざるため、p50単独でなく192callbackの合計ns／合計入力frameを比較する。22chの44.1→48kHzは既存119.78／Sinc1024 840.34ns、48→44.1kHzは108.57／718.62ns、48→96kHzは159.68／1548.90ns。同率の既存はpassthroughなので変換経路との負荷差を比率で強調しない。構築時要求heapの48→96kHz／22chは既存725518／Sinc635566bytesで、RSSではない。phase外で確保済みのbufferがあるため、process等のlive値は保持量として使わずalloc／free0の確認に限定する。

Sinc通過帯域のRMS比は0.999515～1.000008、downsampleの単一alias probe最大比はSinc4.77e-5／FFT7.83e-8。全stopband sweepや聴感保証ではない。impulseの出力配列内index対応と、入力chunk待ち・先読み・実送出遅延を分ける。これらの探索値から本番同ASIO passthroughの置換・Sinc既定ONを採用せず、現行経路を維持する。私的16filesのmanifestはtarget/issue-backlog-asrc-compare-manifest.json、SHA256 9BAE76DDA877F94F4F188F229B94152E135EA4D7C168F234853FB5568601B0DE。独立した測定実装・証拠監査は限定PASS、全hash・集計式・reset／割当の分離・結論境界を確認。3trialは同じRunnerを再構築しない連続192callbackの3区間で、独立試行ではない。p50／trial medianはupper median。100ns量子化下の0ns中央値は無コストの証明ではない。ratio変更後の波形品質、物理遅延、実歌唱、補正OFF／ON、独立clock長時間、本番CPU期限は残る。

### #69 詳細音声設定の英語化（phase2）

AudioSettings配下の機器・入力ch・NR・歌／残響・Live mode・OBS方式／接続・ショートカット・移行／更新へ438項目を追加し、日英catalogは各612キーとなった。画面内通知はkey＋argsで遅延解決し、localeを制御Effectの依存へ加えない。機器／VST／利用者の実名、保存ID、OBS実source「Auralyn マイク」、既存の判断用tokenは保持する。外部hookのuseSingingDraft／useLiveModesのclient error、LatencyDetails、OBS接続理由helper、backend理由・OBS履歴、詳細ガイド・VoiceCheck等は未翻訳が残る。#69全体の完了ではない。

製品15files manifest SHA256は6447089D73FE2F59A7F91CA20C2DBEEAA631AA9D3B7BA4FE08692D228DD33E75。対象105tests、TypeScript、diffcheck成功。独立レビューはplaceholder一致、保存token／effect／tab・draft寿命を確認してPASS。親の全UI81files／640tests（17.69秒）、tsc／Vite成功。main chunk572.24kBはadvisoryとして残す。native source61入力は#47通常bin生成時から全hash不変なので、同Host3C629476…／engine655C8AA6…と最新Viteを使用した。

最初の実画面probe Host4396は、試験側の日本語OBSタブ名の比較誤りでFAIL。さらに単独で返したOBS設定原文をCLIがJSON objectへ解釈し、文字列分割によるcleanupが途中で失敗した。初回script／report／画像／入力manifestの5件を別名固定し、成功扱いにしない。試験を同じtab要素の選択状態へ変更し、原文はobjectに包んで取得、全値型を復元前に検証するよう修正した。元の8原文は初回のprivate回復用コピーを引継いだ。OBS値は初回objectと意味一致し、保存／接続操作は行っていない。

修正Host4976、900×600／DPR1で、未保存の入出力プリセット名とOBS hostを日英往復して保持し、同じdialog／input／OBS tab、2VSTの実ID・順序・全metadata、停止gain0を維持した。OBS保存値不変、9原文のcleanup時一致、native projection復元・Host終了も成功。親は英語Audio・英語OBS・日本語OBSの3画像を実表示確認した。表示外の入力値保持はDOM判定であり、画像に全項目が見えるとの主張ではない。

ただしHost終了後に同一originのReactなし確認ページで読むと、保護キー1件だけが元の値と不一致だった。他8原文は一致していた。確認ページで9原文を再設定してHost41536を終了し、次のHost18616ではlocalStorageへ書かず全9原文の保持を確認した。原文比較はobject内のstringで行い、privateなVST state・OBS認証情報を出力しない。この確認ページもnative warmup自体は残るため、音声を一切開始しない試験とはしない。全Host／engine／1420の所有server終了、projection原文一致、保全原本C90B35B0…不変を確認した。これはHost寿命を跨ぐ確認で、突然の電源断に対する永続性保証ではない。

259製品入力snapshot、runtime helper／依存3件対応表、初回FAILと修正PASS・原文保持proof、画像・root検証log・固定通常binを保持。22証拠manifestはtarget/issue-backlog-settings-native-evidence-manifest.json、SHA256 E000DAA395CDE7465D1F17F90A2952E86CF7DCF0E1C8DE804E99D689FBC16D2C。private回復用2ファイルは.git内のhash参照のみで複製しない。最終保全監査は22証拠・source259・翻訳15入力・native61入力・private2件のhash一致と、canonical4976を基準とする9原文保持を確認して限定PASS。最初のOBS backupはobject化されているため、4396より前のOBS文字列のbyte完全一致を遡って証明したものではない。DPI／Narratorは利用者の指定どおり後日手動、歌唱聴感も未確認のままである。

### #30 録音に基づく内蔵処理の提案（backend・途中レビュー）

封印済みrawの左右別エネルギーと20ms活動窓から、控えめなdynamicsの比較候補を生成するbackendを追加した。HPF80Hz・brightness0・残響OFFは固定初期候補で、個人に最適化した値とは区別する。既存の1worker・保留1件で解析と候補renderを行い、生PCMを書き出さない。候補renderは内蔵処理のみでNR・外部VST・outputGainを含まない。仕様はVOICE_PROPOSALS.md。

提案受付・結果採用・明示適用で原本Arc、録音ID、音声条件revision、Builtin epoch/revisionを確認し、Core同dispatchでwitness照合からCASへ進める。Close先行とApply先行を区別し、成功した設定ACK・RT pending・一世代Undoを後続の提案失効で取り消さない。手動候補の既存契約は維持する。

初回の対象proposal12件、VoiceCheck29件、Builtin2件（重複あり）、all-target check・strict Clippy・対象fmt・diffcheckは成功。ただし独立レビューでP2を1件確認した。HostのPrepareProposalはreader_activeの入口確認後に一般送信経路へ進むため、child終了とreader通知の時間差で新engineを生成し得る。既存接続だけへ送る経路への変更と終了境界の回帰を修正中。初回manifest8ABFC001…は修正前の証拠で、最終受入ではない。

提案画面・英語表示・実IPCの合成信号確認は未実施。本人歌唱の聴感、最適値、長時間性能も未確認であり、#30全体の完了とはしない。

Hostの新PrepareProposalをgeneration固定の既存接続送信へ変更し、送信前後のreader・child終了・世代を確認した。終了済みchild＋reader通知遅延、最初の接続検査後の終了を含むproposal対象14testsが成功。all-target check11.84秒、strict Clippy14.32秒、対象fmt・diffcheckも成功。更新manifest SHA256はB7C51F43565E0915B76E898FFACC4CA2C8831F89AC6BE0AB74912D38F2C97615。凍結後の独立再レビューと親の全Rust検証を実行中であり、画面実装も別途進行中。

凍結backendの独立再レビューは限定PASS。10filesと検証4logsの開始終了hashが一致し、前P2解消と新規P1／P2なしを確認した。親の全Rustは364lib（5.26秒）と関連integration／OTT editor7.62秒が成功、ビルド2m35s。OTT module1件は従来どおりignored。通常Host／engineをこの後で再生成しており、古いbinを最新実装の証拠へ流用しない。

Engine単独の私有実機helperも独立した静的安全確認に合格した。所有するCABLE48kHzの2engineだけを使い、main gain0／muteとsource inputGain0を開始前に指定する。録音ID不一致で候補が失効する契約に合わせ、誤IDの拒否確認後は候補を再作成してから正ID適用へ進む。まだ実行結果ではなく、Host接続競合・UI・可聴性・歌唱品質・長時間の証拠へ広げない。

### #30 提案backendの実Engine確認（局所PASS）

全Rust後に通常Host／engineを1m35sで生成し、127のRust・関連文書・設定・third_party差分入力をbase HEADと共に固定した。Host BE6446980F9E9B8C5C8D1B8E59399B213EDDC925CD861F45EE7DE1AF46655F16、engine 0880ECC196B01FB5E5FBD925B318DBEDFDF30C5448E1A6A3A47BF6683649C210。native source manifest SHA256 A285910AA7F3234742699723B8E0F135B9FA71DBA01CA2B8E4B9E519A9DEFEB8。編集中のfrontendは、このEngine単独試験の凍結対象ではない。

所有するWASAPI CABLE48kHz／512frameの2engine、VSTなしで既知8000Hz信号3段階を録音し、候補ready・明示Apply・RT pending解除とappliedRevision・Undoを確認した。rawは4.81秒／230880frame、左右peak0.0690918、活動窓153/241、活動RMS P10/P50/P90は約−37.01/−31.01/−25.01dBFS、幅12.00029dB。暫定ルールのdynamics0.35、固定HPF80／明るさ0／残響OFF、候補samplePeak0.06929653を確認した。これは単一合成信号の観測で、声・ノイズ識別や設定の最適性の証拠ではない。

誤録音IDのApplyと再録音後の古い提案Applyを拒否し、Builtin revisionを変更しなかった。準備だけで現在configを変更せず、通常出力peak0、engine errorなし、所有child全終了が成功。保存設定・PCMファイルを書かず、物理試聴も開始していない。親は全Host／engine不在とVST回復原本C90B35B0…不変を確認した。Hostの接続競合は前述の非実機回帰で確認した別条件で、このEngine fixtureから実Host競合成功とは主張しない。

helper・AST依存対応・report・各検証log・固定bin等15証拠をtarget/issue-backlog-voice-proposal-native-evidence-manifest.jsonへ固定、SHA256 0066D6D8E7F115D375B9674983547DB2A16B664A985FEC9FC445FF37F6A9E23B。画面実装・英語表示・実HostUI、物理可聴性、本人歌唱の聴感、長時間性能は引き続き別検証である。

### #30 提案画面と #69 VoiceCheck英語表示（凍結後の統合確認）

通常VoiceCheckにも共有modelを渡し、手動入口とは別propで候補を区別した。提案Prepare／内蔵候補A/B／明示Apply／既存CAS Undo、根拠・固定初期候補・限界・折畳み測定値を表示する。提案の適用は未保存manual draftを置換せず、保存ボタンは既存profile画面への移動だけで自動保存しない。既知の助言・提案codeとfrontend通知は日英catalogで解決し、未知code・未翻訳詳細・既存raw制御エラーを分ける。

途中の独立レビューで通常入口のpending固定と、提案Bを手動下書きAの準備済み候補と表示して異なる設定を適用するP2を確認。panelの有限poll、候補種別表示・手動適用ガード、録音時の比較へ明示的に戻る操作で修正した。対象最初75/76の残りはmanual入口の初期mode実退行で、取得effectではなく初期propへ反映して修正し、影響VC45件を再確認、影響外31件も直前run成功として保持する。単一run76件成功とは記さない。

UI10filesのmanifest SHA256は51AAA1D30359E4F1451DF16E341A98A1368D8B6482FA95168392FC9B5CCDC94C。親の全UI82files／652tests（18.50秒）、TypeScript・Vite6.70秒・diffcheckは成功。main chunk603.04kBのadvisoryは残る。263製品差分入力のcombined snapshot/inputmanifest SHA256は7DF804BF8E218887A5773E03FB51445DD2451048689E06F716FFF090B7B6B694。最終独立レビューと実Host画面確認はまだ完了していない。

### #30 実Hostの通常入口と終了後保全（局所PASS）

最終UI10filesの独立レビューはPASS、前述P2とmanual初期mode退行が解消され、開始終了hashが一致した。ja/enのVoiceCheck／proposal184キーとplaceholderも一致。defensiveなproposal.unsealed／proposal.renderFailedや既存raw APIエラーは、未対応code・未翻訳詳細として残り、全nativeエラーの英語化とは主張しない。

実Host33356、900×600／DPR1の通常VoiceCheck入口で、CABLE48kHz／512frameの既知信号を録音し、提案ready・準備前後の現在config不変・同dialogのja→en・UIからの明示Applyと共有Undo・2VSTのmetadata保持を確認した。通常gain0／muteの要求を受理し、物理試聴・OBS書込・PCM保存は行っていない。CABLEへの切替は実Host IPC、言語変更は製品localeStoreの実メソッドによる操作で、Settingsの選択操作は前回の別試験である。これを全設定導線の実UI試験へ広げない。親は日英2画像を実表示確認した。

全9保存原文はcleanup時に一致し、所有source／Host終了後にnativeの言語・音声設定2ファイルを原文復元した。ただし次のReact-free Host79784では保護キーだけが元の値と違ったため、9原文を再設定して終了。続くHost50072ではLSへ書き込まず全9原文の保持を確認した。両Host終了、projection／last_audio_config原文復元、全Host／engine／1420のserver不在、VST回復原本C90B35B0…不変も確認。これはHost寿命を跨ぐ観測で、電源断の永続性保証ではない。proofのnative warmupは短く音声を開始し得るため、無音声起動の証明ではない。

日英画像で理由文に長いf64小数が露出する点が見つかり、その後の表示専用2filesで12.00dB／0.35へ整えた。提案原本・IPC・controller・百分率の意味は変更せず、凍結原本のJA/EN回帰13件と独立レビューが成功。新manifest SHA256 16109B2B0E892A43BCE95B2D5EC8B21C8C4C83B4C92B09DFEE1B73F18038A163。親の修正後全UI82files／653tests（19.83秒）、TypeScript／Vite6.07秒が成功。main603.04kBのadvisoryは残る。実Hostのライフサイクル・画像は数値丸め前、最新2filesは表示回帰の別証拠として区別する。

丸め前263sourceと31証拠、後の表示修正2source、raw9保全proof、helper／AST依存／server、固定bin、段階別検証logを固定した。manifestはtarget/issue-backlog-proposal-host-evidence-manifest.json、SHA256 E60065EC5A0676FC8DD16EBECFDE8FE9ED6CE9B8EB64A0CF0420922F7C04CF58。本人歌唱の聴感・最適値、Soundblasterの可聴性、実DPI／Narrator、実OBS最終品質、長時間性能、専用Stream Deck対応は依然として未確認／未実装であり、#30全体を閉じる段階ではない。

31証拠と263凍結source、旧UI10files／表示修正2files、各bin・依存・段階別logの独立保全監査は限定PASS。丸め前の実Host証拠と、その後の表示修正を明確に区別した。GitHub connectorでopen Issueを再取得した結果も41件のままで、追加対象はなかった。push／PR／closeは行っていない。

### #28 異率の中心referenceモデル（私有の数値予備検証のみ）

製品の異率対応はまだ追加していない。rubato0.14.1のFftFixedInと現在のwrapperを使い、44.1→48kの159位置、48→44.1kの172位置、それぞれ128／512／1024／不規則callback分割の1324条件を確認した。147／160の全有理比phaseとstartup・内部FFT unit／wrapper1024境界等の選定anchorを含むが、FFT×wrapperの全合同phaseは網羅しない。出力peakを申告output_delayによる中心reference `(outputIndex−D)×inRate/outRate` と比べ、残差は出力frameで約±0.496599、−0.5～+0.49375。全peakが予測floor／ceil内で、有限・逆相pair誤差0・分割によるoutput bits不変・public APIと整数carryモデル一致が成功した。親も生JSON1324件の整数残差・phase集合・重複なしと13証拠hashを再集計した。

startupはn<output_delayにも非ゼロ応答があり、その範囲を「ゼロ列」と扱えない。これは申告中心モデルとの限定的な整合で、各出力sampleの唯一の原信号対応、実コールバック遅延、FIR support全体、音質、CPU、長時間性能の保証ではない。zero paddingはhelperだけで、製品Stopにflushを追加していない。製品／Cargo／実機の変更・操作はゼロ。manifestはtarget/issue-backlog-cross-rate-model-manifest.json、SHA256 11E6876123DA5C6608D5480B75F272CBC5E6F94A2AE7930F95F50BB18745D678。

異率のbatch生成を成立させたcallback到着→実batchのqueue読出完了と、中心referenceの申告モデルは別modeとして設計する必要がある。既存の同率raw frame対応へ率換算だけでsupportedを広げず、蓄積待ち・carry・過去overlap・generatedとacceptedの違い・metadata欠測・回復skipの失効を明示する。この調査で#28全体を完了扱いにしない。


### #69 メーター・プラグイン一覧の英語対応（自動確認済み、実画面を確認中）

メーター、音量調整・音量確認、遅延・キュー・frame観測詳細、プラグイン一覧・ラック表示を翻訳した。カテゴリの内部ID、SDK由来の名前・vendor・path、検索・お気に入り・履歴・drag IDは維持する。未観測・停止・不明・保留は別状態のまま表示し、言語変更で測定購読や操作controllerを再生成しない。原文しかないbackend errorはその旨を表示し、全native errorの英語化とはしない。

追加303keysとAppShell隣接比較ラベルを含め、日英1099keysとplaceholderの一致、凍結24filesの独立レビューが成功。対象11files／85testsとAppShell3tests、親の全UI82files／666tests（19.18秒）、TypeScript、Vite9.35秒が成功した。main638.33kBのchunk advisoryは残る。対象manifestは6D4293F9…、後続AppShell addendumは2BDC710F…で同じpathは後者を優先する。通常Host／engineは提案backend時の固定binを使い、Rust変更はない。

実画面向けに268差分入力を固定した。input manifest SHA256は8317AED545C2FBDC3FABE5AB70E239E1FF05EFC2E6D1185CFC0007F94AD0E5AE。初回Host70600は音量チェック表示が初期OFFのため、対象ボタンを待つprivate helperが失敗した。測定開始・録音・物理試聴・OBS書込みは実行せず、9raw設定を終了前に復元し、所有Host終了とnative2files復元を確認した。初回失敗記録と画像を保持した。製品不具合とは判断せず、表示checkboxを通常UIでON、AutoGainを閉じた後に元のOFFへ戻すprivate手順を独立レビューし、再確認中。


2回目Host57372では、同じ詳細dialogとAutoGain dialog・target -17の保持を日英切替で確認し、900×600／DPR1の英語画像を保存した。測定開始・録音・Apply・試聴はしていない。ただしBrowserを開く前のsynthetic scan guard導入がCLIで拒否され、probe全体はFAILEDのまま残した。Browserの実画面・走査結果・blacklist不変の最終assertは未到達で、自動UIテストの成功から推定しない。

独立したReactなし同originページで11raw設定を確認した。最初Host89044では保護flag1項目が不一致だったため11項目を復元し、次Host71720ではlocalStorageへ書かず前後11項目がすべて一致した。両Host終了後にnative2filesも復元し、Host／engine／1420server不在とVST回復原本C90B35B0…不変を確認した。11rawは元9項目とfavorites／recentで、値は私有回復領域だけに保持する。proofのnative warmupによる短い起動はあり得る。電源断の永続性保証ではない。

2回のFAILED記録、部分到達の画像、全UI666件・対象別log、11raw保全proof、helper・AST依存・server、固定binの29証拠と268入力を保全した。evidence manifest SHA256は7913BA1F818D8960DAB5D2928FD3509429F33AC322B8AC5515DDA3C164A5A8B6。実機Browser未確認を明記した限定監査を依頼し、次のGuide／Wizard／Tutorial／診断の英語対応を開始する。typed OBS結果、歌唱聴感、Soundblaster可聴性、実DPI／Narrator、長時間運転は別途残る。


メーター／Browserの29証拠・268凍結入力・24実効files・日英1099keys・11raw保全proofの独立監査は限定PASS。2回のFAILEDを成功へ置き換えていない。Browserのguard失敗は、固定依存Tauri2.12.4のscripts/core.jsでinvokeがObject.defineProperty(valueのみ)により書換不可であることを親が確認した。plain objectを使ったguard単体テストはそのdescriptor差を覆っていなかった。実ランタイムを無理に変更せず、Browser実機確認は未完了として残す。


### #69 Guide／Wizard／Tutorial／診断の英語対応（自動確認・独立レビュー済み）

ガイド3files、Wizard3files、診断、Tutorial、Appの説明・通知、経路hintとレート比較の表示helperを翻訳した。診断itemやConnectionCheck結果は表示用key＋argsで保持し、localeでstep・保存ID・入力実名・probeを変更しない。従来の日本語string helperは互換wrapperとして維持し、clipboardは明示クリック時のlocaleと結果をawait前に固定する。OBS結果token／ObsTimingCheck／BroadcastBundleは今回の対象外で、backend原文詳細を全英語化したとはしない。

18files（product12・tests6）を凍結。manifest SHA256 24A998562A98159DEF801E44CF78E5734D4EB477F4C54BAA47E1C6FD9B787C7F。日英1543keys、追加444／動的27と全args parityを独立照合した。対象9files／91tests8.63秒、TypeScript、対象diffcheckが成功し、独立レビューは新しいP1／P2なしの限定PASS。親の全UI83files／673tests20.76秒、TypeScript、Vite11.14秒も成功。main701.02kBのchunk advisoryは残る。

273差分入力を固定し、input manifest SHA256 DE82361BB6213B59013153877A96E3A67ABB92372A210E2D8EFC24B013FE5492。通常Hostと実engineは既存の提案backend固定binのまま。Guideの手動入力とWizard未保存表示選択の言語切替を実画面で確認するprivate helperを静的レビュー中。Tutorial再開・診断実行・OBS接続・音声Start・テスト音・録音・Applyは今回実機試験の対象外とし、UI回帰と区別する。


Guide実Host12664では、進行stepと手動入力2件の同一DOM保持、Wizard welcomeの未保存表示選択を日英切替で確認し、900×600／DPR1の英語画像を保存した。Guide入力値の保持はDOM assertによるもので、画像はスクロール上部を写している。OBS実接続・書込み・到達・最終録画、診断実行、Tutorial再開、機器選択／Apply、明示Start・試験音・録音・試聴はしていない。起動時native warmupは別で、無音声起動の証拠とはしない。

Host終了前14rawを復元後、別ReactなしproofのHost80796で再復元、次Host2740ではlocalStorageへ書かず前後14項目一致を確認した。旧11rawの完全継承と追加3項目の型、native2files復元、VST回復原本C90B35B0…不変が成功。3所有Hostと1420serverを終了した後に、別の固定Engine予備運転を開始しており、監査時の全engine不在とは表現しない。

22証拠・273凍結source・18reviewedfiles・固定bin・関連依存／673tests等のlog・14rawproofの独立保全監査は限定PASS。evidence manifest SHA256 3A5FC9CEC8A023220118A5D84AD40FFC6F87E7FE08D6B8A6B72BDD0FA7309841。プリセット／通知とtyped OBS結果は未対応で、#69全体を閉じる段階ではない。

### #38 30分の予備観察（限定成功、48〜72時間とは別）

固定した提案backend時のdebug Engine0880ECC1…と回復原本C90B35B0…の2VST、ASIO96kHz／512frame／22入出力ch、通常gain0で予備運転を開始した。新しい#28変更の試験ではない。最初のprivate helperはEngine Started DTOへ存在しないchannelsを求め、開始直後にKeyErrorで終了した。失敗recordと実行helperを保持し、所有child終了・原本不変を確認した。実rate／bufferはStarted、実ch数はwarmup後のQueueSnapshotで照合するよう修正し、独立再レビューに成功した。

2回目はPID90704、私有record soak-30min-fd3e0d3791e44dc79354c3e07361b0eaで1800.265秒、60回の標本採取を完了した。gain0は開始前に指定し、global muteはOFFとして有限queue回復を妨げない。Start直後は既定0/1chのgain0区間があり、Start後に6/7を要求して2秒warmupを除外している。6/7のRT適用を厳密ACKした証拠とは区別する。callback337924回、queue underflow／zero fill／drop／recoveryは0、停止後queue保存則・出力peak0・Engine error0・所有child終了・回復原本不変が成功した。

一方、callback到着間隔に基づくglitch_countは103から102721へ増え、max_jitterは7535µsだった。キュー不足が0であることと、callback遅延診断・聴感上の音切れは区別する。Engine単独のPrivate Bytesは168701952〜168972288bytes、Working Setは243847168〜244154368bytes。最初と最後の採取区間で累積CPU秒差／経過秒は1コア換算37.91%。この範囲から長時間のメモリ漏れ不存在を断定しない。温度／他負荷統制、Host／WebViewメモリ、release性能、聴感・音切れ、48〜72時間品質ゲートの代用ではない。Cargo等は所有child終了後に再開した。

初回失敗record、実行helper、依存helper、固定旧Engineと127source、今回のreport／summaryの計135入力を別copyへ保全した。evidence manifest SHA256は29E07CA1C10A2B155723EA9730F58253D14CBAC960E590914E6AF4A5D3F854DE。新しい#28 sourceや最新UIの実機検証へ流用しない。実rack payloadを証拠copyへ含めていない。


### #28 異率のcallback-batch-readiness実装（source凍結、実行検証は保留中）

同率rawの旧観測を維持し、異率では生成出力位置（破棄分も進める）と実際に受け入れたprefixをqueueの読出しへ結合する別modeを追加した。1入力callback1event、既存有界ringと非RT結合を再利用し、queue処理・FFT/carry・停止flushは変更していない。prefix逸脱・変換失敗・回復skipは観測だけを失効させる。異率ではframeTiming=null／raw Trace拒否、別optional resamplerBatchTimingを公開する。同率では新field=null。旧missing／nullはunknownの互換を保つ。

観測は、生成に必要な入力が揃ったcallback到着→その生成出力のqueue読出完了であり、過去の入力蓄積待ち全体や信号sampleの点対応ではない。公開APIの出力delayは申告descriptorで別に示し、観測分位へ加算・減算しない。実FFT／ring・複数emit・zeroemit・carry・drop・wrap・zeroFill・metadata欠測・epoch／seal／skip・無割当と旧DTOの回帰を作成したが、30分予備運転中のためまだ実行していない。

backend等9filesをmanifest SHA256 78466CBEF3E01AFCFDD6FEB02B43B67816B432BDAD32CCFB6A183EB7D0293CEEで固定し、対象fmt／diffcheckが成功。Guide非所有266source不変。独立静的レビューは新P1／P2なし。ただしCargo／テスト／実機は未実行で、実行成功を意味しない。

親は別の観測sectionを追加し、mode／descriptor／counter保存則、停止・失効・未観測を判定して、生成出力frame加重のp50/p95／coverageと申告delayを区別した。4filesのmanifest SHA256 A428695269BE2AFED22FDD0CFB265DF0189463546B3CCCF432E2C877F15461C5。24日英keys、全1567keysとargs、静的syntaxが成功し、独立静的reviewはP1／P2なし。6UI回帰を作成したが、test／tsc／build／実画面はまだ未実施。この間の固定旧Engine運転は新sourceの証拠に流用しない。

### #69 Presets／Templates／Bundleフォーム（source凍結、実行検証は保留中）

表示keyを元Template object／ID／role／preferredに対する別mapへ分離し、未保存の検索・名前・category・割当・確認dialogを保つ。Bundle通知は明示kind＋notice＋rawDetailへ分離し、日本語「保存しました」のincludesに依存しない。APIクライアント自身の不正応答等だけcode化し、backendが生成した結果・diffの文章は未翻訳原文と明示する。typed OBS結果の実装や自由文解析による翻訳は今回含めない。

10files（product6＋tests4）をmanifest SHA256 7E6B8D7714EAD2A9D46BE7D2BC1817BD54DCD2B6960F2AA2DCA3D16E12C261AEで先行固定した。日英1772keys・今回205／動的14・既存batchTiming24の保持とargs parity、静的AST syntax／対象diffcheck、独立静的レビューが成功した。初回の確認dialog試験は正常な背景aria-hiddenを考慮せず1件失敗し、テストの参照方法だけ修正した。製品6filesは不変。対象4files／24testsと最終TypeScriptが成功し、最終manifest SHA256は2B934E4C96F15560880A5E4C3FA627D36E4428280E8E9B8FCAF07AD15E83E649。失敗ログも保持する。typed OBS backend・通知hooks・実画面は残る。

### #28／#69 最新入力の統合チェック

異率batch-readinessのUIとPresets等を含めた全UI84files／686tests（19.12秒）、TypeScript、Vite build（7.09秒）が成功した。Rust all-targets check／strict Clippy、lib369tests、各bin、audio_queue_contract 2件、msix_coexistence 2件が成功した。incremental hardlink失敗のcopy警告は残る。OTT editor等の前回成功済み実機依存試験は今回再実行していない。最新sourceの実機確認とは区別する。

### #46／#47 事前基準を固定した候補比較

旧release rlib・dependency closureとprivate sourceを固定し、軽量Sinc 64／96taps×Linear／Cubicの4候補を4レート組×−500／0／+500ppmの48条件、FFT対照4条件で比較した。候補48条件は全てscreen不合格、FFT対照4条件は合格。例えば64tap Linearの44.1→48kHz／−500ppmでは、23.15kHz imageが約−35.38dBで、事前の−80dB基準を満たさなかった。選択NONEを保持し、この候補群のheap／CPU評価や製品採用へ進めない。可変比変換全般が不可能との結論ではない。

固定FFTの旧wrapperそのものをbaseline、入力単位1024→512の定数1箇所だけ変えたcopyをcandidateとして比較した。4レート組×2variantsの離散周波数screen、56carry条件、192→44.1kHzの2反例（metadataのみ）、16heap条件と80timing trialsが成功した。2／22chの8群でfresh Runner5回のaggregate ns/inputframe中央値比は0.924〜1.056、全trialはcomponent wall/audio-time比10%以下だった。512は事前予算の範囲内だが、同一process・固定順での探索比較であり統計的優位や全engine deadlineの証拠ではない。全周波数screenは2chのみ、22chは1000Hzの逆相・単ch漏れ・先頭ch一致に限定する。192→44.1kHzでは512にしても内部単位とdelayは半減せず、全レート一律の改善とはしない。

初回はWindows PowerShellのGet-FileHash読込失敗でコンパイル前に停止し、記録を保持した。同じ固定入力をPowerShell 7で実行した。製品sourceはまだ変更していない。115入力／出力・固定bin・helper・失敗記録の保全manifestは8D7433137CD30EB5215EED584688B753A1E57828B89224F4333A26EE2273797C。外部Cargo registry sourceも含むため、最初の保全helperはworkspace相対path化で失敗した。部分copyは残し、絶対pathを区別して新規copy先へ保全した。結果の独立監査と製品変更の判断を続ける。

その後、115入力の保全・raw結果再集計を独立監査し、不一致なし。計測80trialの最大component wall/input-time比は0.963%。製品では検証済みの実rate 44.1→48／48→44.1／48→96／96→48kHzだけ512を選び、それ以外は1024、同率は無変換を維持する限定変更へ進めた。比率だけで他のrateへ広げない。

製品4filesのmanifestは4D76C76FF8337D8CC5F01ED7A822B53E5FAEAB9431302D037BD737FC5C40F18E。独立レビューはP1／P2なし、source／copy／変更前snapshot／patchの開始終了hash一致。参照constructorの独立期待値、C境界・2/22ch・未選択rateのfallback・carry・finite・bit一致・無割当を検証し、frame観測の小容量queueは512でもdrop／wrap／zero-fillを発生させる。製品変更後のlib369tests・all-targets check・strict Clippyが成功した。新しい計測instrumentation込みの性能・最新実機・聴感・長時間は別確認とし、実行binを再ビルド中。

最新debug Host／Engineの再ビルドは96.39秒で成功。fixed Engine SHA256 F3BE831B61962FED6D42F65E8CEFDEC94BDA60A8120E66B4F6D89557723BD850、Host 19D91BFF15801C745C6958DBE6EE9F391E05057200A5A1A950B90E09F8D59151。Hostは今回起動していない。関連130sourceとthird-partyを別copyへ固定し、manifest SHA256は4E228224347A212C5BC85C48B7A2472FCC299BEFE8CB559B47EF92BEF30F9EAC。実行直前にも現在入力との一致を確認した。

最新Engine PID81324でASIO96kHz／512frame／22ch・2VST・gain0、2秒warmup後10.0秒／11標本の限定試験が成功した。callback最終2249回、queue underflow／drop／recoveryは0、raw frameTiming supportedと新batch fieldの明示null、停止保存則、gain0のRT確定、所有child終了、C90原本不変を確認した。メーターeventは1件で出力peak0・有限値、Engine error0。一方callback遅れの累積値は619、最大jitter6158µsで、連続PCMの有限性・可聴音切れゼロを証明する試験ではない。同率なので異率FFT512実機・性能・聴感・長時間の代用にしない。18証拠／130sourcecopyの保全manifest SHA256は069D2E2F2F9CBDA7F69AAAD47557CB3EBA5FE1984E0CB5707044CA0E06F06463。独立監査は全hash・130copyの対応・保存則・同epoch・pending／unknown0・cleanup・C90保全が一致し、限定PASS。

### #69 更新通知・更新画面の言語切替

更新通知・Store案内・適用確認を32keysで翻訳し、日英1804keysと引数の一致、既存Presets205／batchTiming24keysの保持を確認した。非同期操作のtoastは操作開始時locale、表示中dialogは現在localeを用いる。localeをcheckUpdates／10秒・24時間タイマーの依存へ加えず、版・配布判断・取得重複防止・確認状態・busy・flushSession→install順序を維持する。配布本文・backend生エラー・URLは原文を保持する。

対象16tests、TypeScript、diffcheck・静的syntaxと独立レビューが成功した。product4＋test1のmanifest SHA256は4029F1B5147A199308B149EA3F27DE72093DD42C005BD5FEA509B537B1E18BB3。実更新・Store操作・通信・最新画面は未確認。プラグイン／音声等の通知hooksとtyped OBS結果は引き続き未対応であり、#69全体の完了ではない。

更新5sourceの実体copyも元manifestの全hashと照合した。別addendum SHA256はBB97C7523A699EF7BF5B2D5AA42E2DB46EE6846502EA6FEC84E25524FD40932F。後続catalog変更とは分けて保持する。

### #69 音声起動・復旧・アプリ通知・OBS利用終了の案内

4hookの表示通知を22keysで翻訳し、日英1826keysのparityを確認した。安定formatterは通知の解決時に最後にrenderされたlocaleを使い、すでに表示したtoast自体の再翻訳はしない。localeを購読・復旧timer・初期bootstrap・OBS leaseの依存へ加えず、Stream Errorなどの判定token、世代・保護条件とraw errorのidentityを維持する。

対象64unique testsとTypeScript・diffcheckが成功。初回の新fixture引数1件とtest型2件はテストだけ修正し、失敗logも保持した。6filesの実体copyとhash manifestはF83135EEBD7EB27A0F785B6B644C5593D629D8EBD62B3C5709DCF037F5ED47B7。独立レビューはP1／P2なし、開始・終了のsource/copy hashも一致した。実機の復旧・OBS通信・最新画面と全体統合チェックは未実施で、プラグイン等の通知やtyped OBS結果は別途残る。

### #69 プラグイン・セッション・プロファイルの通知

表示用noticeはkey／argsと保護説明を含むかのmetadataを保持し、公開error:string|nullはrender時に生成する。日本語「保護中」のincludesで重複案内を判定せず、保護latch・復元権限・世代条件はそのまま維持する。profileの従来setter引数を維持し、製品hookから任意末尾のnotice sinkを渡す。既知client Errorには固定codeを追加するが、日本語message、取消sentinelの同一性、SessionRackConflictのinstanceof、backend／SDKの原文判定は変えない。

8filesの実体copy付きmanifestはB27B00F9B4257DFECFE62A73D1A60CFEA1B036ADABD4AB14914D85B70EA847D4。日英1878keys、追加52／動的11、既存1826keysと値の不変を確認した。対象87unique tests・TypeScript・diffcheckが成功し、最初のhelper引数型failureのlogを保持した。独立レビューはP1／P2なし、全source／copy hashも開始終了で一致した。範囲外のstrict Error表示・内部throw原文・backend／SDK結果・typed OBSは残る。実機と最新全体UIは未確認。

### #69 本番モード・scene通知と通知全体の統合

useLiveModes／useLiveSceneRoutingの通知へkey／args stateを導入し、既知client理由3種類はcanonical日本語messageを保持したcodeで識別する。scene実名・route・epoch／revision・armed意図・lease・世代を変更せず、localeを操作や購読の依存へ追加しない。追加12keys、日英1890keys・旧1878keys／値不変、対象17tests・TypeScript・diffcheckと独立reviewが成功。4filesの実体copy付きmanifestはA03F0CF4E32F099583BF699E3B4207D1309F189561ED32579E516374CC6840A0。saveLiveRouting保存拒否の範囲外表示や表示後toastの再翻訳、実OBS・実機は未確認。

通知群を含む289現在入力をcopyへ固定した。input manifest SHA256は4698FE671D16F2BA4231B3A5634A116251A968A16F18BA4B3CA72AC7D84CB71D。全UI88files／703tests（18.33秒）、TypeScript、Vite build（8.16秒）が成功し、実行前後の289source hashが一致した。最新実画面とは区別し、Presetの未保存値保持を実Hostで確認するprivate helperと、OBS結果のtyped backendを別scopeで準備中。

### #69 OBS結果の型付きbackend（ローカル検証済み、表示側は残る）

OBS適用・復元結果へ9種類のoutcomeと、固定code・許可したprimitive引数・日本語fallbackを持つUiTextを追加した。従来の日本語fieldを併存させ、同じ処理で更新する。表示専用DTOはSerializeのみを維持し、Undoのprivate witness／leaseや実行順序を変更しない。日本語「適用済み」による成否判定を除去した。変更0件の正常適用は成功を保つ一方、期限切れ後の結果は履歴の再取得・restorable再計算を経ても成功へ戻さない。非公開completion_validは表示上の完了判定にだけ用い、Undo権限へ流用しない。

3Rust filesの実体copy付きmanifest SHA256は38615B0F4DD050FABE20375D6698B7023869D8D22F0A4256BD94B6409DD18A85。独立レビューはP1／P2なし、source・copy・変更前・patchの開始終了hash一致。all-targets check、strict Clippy、lib376testsが成功した。debugビルドも83.94秒で成功し、固定HostはDDBBC77B2DFCB2B667DC4547908E141E4F2CC772EEFA7B2D9AF06A0AB9F9274C、Engineは5B88073324AA3BE226F2BE692546F8B95B992FA04331D85559738E7735CD54AC。関連130sourceの保全manifestはE389F32B99BA4A2202B248B85481F05A8CEB03F39A58AD39CE19CD3C709C6C76。

表示側の型・既知code翻訳・不明結果の原文表示・成功判定の統合は未対応。今回の固定binは起動しておらず、実OBSへの書込み・復元・最終録画は未検証。以前の固定FFT512ペアによるGUI確認と、このbackendの実機検証を区別する。

### Preset実画面検証の復元用helperの再レビュー

初版private helperは実行前レビューで不合格とした。起動途中の失敗に対する復元原本の永続化、親終了後に残る所有childの確認、終了時の原本hash不一致の扱いに不足があり、例外文字列へraw storageを含め得る経路も修正対象にした。初版manifestとsource copyを保持し、実Hostは起動していない。

修正版は起動前にnative6ファイルのbytes／不存在と設定inventoryをatomic journalへ保存し、localStorageの最初の書込み前にも原本を保存する。所有PID・親・実path・作成時刻で終了を確認し、実行許可用hashが変わっても所有回収は可能にする。親子の終了確認後だけnative設定を復元する。別Python processからのrecover入口と、例外typeだけを記録する報告経路を追加した。fixtureだけの故障テスト13件と構文確認は成功。manifest SHA256はF9E34D718622DA01F176ABEAAD71E507AF326F11B73BF0AD5AD1C924761B29D8。実Host・CLI・Viteは未起動で、独立再レビュー待ち。

#66のWindows実表示倍率200%・キーボード・Narrator検証は、ユーザー回答により後日の手動確認とする。自動テストやWebView内の倍率操作を代用せず、手順はACCESSIBILITY_MANUAL_CHECK.mdに保持する。

typed OBSの3source／変更前／patch・130native source・固定bin・検証log等の150入力を別copyへ保全した。manifest SHA256はDB00A0FB5D298A4C8CDBB046619957D30F0D6885E7ACCDB642F34E0A413F06E4。親も150copyのhashを再照合した。最初の保全では許可prefix不足で途中停止し、84個の部分copyを保持した。raw storage・rack・設定は含めない。

Preset helper v2は、親PID再利用時に新しい子を所有扱いできる点を追加レビューで不合格とした。v3は子の列挙前と採用直前に親のPID・path・作成時刻を照合し、再利用／不明なら新規採用を拒否する。cleanup・recover・列挙途中の交代を含む14offline testsが成功。実行supervisorも、native復元の成功確認前にproofを起動しないよう修正した。v3 manifest SHA256は9181FC4F666EAA83C8A056797FC7694CE74BFBDE7E44D20633A19187FBFD7E3D、supervisorはF66D3076F40732DF7F7495ECF5DADFBEB28EB4C8876FADC855405FD21F0AFB30。独立再レビューは未解決P1／P2なし、限定手順の実行GO。これは実機結果の合格ではない。

v3実行record presets-notices-native-924867812b634c6781c71d22369f88b6は、prepare成功、uiがRuntimeErrorで失敗（スクリーンショット前）、recover成功、最初のreadonly proofは保存値不一致で失敗した。native6・所有親子終了・C90／canonical原本は保全。Reactが動く間に原文storageを復元すると、保護解除後の自動保存が再書込できる経路があり、画面確認成功とは扱わない。

失敗時journalを新規私有copyへ保全し、復元必要をatomic記録した上で、immutable v3を使ってReact-freeの別Hostから再復元した。recoverと、その後の2回の別Host readonly proofが成功。canonical14＋policy＋既存extraの計22keysについて値・不存在の一致、未知extraなし、native6のbytes／不存在一致、C90／canonical原本不変、全所有Host／Engine／server終了を確認した。失敗reportは成功reportと別ファイルで保持する。root-recover helper SHA256は61CEE43726D24EE7131D27C6C5CBB7FA9837A9F0A2D1AC54AB4B6D3A492AD654。

v4 helperは固定ui／起動／proofステップ名と、既知keyの一致bool・未知extra数だけの診断を追加する。UI終了時はguard／保護を維持して親子を終了し、raw原文の復元は別React-free recoverへ委譲する。recoverは以前のstorageRestoredフラグがtrueでも実値を再確認する。proofは書込みせず、不一致をdurableに復元必要と記録する。18offline testsと構文確認が成功、manifest SHA256はF5B7F208E2465DB03840F7215386DD7565D4253BEE0237CFD523B95D4AB6B3FA。独立レビュー待ちで、実UIの合格はまだ得られていない。

v3失敗とその後の復元だけを、444copyと6hash-only参照へ保全した。manifest SHA256は44C5D8AAF75F191BB833B6EC113D78734452E720A985B1D455978FA7F35E5D62。UI合格や現在Rustの受入とは区別し、raw journal／storage／Host logを含めない。

v4は独立レビューGO後、record presets-notices-native-e39499455c884e34957241b6599037f5でprepare成功、uiはlocaleJaInitialのRuntimeErrorで失敗した。React終了後のrecoverとreadonly proofは成功し、22keysの2寿命一致、native6／原本保全、全所有process／server終了を確認した。原因はprivate helperの前提不足。同じjaへsetLocaleしてもstoreの変更通知は出ず、明示preferenceだけを保存してnative projectionを待っていた。製品LanguageSelectorは別途projectLocaleを呼ぶため、この失敗を製品不具合の証拠にしない。

v5は別working／source copyへ隔離し、store保存後に明示projectLocale(value,true)のACKとnative file一致を待つ。同じja・通知0でも明示projection1回となる生成JS回帰を含む19offline testsと構文確認、独立レビューが成功。manifest SHA256は22F1D78B78FD1F7E98AD1066C95C3DF8853B458C65F151EB83BD3A7A66DA1CD8。supervisorはmanifestのimmutable copyを実行直前にhash検証して起動する形へ限定変更し、SHA256 94FF2BAAA9559573AA6266C7B37F5C8C7288F65BB196854FACBB826E2C593538で独立レビューGO。旧F66D版も保全。直接store＋projectionの検証であり、LanguageSelector自体のUI操作証拠とは区別する。

v3の444copy・6hash参照を独立監査し、byte数／hash・130／289snapshotと固定binの対応、失敗UIと成功復元の区別に不一致なし。native6等の保全はsanitized reportの監査であり、raw原本の独立読取り検証とは区別した。

v5 record presets-notices-native-c5b3739d63db49df9e845e5a390c7854でprepareとuiが成功。900×600／DPR1の実Host上で、同じDialog・名前／検索input・カテゴリcheckboxと未保存値をJA→EN→JA→ENで保持した。2VSTのmetadata／順序／flags／gain不変、停止・gain0、profile書込み操作なし、updater自動無効、所有Host／Engine終了・native6復元・canonical／C90原本保全も確認。英語PNGを親が閲覧した。raw原文は保護を維持したままReact-free recoverへ延期しており、その最終確認はまだ進行中。

画面用HostとViteが終了し、React-free pageのみであることを確認後、typed OBS表示側の唯一のwriterへ作業を引き継いだ。ここからのcurrent frontendは変わるため、この実画面結果は1890keys時の289snapshotに対する証拠とし、後続OBS表示側の最新実画面へ流用しない。

v4の追加保全は新規23copy・既存v3保全423参照。manifest SHA256は81941AC3A7357C35E77309B7C8DDD35B4098DC16BF8A2FA6E8FC30E5428AC311。初回のUTF-8指定漏れによる21partial copyも保持した。独立監査はbyte数／hash、旧snapshotとの対応、失敗UIと成功復元の区別に不一致なし。

v5はprepare／ui／recover／proofがすべて終了コード0、supervisor全体も成功した。React-freeの2回の別Hostで22keysの値・不存在が一致し、既知15keysの一致boolはすべてtrue、未知extra／その他保存値不一致は0、LS書込みなし。最後に親がnative6のbytes／不存在とその他native inventory全体、C90／canonical原本hashを別に再照合して一致した。root-postcheck-report.jsonはraw値を含めず、全所有Host／Engine／server終了と1420／9223にlistenerなしも確認。アプリは停止した状態とし、元のstreamを再開したとの主張はしない。実DPI／Narrator、実LanguageSelector操作、Templateの適用、OBS書込み・録画・試聴・音声品質の検証には流用しない。

v5の保全は新規22copyと既存425hash参照。manifest SHA256はC363B919B96DD7D3B734BFE81E077C1D55A1867C9181EDA4BE8DBDFEB36CC7F2。root-ownership-provenance-reportは5Host寿命の親子PID／path／作成時刻だけを抽出し、raw設定を含めない。runtimeのhashはpostcheck時点と明記し、実行時の許可検査はreview済helperによるものと区別した。スクリーンショットはCLIがpresets-en.pngという名前で保存したが、実体はJPEG/JFIF・900×600である。原名・bytesを維持して形式を記録した。初回の形式検査等で失敗した部分copyも保持する。

v5保全は独立監査も限定PASS。22copy／425参照・byte数・source／bin対応・4stage結果、22keysの2寿命一致、画像の英語／未保存入力と実JPEG形式、root別照合の範囲に不一致なし。実行時helper許可検査と実行後のfile hashを区別し、raw原本を独立監査者が読んだとの主張はしていない。

### #69 型付きOBS結果の表示と成否判定

API2・新表示helper・同期／安全設定／Bundleの3画面・catalogと直接test4の計11filesを実装した。86種類のRust codeを明示schemaへ対応させ、有限number・boolean・既知enum等のprimitive引数だけを翻訳する。未知code・不正args・legacyは原文の詳細と明示し、任意objectを展開しない。失敗の個別理由は既知の要約と分けて原文を残す。実source／filter／device／VST名を翻訳せず、接続失敗で資格情報を含むraw例外を新たに表示しない。

Timing採用は非空のchanges／legacy results／typed entriesの件数一致、既知applied outcome、restorable===trueで判定し、日本語「適用済み」の比較を除いた。text codeは権限に使わない。Undoは既存backend権限、Bundleのcomplete／undoPendingと変更0件成功を維持する。localeを購読・接続・poll・失効effectの依存へ追加せず、未保存入力・同一DOM・pendingを保持する。

11filesのbefore／final copy・patch付きmanifest SHA256は44C6264E8BC593B771AF2CB9E28A671215BFBA2DED5903EF72B6ADBC4BDBDC62。旧1890日英keysと値を維持し、168追加で2058keys、args parityと86Rustcode集合の一致を確認した。対象157testsとTypeScript、最後のcopy調整後helper104tests／TypeScript／staticが成功。初回の旧期待値・typed mock不足11件、その次の英語label誤記2件は修正し、失敗logを保持した。独立レビューはP1／P2なし、開始終了source／copy／before／patchと参照Rust3sourceが一致した。接続状態を採用ボタンへ直接加えない既存仕様についても、切断失効通知と履歴無効化を確認し、今回の退行は確認されなかった。

親の最初の全UIは89files／815tests中814成功、MigrationRestartの最初のlazy modal表示待ち1件が既定1秒でtimeoutした。製品291入力の変化はなく、同じ11件の単独実行は成功。テストの最初のfindByRole待ちだけ3秒へ明示し、移行順序・失敗時保護・復元回数のassertは維持した。manifest SHA256は6FAEE7596A4301550F9847AAF8DF1110BF1B733AC6AD25F0B5B64430ED8AF7FE、独立レビューもPASS。

再実行は全89files／815tests（19.99秒）、TypeScript（4.66秒）、Vite（10.41秒）が成功。実行前後291入力のhash一致、snapshot manifest SHA256はC1FBCCE56AF20E26D03EB272E68FFC2B1157A50A227C010D90B5B157AC9544BC。主chunk 779.36kB／gzip219.35kBの警告は残る。最新OBS表示を実OBS・新typed native backendの画面で確認した証拠ではなく、TimingTargets.messageと未知backend詳細は原文fallbackとして残る。

typed OBS UIのbefore／final／patch・対象log、全UIの初回失敗／単独成功／再成功と新旧291snapshot、テスト待機差分等を629copyとbackend証拠1hash参照へ保全した。manifest SHA256はDD7A597C8631A5A6536AFFACF05EA3FDBFDDABC6F5895FEBE3B861C86C37686A。独立監査は全byte数／hash・patch復元、291入力間でテスト待機1件だけが違うこと、815成功と警告・境界に不一致なし。後続common UI変更や実OBS・最新実機受入の証拠へ広げない。最後のTauri driver-session stopも終了コード0で実施した。

### #69 共通確認とライセンス画面の表示枠

ConfirmDialogの既定確認／キャンセルをrender時localeで解決し、明示label・確認Promise・閉じ方を維持した。LicenseModalは見出し・検索・ARIA・案内・欠落fallbackを18keysで翻訳し、欠落metadataと実提供の法的本文を区別する。NOTICE／LICENSE／npm・Cargo JSON、実SDK／library／version／URL／SPDXの原文を変更しない。開いたDialog・検索・tab・選択を保持し、Cargo importのeffectは[]のまま。

product3＋tests3の6filesをbefore／final実体copy・patchへ凍結。manifest SHA256はD5F813D924B9C0B77E22435A11821F7B46E9EA7EECA8302BA5EF27BC890EEE77。旧2058日英keysと値不変、2076keysとargs parity、4files／15tests・TypeScript・static／diffcheckが成功。初回1件はCargo dynamic JSON importがtest mockを通らず実同梱dataを返したため失敗し、製品importを変更せず実法的本文を照合するtestへ修正した。失敗logを保持し、既存Cargo dataの重複ID警告は変更しない。

独立レビューはP1／P2なし。6source／copy／before／patchと法的本文・JSONのhash不変、typed OBS非catalog10files不変を確認した。最新commonの全UI／Vite／実機はまだ未実施。InputChannelSelectorの残日本語はcomment／consoleだけ、liveRouting保存拒否も唯一の製品consumerが既に翻訳済generic catchのため、両者に追加変更は行わない。


### #69 固定clientエラーの表示言語

APIの9種類の固定Errorへcode／messageKeyを加え、canonical日本語message・toString・Error判定を維持した。既存PluginClientErrorの5keysを再利用し、未知の文字列から理由を推測しない。表示時localeで既知エラーを解決し、Updatesの通知だけは操作開始時localeを維持する。移行15秒期限／適用順／rollback、音量の直列要求／revision／確認後保存、試聴のsession／op／epoch／stop未確認を変更しない。proposal.unsealedとrenderFailedを追加し、renderFailedの個別原文は折り畳んだ詳細へ残す。

23files（source12・tests11）のbefore／final実体copyとpatchを凍結。manifest SHA256は85D6D6FDCE9F8C959AD88DA516EAD177A6DDC9EE3A61908D41F5341967622169。旧2076日英keysと値不変、12追加で2088、args parityを確認。対象128testsと、最後のcopy調整後14tests／TypeScript／static／diffcheckが成功。初回の新test名誤りとFragment完全一致query失敗logを保持した。独立レビューは進行中。

共通UI／clientを統合した親の全UIは92files／851tests中850成功、LicenseModalLocaleの1件がtest全体の5000ms期限で失敗した。299入力のhash不変、snapshot manifest SHA256はB159DC195C98F69A2C643ACF4FA82F71A32BF74F65FD2E8CEF58D3CF03800341。実同梱Cargo library全件へのARIA queryを避け、既存検索欄で対象nameを絞ってからCargoタブを開くtestだけへ変更した。法的本文・locale・選択のassertと製品codeは維持。該当2testsは424msで成功。変更前／final／patch manifestは8E7DD43B537B43F8098E904CA1223D028862784ABD32333A1B37264220D2F360。独立レビューと全UI再確認を進める。

### #46・#47 別endpoint連続検証の機器列挙

音声を開始しないEngine-only private helperを用意し、offline sanitizer正例2／負例11と独立レビューに成功した。manifest SHA256は6C4D19601D9168CBCA69BDDA2B520FED79974653DB174E0D68B838262E46EC1A、実行helperは2449620938E55FAF1B9629597F60AC18F8CC864E8252CFF0B427F4DBCA9B70C1。固定typed OBS Engine 5B880733…と130source copyを検証して実行した。

record capability-probe-run-bbf531dadfdb409989f0deb23c7d21d7は失敗。Begin／Poll完了／GetDevices cache一致／Cancelまで進み、CABLE Outputとスピーカー（Soundblaster）のWasapi endpointを含むDeviceInfoを取得した。一方、所有監視がownership_monitor_failedとなりscannerを観測できず、全体を不合格にした。所有Engine終了・Job残process0・native6とその他native inventory／C90原本のhash不変を確認。Start／音声／保存／OBS操作は行っていない。現在のreportでは監視失敗の詳細を捨てており原因を断定しない。private helperの診断・handle回収等を修正して再レビューする。表示名のrate表記を実対応rate／独立clockの証拠として扱わず、20分連続運転も未実施。


client23filesとLicense testの独立レビューはいずれもP1／P2なし。23filesのpatch再構成、開始終了source／copy／before／logのhash、制御順序・非同期ガードの維持を確認した。全UI再実行は92files／851tests（runner21.64秒）、TypeScript（4.50秒）、Vite（9.67秒）が成功し、前後299入力のhashが一致した。snapshot manifest SHA256はEC30034166CD9CEC027428331F2B53049A936DB25ACD7E6992A9693C72028C56。主chunk783.57kB／gzip220.16kBの500kB警告は残る。

common／client／test差分・target log・全UI初回失敗と再成功のmanifest／logを新規37copyへ保全し、before／finalと新旧299snapshot等は既存immutable copyへの657hash参照にした。manifest SHA256はC078C241A48C1EE4687CD227682D89B2AD3E25EECD611BE580F5E7EF01464FFA。raw storage／journal／Host logは含めない。独立証拠監査は進行中。

ASTでコメント・tests・i18n catalog・assets以外の日本語literalを点検した。84候補のうちTSX27は、console1・日本語カテゴリID21・区切り記号5で、PluginBrowserのカテゴリIDは表示時MessageKey変換済み。ほかは既存API／復旧の原文Errorやchain templateの日本語互換field等であり、literal件数をそのまま未翻訳UI件数としない。これは固定literalの静的点検で、動的backend原文・全テンプレート補間・実画面の完全保証ではない。


common／client証拠の独立監査は限定PASS。37copy／657参照のhashとbyte数、初回／再実行299入力の対応、License testだけの差分、初回失敗と再成功・runner時間・chunk警告に不一致なし。列挙失敗を実機受入へ読み替えていないことも確認した。別途、現在のgit diff --check成功、既存9未公開コミット維持、所有Host／Engine稼働なしを確認。不要ビルドの追加削除は行っていない。


列挙helper v2は安全なstage／reason／Win32番号・有限Job一覧再試行・検証失敗handleのfinally回収を追加した。offline20件と独立レビューに成功。manifest SHA256は0770BF66429484D1A72BC1B646CADCC857F5A1427EDE68A1A2642BF34DA78051、helperは90CFC0042BBA61455FD732FAEA37E6EFF8228F592043F93BF286F21250793CEC。v1の具体的原因はこの時点でも未確定。

v2 record capability-probe-v2-run-d7136d0554314b55899cea9110dc38f0もFAIL。DeviceInfo取得とcache／Cancelは成功したが、Job内candidate49428のmonitor.identityValidateがidentity_path_mismatchとなった。固定Engine88980の識別は成功。未知の子のimageを確認できていないため、scannerの識別成功や音声開始の許可へ読み替えない。所有process終了・Job残数0・native inventory／C90原本不変を再確認。OS補助processかdriver由来か等は推測に留め、ファイル名とhashに限定した診断を別v3へ準備する。v1／v2copyと失敗reportは保持する。


template補間も追加点検し、日本語fragmentを持つ4候補を確認した。restorePluginSessionの1件はconsoleで、OBS接続の3件は固定案内helperだった。obsConnectionPreferencesの4分類（auth／timeout／refused／generic）はconsumerで直接string表示され、英語時に日本語が残るため追加修正する。既存の安全分類・raw資格情報の非表示・試行port・接続寿命を維持し、表示用key／argsへ移行する。2088keys／851全成功はこの追加前の証拠として保持する。


### #69 OBS接続失敗の安全な固定案内

obsConnectionPreferencesの分類順／readObsEndpointを維持し、code／key／試行portだけのstructured noticeを追加した。旧obsConnectionFailureは固定日本語互換wrapperとして残し、既存4文は完全一致。consumerのhintは現在locale、接続toastは操作開始localeで解決する。生エラーや資格情報をnoticeへ渡さず、revision／document.hiddenガード、effect依存、接続payloadと保存条件を変更しない。

5filesのbefore／final copy・patchとlogを凍結し、manifest SHA256はBB93ED7F47B5D52CFEC243DB8E94A0F3617B1B1A9014972C355AFC72DEE64B66。旧2088key値不変、4追加で2092keysとargs parity。対象20tests／TypeScript／static／diffが初回成功し、秘密canary非表示、JA→EN／EN→JA pending時の同一入力DOM／値／IPC数と開始locale toastを含む。独立レビューはP1／P2なし、5files patch再構成と開始終了hash一致。

親の最新全UIは92files／861tests（runner21.64秒）、TypeScript（4.62秒）、Vite（7.73秒）が成功。前後299入力hash一致、snapshot manifest SHA256は7E19FE93607FBD7AC1EAF3695B5C30F0CB72BD1905302B827D74375F5DCEF90B。主chunk784.94kB／gzip220.51kBの500kB警告を保持する。これは実OBS接続／書込み／録画や最新native実画面の証拠ではない。

追加証拠は11copyと既存immutable source等310hash参照。manifest SHA256はFA7AFC859A4F075EF95F3C2A24A3C2DB26A8380A43777DD3484ACFDA0D6BAC5D。旧851成功／初回timeoutは別証拠で維持し、独立監査は進行中。

### 機器列挙のOS補助process診断

v3は未知imageの安全なbasename・path SHA・64MiB以下file hash・親PID／生成時刻だけを採用前に記録し、未知imageの拒否とhandle回収を維持した。31offline casesと独立レビューGO後に実行。manifest SHA256は5589F561063F29D13CB60F105B06C2C3FE79F0182E99D9C9E604AA2662D9821F。

record capability-probe-v3-run-7a810a85a6eb4788afbf8c268dca419bはFAILを維持。拒否したimageはconhost.exe、Engineの直接childだった。親が別のreadonly照合でWindows System32/conhost.exeのpath SHA／file SHA／1003520bytesと一致、Microsoft WindowsのAuthenticode Validを確認した。root照合report SHA256はB4F31E1F9FDF50E725238C9AC2518D18201D88719B0C7876B7F2E4517910FD88。file hashは観測時で、process load時のbytes測定ではない。v1の捨てられた診断まで原因を確定したとは主張しない。

v4はこの厳密なOS補助imageだけを別roleとして認識し、実fixed binaryのscanner childと区別する。conhostを見ただけでscannerObserved成功にせず、未知imageは引き続き不合格とする。実argvのCIM読取り等は追加せず、immutable begin_scanの--scan契約と固定childのidentityを証拠にし、その限界を記録する。現在準備中で、音声Startや20分連続運転には進んでいない。


2092keyの追加証拠は独立監査も限定PASS。11copy／310参照のhash／byte数、299入力とOBS5files、861成功log・runner時間・784.94kB警告が一致した。旧851件証拠との境界を維持し、実OBS／最新native受入とはしていない。


v4は54offline casesと独立レビューGO、manifest SHA256 FC03BF77562B155DB5E5880924B3D794F8048349685DED027BF8BA365AD2FD27。record capability-probe-v4-run-5267439197704dffbb826210273fe609はPASS。固定Engine1・scanner1・OSconsole2を別roleで確認し、41 DeviceInfo、Begin／Poll完了／GetDevices cache一致／Cancel成功、scannerObserved=true、errorsなし、全所有process終了・Job残数0・設定inventory／C90原本hash不変を確認した。

CABLE Outputとスピーカー（Soundblaster）のWasapi・各2ch endpointはexact nameで一致した。名称のrate suffixは実対応rateの証明ではない。実argvは未測定のまま、sourceの--scan契約に基づく。親が別postcheckで固定Engine hashと130source copyを再照合し一致、report SHA256はA1DC04C20FFF59CBC498542402FB7665E30D8AAB384DCB7337B9D631F496E552。実行時helper検査とpostcheckを区別する。v1〜v3のFAILを上書きせず保持する。

次の音声確認は別private helperへ分離し、最初は10秒で実rateと条件を確認する。要求96kHzをそのまま実異率と扱わず、同率なら別endpoint連続性の検証に限定する。出力gain0のACK後に開始し、VST／NR／内蔵処理／試験音／録音／OBS操作や設定保存を伴わない。20分運転はまだ開始していない。


v4の実結果も独立監査で限定PASS。report E9E1FB7B…の41devices・Engine1／scanner1／OSconsole2、errorなし、終了・Job0・保存hash維持とroot postcheckが一致。固定bin／source130、v1〜v3 FAILの保持、conhost別照合と実argv／実rate／clock／音声未測定の境界を確認した。raw configを独立監査者が読んだとの主張はしない。


### #46・#47 別endpointの短時間screen

continuous helperはv4の固定identity実装をAST限定読込みで再利用し、Engine／厳密OSconsole以外の新childを拒否する。5IPC、10秒screenと同条件1200秒の固定入口、2秒warmup、最大241samples、meter集約、128MiB以下のwire、有限停止と設定hash照合を定義した。新EngineのVST0／NR／builtin／reverb OFFをRuntimeStatsで確認し、gain0 ACKの後にStartする。運転中counterは近似snapshot、保存則はStop後だけ厳密照合する。

core.rsのゼロメーター通知抑止に合わせ、毎sampleのmeter前進要求を除去した。Start ACK前／後とwarmup後を分け、イベントなしのpeakはnull、受信イベントも間引かれた部分観測とする。callback前進を必須とし、連続PCM／物理peak／可聴性は主張しない。45offline checksと独立レビューGO、manifest SHA256 A9BBF8FC8A140E5AE908AAABF0E85EF6231B7E155E5F6279549662C6EA31F261。

record continuous-queue-10s-run-2ccdf825363a4848ba18a3c73f0e2f18はFAIL。fresh defaults確認・gain0／muteFalse ACKは成功し、Start段階でValueError（unclassified）となった。Started記録前のためbackend拒否かhelperのDTO判定かを区別できず、実96kHz／512frames開始不能と断定しない。cleanup Stop ACK、所有Engine／console終了、設定inventory／C90原本hash不変。20分運転には進めていない。

診断v2は同じrequest／5IPC／保護を維持し、10秒専用に限定。応答type、Error stringのSHAと固定pattern bool、Startedの正u32項目だけを記録し、raw文字列・例外本文を保存しない。65pureoffline checks、11copy／132固定参照、manifest SHA256 9211B684DB19AE02A57BAE9DFCA989642B5A6A3CFCDD09C4D12447A582909B8A。旧helper／FAILreportは保持。独立レビュー待ちで、現段階の根因は未特定。


v2は独立レビューGO後、record continuous-queue-v2-10s-run-a33b8297461c4478a899ff9c252aa27bでFAIL。Start Response::ErrorとstreamBuildFallbackExhausted／deviceUnavailableJaの一致を確認した。core.rsのCPAL DeviceNotAvailable案内に対応するが、切断・排他・driver等の根因を断定しない。Stop ACK・所有process終了・設定hash維持。20分には進めていない。

別readonly helperは旧sourceからreport名だけ変更して実行した。SoundblasterはdeviceState1、unmuted、master／2ch約0.12、Voicemeeter PID30836のsession1がactive。AudioClient初期化／stream／setterはなし、idle半秒peak0を実再生確認には使わない。sessionactiveは排他所有の証明ではなく、他アプリやVoicemeeter設定は変更していない。

v3はCABLE48の未実行凍結を保持し、v4でSoundblaster48／CABLE48の明示固定10秒flag二つを追加した。共通Wasapi／CABLE入力／48kHz／512で出力だけを変え、自動fallbackや任意引数・20分は拒否する。73pureofflineと独立レビューGO、manifest SHA256 C48DD5A1D3E5D3EE6DFAFA04675854F5E913E234B50CD2AB67F1E08D9552C61A。

Soundblaster48 record continuous-queue-v4-soundblaster48-10s-run-19141641997c42b6a33a8f001d72664eはFAIL。Startの同じError SHA 72059E57…とDeviceUnavailable案内を返し、Stop／終了／原本hash維持を確認。96kHzと48kHzのこの指定条件での失敗であり、Soundblasterの全条件不可や前のpreview不聴の原因を確定しない。

CABLE48 record continuous-queue-v4-cable48-10s-run-4eaeadb581c444faba388d0f1c90d186はPASS。実input48000／output48000Hz・各2ch、Started48000／512、Stop保存則4項目成功。warmup後約10秒の不足callback／zeroFill／drop／recoveryは0で、callbackは前進した。glitch4→25（+21）、最大jitter10159usは別指標として残す。運転ACK後meter1件peak0、観測10秒中は通知0／peaknullであり、連続PCM・物理peak・聴感の証明ではない。Engine1／OSconsole1終了、設定／C90原本不変。

実同率の仮想endpoint連続性だけの結果で、FFT512異率・独立clock・Soundblaster・独立previewの受入へ広げない。このpassed screenへ固定した別1200秒helperを準備中。長期実行のGOはまだで、48〜72時間品質gateとは別である。

### 追加の受入確認と継続作業

上記は各時点の記録である。その後、v5の固定1200秒helperは80件のpure offline確認と独立レビューGOを得て実行中。manifest SHA256は`C190850B95321C62526798C4C8E523096E981D148E90AD432A46C7F7EBF13496`。実行終了・停止後の保存則・所有process終了・設定hash照合が揃うまで最終合格にはしない。

受入条件との再照合では、手動検証以外にも次の実装不足が残った。#38はOBS到達確認の時刻・対象・条件の記録と、設定変更後の失効、古い非同期応答の拒否を修正中。#28は従来の異率batch-ready観測が過去入力callbackの蓄積待ちを含まないため、原入力の到着区間と生成出力の対応metadataを追加する設計を整理した。処理に使われた入力区間の待ち時間と、FIR・NR・任意VSTの実信号遅延は同一視しない。いずれも設計・編集中の段階で、実装合格やIssue完了として数えない。

#66については利用者から改めて「後で手動確認する（今は未確認として進める）」の指定を受けた。200%の実DPIとNarratorは未確認のままとし、自動テストや900×600／DPR1の既存画面確認で代替完了にしない。

#38の最初の追加候補はUI31件が成功したが、独立レビューでP2を1件検出した。OBS同名ソースのdevice設定／既存filter値の変更は固定SDKで通知されず、世代だけの照合とイベント起点だけの再確認では古い成功が残る。専用readback fingerprint・表示中の単一再照合・検出した不一致のsticky失効へ修正中であり、この候補を最終合格とはしない。初回Rust compileではasync commandのbool直返しも失敗し、Resultへ局所修正した。失敗ログと旧候補は保持する。

v2候補（manifest `3743F198F671E5A3F484E1F2155286CAA9ACC7369266B209AC539A707CB4EC25`）はprivate fingerprint／sticky失効／表示中pollを追加し、対象UI35件・Rust26件・tsc／fmt等が成功。rootの全UIは93files／884件、tsc4.61秒、Vite10.64秒が成功し、301selected inputsは前後不変（manifest `660607D81F87369DF8B32FC332E17E6689AE96A5B35DABA04F93A1F8E3D4FA8A`）。main chunk787.29kB／gzip221.27kBで既存500kB警告を保持する。

独立レビューでは別のP2として、無変更の3秒pollでも確認dialogの鮮度番号が進み、dialogを読む間にpollが完了すると再確認操作が拒否される回帰を検出した。非同期応答順の番号と、実条件変更・hidden・接続・観測falseに対応する番号を分離するTS2filesの局所修正中。v2の全UI成功を修正後の最終合格へ流用しない。

Rust側は384lib tests／all-target check／strict Clippy（`-D warnings`）が成功。156selected native inputsの前後hashは一致（manifest `8A9CD3C68861169BB0F98D1F695024198F05D8D29932C57F24AF159B205DD883`）。デバイス／OTT／editorを起動するintegration testsはこの実行に含めず、実OBS操作も行っていない。以降のTS2files修正はこのnative入力集合を変更しない。

v3はTS2filesだけを修正し、正常pollと実条件失効の番号を分離した。対象30件（新4回帰を含む）・tsc等が成功、他7sourceはv2とhash一致。独立レビューはP1／P2なし、9source／実体copy／before2件とmanifestの開始終了hashを確認してPASS。manifest SHA256 `43D5B6AE8D1FDBEE29C0CB552E8B70BF26970572271B64FE4B36BF2848D54FE3`。

rootの修正後全UIは93files／888件、tsc4.94秒、Vite7.31秒が成功。301selected入力前後一致、manifest SHA256 `97252BA6B89E4D836CED5319239DA7A3F346367D77E7A6CEE8D01EB1461C31AA`。2102keysで旧2092値を保持、main chunk787.29kB／gzip221.27kBと既存500kB警告を維持。時刻・実対象・音声経路／設定・現在有効かを主表示とし、世代番号は詳細へ移した。通知もreadbackも捕捉しなかったOBS側の変更→元へ戻す操作は検出保証外であることを表示する。実OBS／機器操作や48〜72時間の品質確認は未実施。

この時点の#38候補・旧不合格候補・全UI301／native156の凍結入力と検査log、後述の限定単体比較を、別の新規zipへ保全した。`.git/issue-backlog-preserved/23d6bdd1ebbe4d53b158c343a2f791fd/selected-evidence.zip`、532files／展開時11,970,134bytes、SHA256 `8E3BA38A21E4C0B87B90FD21A4B686163D29C682EEF6EED101435512DAFA5131`。全格納hashはzipから読み戻して一致。選択した直接参照だけを保存し、全過去log／patchの網羅や後続#28実装の合格は主張しない。保全helperには同じ対象制限の下で`sourceCopy`形式への対応だけを追加した。以降は#28担当へ製品編集を引き継ぎ、#38の検証時点と分ける。

#38検証後（#28 resampling単体試験後）の追加read-only照合でも、native6・設定全inventory・C90原本・設定folder有無は20分試験時baselineと一致した。設定の書戻しは行っていない。report `issue-backlog-reach-v3-root-storage-readonly.json`、SHA256 `CFC2D79D2BC9C807BC81D72EBCB18C7B5EF917349FD78BE365838564EFF111F1`。

### v5の20分仮想endpoint連続試験

record `continuous-queue-v5-cable48-20min-run-cf078a730f334422ab4292935111d7ae/report.json`はfunctional PASS。report SHA256 `8482E84FE501EC9FEDF72EE2C6AC54344CB32130EF048379AD80ED61DE4A1DCC`。WASAPIのCABLE入力→CABLE出力、実48000→48000Hz・各2ch、要求512frames、VST0／NR／内蔵処理／残響OFF、出力gain0 ACK後に開始。2秒warmupの後1200秒、5秒間隔で241samplesを取得した。

warmupを除く受信／生成／提示／受入／要求／消費は各57,600,480frames、不足callback／無音補完／drop／recoveryは0。累積値にはwarmupの不足3callbacks・無音補完2,016framesが含まれる。callbackは120,174まで前進。停止後は保存則4項目が成立し、queue残480framesを保持、raw traceはseal済み・coverage100%。通知遅れのglitchはwarmup後+28、最大jitter11,138usで、可聴音切れの件数や原因とは断定しない。

Start ACK後meterは1件peak0、観測1200秒中の通知は0／peakはnull。ゼロ通知抑制があるため、連続PCM・物理出力・聴感の証明にはしない。所有Engine1／OSconsole1は終了、Job残0、エラー0、設定inventory／C90原本hash不変。rootもreport条件・保存則・241samples・固定binary hashを確認し、PID83128／71512の不在を確認した。独立した最終監査は別記する。

固定Engineは`5B880733…`、固定source manifestは`E389F32B…`。FFT512の異率経路は通らず、独立clockも未確認。#38を編集中の最新sourceの検証結果、Soundblaster／独立preview、CPU・音質、48〜72時間の保証へ拡張しない。

独立監査も同reportのSHA・全sampleのepoch／実rate／callback前進・warmup差分・保存則を再計算し、同率仮想endpointの20分継続観測に限定してPASS。新たな実機操作や再テストは行っていない。

### 選択した過去証拠の保全

固定native150件の証拠、2092keys時点のUI証拠、v5の直接参照と関連reportを、選択入力の静的レビュー後に`.git/issue-backlog-preserved/f3b2987267954f548b61ea25d6d280c0/selected-evidence.zip`へ新規保存した。624files／展開時76,488,805bytes、zip SHA256 `DC15D2EC8D1D0ED04DCEEF20BDA746C9EC6080551EE85CF491157F356589D932`。格納した全ファイルをzipから読み戻し、元のSHAと一致した。raw設定・journalは選択していない。過去の入れ子参照すべてや未選択patchを網羅せず、最新#38／#28の合格証拠でもない。追加の削除・移動はしていない。

### #43の確保容量に伴う限定メモリ比較

Defaultの能力上限が不明な場合に準備する65,536framesについて、`core.rs`のinput／planar A／planar Bの3領域の確保式を凍結して取り出し、同じ式を4,096／8,192／65,536framesと2／22chで実行した。standalone側は、本番の後続処理が推論するinputのf32型だけを明示した。専用allocatorでLayoutの要求生存bytes・確保／解放回数を採取し、全6条件で解放後0bytes・確保回数と解放回数の一致を確認。rustc compile／runはexit0、凍結元sourceのhashは前後一致。

| 容量frames | 2chの要求生存bytes | 22chの要求生存bytes |
| --- | ---: | ---: |
| 4,096 | 98,400 | 1,082,400 |
| 8,192 | 196,704 | 2,163,744 |
| 65,536 | 1,572,960 | 17,302,560 |

sample payloadとplanarのVec headerを含む3領域だけの値。VST／NR／他DSP／queue、allocator管理領域、Engine／Host／WebView全体、OSのcommit／WSは含めない。CPU、実機Defaultのcallback長や対応サイズ、音質・遅延の比較でもない。最大容量の確保と実callback長は引き続き区別する。reportは`issue-backlog-capacity-memory-f94120ed6b8742578a7c4527e94aa882/root-report.json`、SHA256 `9D9F007E0B3E6E7F9B18EBA3B2F97AC758ED6BE085599ECAD3B91260B6F3DCF2`。独立した静的監査は別記する。

独立監査はreportと7成果物のSHA、6条件の算術、確保／解放回数、解放後0bytesを再計算し限定PASS。headerはplanar内側Vecのheap上のheaderであり、計測対象外のstack上Vec headerを加算していない。監査での再実行はしていない。

### #4の追加LUFS計算の需要OFF／ON単体比較

通常Headerの入力／出力peak meterと、追加の音量判定・LUFSを区別する。`core.rs`は後者の測定idがある場合だけ最終出力を走査して`LoudnessMeter::sample`を呼び、非測定中はfilter／補間計算を行わない。UIから最後のOBS利用画面が消える際のdisconnectも別の寿命契約であり、この単体比較にOBSの負荷を含めない。

凍結した`loudness.rs`からstandalone用のserde import／deriveだけを除き、現DSPと既存需要guardを使って既知の固定stereo信号1秒分を処理した。48k／96kHz×128／512frames、各条件OFF／ON交互16回ずつ、warmup8区間・本測定128区間。生成・reset・表示・IPC・queueを測定窓から除き、ON側にも`black_box`の検証用負荷がある。rustc compile／runはexit0、凍結元sourceは前後hash一致。

| rateHz | blockFrames | ONの壁時計中央値／音声1秒 |
| --- | ---: | ---: |
| 48,000 | 128 | 1.780ms |
| 48,000 | 512 | 1.808ms |
| 96,000 | 128 | 3.546ms |
| 96,000 | 512 | 3.668ms |

OFFの中央値は100〜500nsで、0nsのtrialもありtimer分解能付近。この値を負荷ゼロ・CPU0%・速度比へ変換しない。meter構造体の976bytesはOFF／ONとも保持される固定領域であり、メモリ消費全体が消えるとはしない。実Engine全体、OS CPU時間、Host／WebView、OBS通信、長時間稼働、実機音質は未測定。

reportは`issue-backlog-loudness-demand-9c4a73eab03e47118052abdb885e2b9e/root-report.json`、SHA256 `D25A6A4C03AFB0B2DD949BFD2BD502E3230633AC4E9F1088A60BD1B0249505E5`。独立監査は8成果物のSHA・serdeだけの除去・原本不変・128区間集計を確認して限定PASS。全EngineのCPU／メモリ実測条件を満たしたとはしない。

### #28 phase1：入力蓄積cohortと出力buffer完了

13sourceの追加候補は対象Rust12件・UI3files／17件・tsc／fmt／diff／strict Clippy --libが成功。既存JA／EN2102値を保持し、新25keysで2127のparityを確認した。先行のresampling対象6件には7rate組のgeometry／zero・multi emit／端数carry／odd output unitのdelay floor／音声値一致／RT alloc-free0を含む。固定rubato0.14.1のconstructorとsaved_framesの実式を照合し、geometry不明・ordinal overflow・metadata欠落を音声エラーへ変換しない。

原入力callback span→内部処理unit→accepted prefixのqueue範囲→通常mic出力buffer完了を非RTで結合し、最早／最遅の到着からのframe加重分位を別DTOへ追加。`signalCorrespondence=notMeasured`を常に保持し、FIRの全support・中心reference・NR／VST／内蔵処理の内部信号点対応や加算totalは作らない。zero-fillへ入力を割り当てず、生成位置はdropを含み、queue位置は受入prefixだけを進める。

SPSC入力span／emitと出力は各1024、pending span／emit／segment／outputも各1024、drain各256・展開／join2048step、seal drain最大8回。2つの10001bucket histogramは制御側で確保する。時刻逆転・欠落・上限超過は新cohortだけを失効し、最後のtone／playbackブロックもmic扱いしない。回復skipはconsumer破棄前に失効し、停止snapshotはcacheして以後不変。実resampler＋HeapRb mapping／pop＋cohort／旧recorderを連結した`cohort_full_rt_input_resample_queue_output_path_never_allocates_or_frees`で、可変64callbacks・2rateのRT alloc/free0を確認した。

manifest `issue-backlog-cohort-phase1-manifest.json` SHA256 `F53852B88DB904230C593EB6C68BEC5D2AFCCCC2E78101895FB30B1DACEE8523`、patch SHA256 `48CE6A747AF34B7E67B236A8E30B697181FCE648EE0E9BD47EBFE3A021CA8E50`。独立レビューは13現物／before・final copy／patch／8logs／verification／依存参照の開始終了hashを確認して、phase1限定PASS。tsc／fmtのTee log未生成は存在するlogとせず、実行のexit0記録として扱う。初回保全copyのpartialも保持した。音声数値・旧raw／batchの意味とoptional旧DTO互換を維持した範囲で、実機・新bin・性能の証拠はまだない。

このsliceはDSP／入力条件変更後に新cohortを安全に失効し、再Startを待つ制約があった。#28全体の「設定変更後の無効化と再集計」には足りないため、streamを止めない新観測窓への切替を次sliceで実装中。同率旧rawの終点はqueue read完了のままなので、その旧分位を変えず、同率にもbuffer完了までの別観測を追加する。段別の申告／不明・動的VST／NR各モード・instrumentation負荷／実機も後続であり、phase1だけで#28完了にはしない。

### #48／#28：NRの実稼働rateと単体試験の追加照合

少数の静的読取りでは、Start全体に192kHz上限の明示拒否はなく、API／保存値／既定設定からデバイス能力内のrateを選ぶ。通常UIの候補は44.1／48／96kHzのみであり、実384kHzの機器でStartが成立するかは未確認。一方、出力が仮に384kHzで開始した場合でも、現coreは共有`rt_sample_rate_hz`を192kHzへclampしてNRへ渡す。NRの1920samplesは実出力では5msに相当し、ストリーム全体を192kHzへ変換する処理ではない。

NR単体へ384000を直接渡すと3840samplesとなるため、その単体試験をruntimeの384kHz検証とは扱えない。これは通常設定で実症状が再現した証拠ではなく、API上成立し得る条件のコード不一致。後段でNRへの実rate適用と対応範囲外の明示的な扱いを最小修正し、表示もoutput nominal／NR設定rate／frame時間を分ける予定。tone／voicecheck／captureも共有値を使うため、一括のclamp削除や未検証範囲の無制限拡張はしない。実機・アルゴリズム変更・試験はこの追加調査では行っていない。

### #28 phase2a：継続streamの観測窓切替と同率buffer完了（限定PASS）

同じ音声制御FIFOで通常変更の直後に固定markerを送り、要求／完了／RT適用／拒否と観測窓serialをschema2へ追加した。FIFOが詰まった場合は既存pendingで待ち、観測markerの都合で通常操作の結果を失敗に変えない。新窓では制御側のCDFだけを初期化し、過去入力・resampler carryのordinalと音声streamを維持する。`applied`はRTでの受理・状態更新であり、平滑化・crossfade・VST内部処理の完了保証ではない。

同率にも原入力spanから通常mic出力buffer完了までの別観測を加えた。旧rawのqueue read終点と旧batch値は変更しない。tone／録音再生の最終bufferを含む差替え中はmic分位を出さず、通常micへ戻ると新窓で再開する。metadata欠落・overflow・時刻逆転・回復skipは設定変更で消えず、次Startまで恒久失効する。ring／pending／drain／joinの固定上限はphase1から維持し、CDF初期化は非RTで行う。

対象Rustはcohort15件とframe_timing34件（範囲が重なるため合算しない）、UI3files／20件、tsc、strict Clippy `--lib`、scoped rustfmtが成功。窓切替を跨ぐcarry、同率部分読出しと旧rawの別値、連結RT alloc/free0を含む。旧JA／EN各2127値を保持し、9keysを追加した2136のparityを確認。13before／final（変更9）・patch・verification・実log4件を固定し、manifest SHA256 `7951562FECD6818C9E5518055BFC3287A49807C0EDDF55F0858F524A5ABF88B4`、patch `80C3FAFB26694D104B7BAD3D2179651213D7C1F7EEF2D950DA5D4D6E49866E1F`。tsc／fmtの空出力logは存在せずexit0記録として扱う。独立レビューはP1／P2なしのphase2a限定PASS。13現物／copy／patch／verification／実log4件の開始終了hash一致と、元操作・marker順序、旧carry、恒久失効、UI世代、旧raw互換を確認した。前sliceの再Start待ち・同率終点不足は解消したが、現sourceの実機・負荷・長時間、phase2bの段別補足とNR修正、#66は未確認。

### #44 過去の復元計測の比較条件を再照合

private保存済みのrestore-benchmark report10件をread-onlyでbinary SHA・atomic方式・host・要求rate／buffer別に分け直した。3種類のEngineが混在し、旧ASIO2件は要求rate／buffer欄がない。全reportにerror記録はなく、VSTなし0件・初回と同process再ロード2件の管理数が記録されている。2VSTの復元要求は旧方式10回、新方式2回だが、同一binary・同条件・複数trialの方式比較にはなっていない。過去の1回ごとの時間を束ねた速度改善率や最新sourceの効果は主張しない。

必要な追加比較は、最新固定binaryでprocess初回／同process再利用、VSTなし／2件を分けること。OS cacheの強制消去を伴わないため真のcold起動とは呼ばない。旧helperはraw stderr／errorを保存しJob所有制約もないため、そのまま再使用せず、有界な数値phase記録・所有processの回収・設定原本の前後照合を準備してから実行する。今回の再照合ではnative起動・設定変更・追加計測は行っていない。

### #28 phase2b／#48：段別補足と実出力rateのNR準備（限定PASS）

`latencyMetadata.stageBreakdown`をoptionalで追加し、RuntimeStats照会時のVST申告・NR frame周期の計算・内部信号遅延の不明を並列に扱う。VSTは単一getter巡回で旧小計と段別を生成し、SDK申告0とprocessor不在null、bypass／mute／global bypassを区別する。旧小計のmute包含と飽和を維持し、新しい実測totalへ加算しない。照会時点の申告取得は、RT適用確認・GUI変更通知の鮮度保証ではない。停止／異常／旧DTO／epoch不一致では現在値を隠す。

NR専用checked factoryへ実際の出力rateを渡し、数値対応8k〜384k／最大3840framesへ制限した。対応rateではOFFでも開始前に確保し、後のON／OFF／resetでRT確保しない。Startと両setterは有効化の拒否をstate／queue更新前に行い、停止中は最新意図だけを保持する。NR範囲外のOFFはNR専用拒否を増やさない意味であり、既存Reverb等やデバイスを含む任意rateの開始保証ではない。共有tone／voice-check／captureのclampと既存mix式は変更していない。最大61440Bは可変4配列payloadのみで、モデル／固定配列／headers／allocator等を含む総NR保持量ではない。

対象Rust latency8件・DSP11件、UI2files／9件、tsc／strict Clippy `--lib`／scoped fmtが成功。fake VSTの申告変化・削除／再挿入、実NR factoryのframe／有限値／RT alloc-free0、旧≤192k constructor状態と同じ既存DSPの出力一致を確認。独立した音質検証ではない。最終Rust対象後のcurrent gateへのfault条件追加はstrict Clippyで確認し、最新全体テストは後段へ残す。旧JA／EN2136値を保持した2149keys、初回compile失敗logも保持した。

16before／final（変更14）・patch・verification・実log7件を固定。正式manifest v2 SHA256 `33D4FF48182677FC793D622AA9CC91B38D9E227E2690006D0513468A83B8D7BB`、patch `8278AB341A3601D53F5C3DD335E21C0C72BE0AF9B0E18582E7812315CB68AFCA`。初版manifestのapi.current例示falseは条件説明へ訂正し旧版を保持、source／検証は同一。独立レビューは開始終了hash一致、P1／P2なしの限定PASS。実VST GUI／preset復元、実Start・fallback・384k機器、全Engine負荷・保持メモリ・長時間・聴感・物理遅延、#66は未確認。

### #44 固定binaryの再比較helper（実行前の限定PASS）

新private helperを準備し、rootレビューで復元期限12000msがbackend上限10000msに違反する点、同期stdin送信で期限判定へ戻れない点、Job割当失敗時の作成process回収漏れを修正した。8000ms期限、単一inflight送信と応答の共通期限、Job所属後はJobのみの終了、割当未成功の場合だけ保持creation handleを回収する境界を設けた。IO終了未確認の場合は、そのIOのlockを取り得るcloseで再度待ち続けない。

独立レビューでactual条件が違っても比較PASSになり得る点を確認し、v5でStarted48000Hz／512構成値と実入出力48000Hz／2chを各case必須にした。可変callback長／count／epochは一致条件へ混ぜない。旧／atomic各5fresh processを交互に実行する設計で、各processのVSTなし開始後に2件の初回復元／同process再復元を測る。2VSTを先に復元するfresh-first Startと、OS cacheを消去したcold比較は含まない。phase時間は重複加算しない。

構文・offline12項目が成功。v2〜v4と失敗根拠を保持し、v5 helper SHA256 `12E7296CB1A4507E2155CB93881043913106B57D0C50211191BCB4174525F826`、manifest `C4F971306868F5A5164035C3F6007D3B4F7DDFB0B61A3D8DC2ABB4931C8F3E88`。独立レビューは開始終了SHA一致・残る実行前阻害なしの限定PASS。ただし最新binaryとsource／buildの実際の対応、Win32／Jobの実動作、物理的無音・音質・全Host性能は未確認。最終source freeze後にrootがbuild／bindingを確認して実行するまで、preflight／nativeは未実行である。

### #28 観測追加の比較fixture（静的準備限定PASS）

旧phase1前のframe_timing／resamplingと、新cohort追加後の原文をimmutable copyで読み、実resampler・HeapRb・mapping／popを使って旧／新／観測OFFを比較するprivate fixtureを準備した。48k同率・44.1→48・48→44.1、2→2ch／22→22ch、固定callback系列の3trial。音声hash／保存則を共通条件として、CPU通常allocatorとheap追跡binaryを分ける。RT区間、非RT drain／snapshot、窓切替、sealの包含区間を明記し、重複加算しない。通常mic・単一threadの合成モデルで、実FIFO満杯／source差替え／skip／実機deadlineの測定ではない。

独立初回レビューのP2は、停止cache後の保持量がなかった点と、compile失敗時にlinker子が残り得る点。v2でdrop前の`heap_after_seal`を追加し、compiler／fixtureを新規Jobで管理して子回収とmembership0を確認する設計へ修正した。割当未成功時だけ保持creation handleへfallbackし、IO終了未確認のcloseで再blockしない。旧候補を保持した。

v2 manifest SHA256 `D928D0ACED1B778D2D7F9FE9729FCCF12D96F82A85F57F86FCEF0D9AE6F25E68`、runner `AEB43808DC7D0B7F696BE33DE3C6071F2522FDD9EFB3E713C439F25ADB860657`、harness `B966CAD34F1F71D739B676FC36FE50D1D87A2219F1FDBFF143AB115B5853DA5B`。Python構文・offline構造とmock4件が成功。独立再レビューは14成果物・8原文／copy組の開始終了SHA一致、2指摘解消の静的準備限定PASS。rootのrelease依存binding、Rust型／link、実Job、fixture実行、性能／保持量の実測は未確認である。

### #30 希望と録音評価によるv2候補・最終統合検証（10月24日）

- 5項目の希望（強弱・低域・明るさ・部屋の自己申告・残響）とrevision／ruleVersionを録音候補へ固定する。省略された旧要求はv1を維持し、不完全なv2要求を拒否する。希望変更だけで生成・再生・適用しない。
- raw録音の共通20ms活動maskでHPF40／60／80／100Hzとdynamics候補を比較し、安全条件を満たす弱い設定を選ぶ。未達は理由へ明記する。部屋は自己申告であり、自動推定・本人に最適な音質とは扱わない。音声処理の二重適用や最終clampによる改善判定を避ける。残響の余韻を含む容量を超える場合は切詰めず拒否する。
- 独立レビューのP2（旧取消失敗が新しい候補／再表示した画面を無効化する競合）をcontrollerとflow revisionで遮断。旧コードで新規2回帰が失敗、修正後は2件と現在の取消失敗の警告対照1件が成功。修正の独立再レビューは重大な未解決指摘なし。
- frozen manifest：`issue-backlog-proposal-preferences-manifest.json` SHA256 `A8A18FEF2887E49B32D661CA4226F39D7FD5F533B58398C7DF0DE0C373991D5B`、UI取消修正v2 `F951EBD5015BD3EA7DEB6E608D1B09C3A25C825A8231765B923FE0C0BF969881`。旧日本語／英語2149値を保ち2181keyへ追加。
- root最終UI：95files／909tests、tsc、Vite成功。307選択入力が検証前後で一致。manifest SHA256 `428077F396ACE7FFB5D21DC40E7B20DC9FD142905C89EA386C1C2163012ED340`。Viteの既存500kB warningは残る（main810.12kB／gzip227.88kB）。
- root最終Rust：lib416、audio_queue_contract2、MSIX共存2が成功。bin unit6対象は0件成功、子プロセスprobe件数は親へ二重加算しない。all-target check／strict Clippy成功。163選択入力は前後一致、manifest SHA256 `E8D74813642F17931A6E30D9EDEAACC22F03B889F42BAAC1CBCD633E57289305`。実機・OTT・editor integrationはこの最終safe suiteへ含めない。
- release Engine build成功（389.73秒）、固定SHA256 `8E21663224684FEDE2A08BCEA1A5E24B6068ABBA0FF74A015141ACFAC740C1E1`。debug Host build成功（101.11秒）、固定SHA256 `587B03EF58AF51DB0C253E7BA29F717D80EE4BCE7BB6657071BA216EF3687085`。両build中native／UI選択入力は不変。Hostの同一専用folderへ最新Engineをコピーした。インストーラー生成・公開・元sidecar置換は行わない。
- `npm run test:release` 51件成功、`npm run release:check` PASS。これは配布条件の静的確認であり、署名・Store・公開済みartifactの検証ではない。

### #44 最新固定release Engineによる5組の復元比較

- v5／診断v6の初回試験は通常のRackBusyを単一期待で拒否して失敗。失敗記録を残し、v8でRackBusyだけを最大5秒pollする。送信・応答・ready採用の同じ絶対期限と、全体180秒／160要求を維持する。期限漏れのレビュー指摘を修正し、offline14件・独立静的レビューPASS後に実行した。製品コードは変更しない。
- `issue-backlog-restore-compare-v8-run-eec41ecb19c846ac85a104661a12f6d1/report.json` SHA256 `CE4D7710C9EFEDCA434C4B4904EEDD143FB3FA228212FC8C00C399B0DFD502C3`。同じ固定Engine、WASAPI CABLE48kHz／512指定・実2→2ch、出力gain0＋muteを開始前ACK。legacy／atomicを交互に各5新processで実行し、各processのVSTなし開始→停止→2件初回復元／開始／停止／unload→同process再復元を全て確認した。
- 復元要求は2件分でlegacy10→atomic2。保存stateの読戻しは両方式・全20復元ケースで原本のbytesと一致。停止中rack intent／実際の開始rate・buffer・chも全て一致した。10親process・観測済み子handle・IO終了とJob終了API成功を確認。membership0のreadbackはこの比較reportにはなく、Job0実測とは扱わない。設定inventory／C90／固定入力不変。
- 中央値ms（legacy→atomic）：初回dispatch196.437→191.489、初回rack-ready288.044→191.740、初回Start81.337→78.398。再復元dispatch178.018→182.088、rack-ready278.981→182.315、Start77.409→77.670。rack-ready値は100ms間隔の観測待機を含む。dispatchだけとreadyまでを同一指標にせず、差を一般的な速度改善率へ換算しない。
- noVST Start中央値135.454→135.136ms、atomic側最大198.800ms。ばらつき・小標本・順序・OS cacheの影響を含む。2VST初回Startは同processのnoVST Startでdeviceを温めた後であり、OS cold／2VSTが最初のStart／物理遅延・音質・長時間の代替ではない。

### #28 観測処理の単体負荷・保持量（最新原文を固定、10月24日）

- private v3 fixtureの初回compileはE0583／E0282で失敗。`frame_timing.rs`内のsubmoduleの相対配置を、原文byte不変の`frame_timing/mod.rs`＋同階層`cohort.rs`へ直したv4でcompile-onlyと本試験が成功。製品の型・処理は変えていない。初回失敗と後続成功は別記録を保持する。
- 実release buildのCargo artifactとfingerprint依存edgeを照合し、6direct crateと38artifact closureを選択。専用directoryへ76files／336,929,308bytesをコピー・SHA確認した。既存release/depsの全3829filesコピー・削除は行わない。実rustc／lock／build／Cargo JSONも固定。mixedにはproc-macro側opt0を含み、direct6はopt3。
- 実行report `issue-backlog-timing-cost-v4-run-ef84ef1d56194d8397b9a2ee0edc2fc2/report.json` SHA256 `D9155F876CAB9331688ED57990A0BC5F928E892735369D9BDD3714B168D66FD3`。CPU result `1034CE698C453AFAEC3E67417D71DA2F4C4CBA2DC6999293D6DD09B811812FBF`、heap result `DFC71D1923C18D286AD98B8FC05C27A46DF4EAF7864A7D54F59D9DB3ADF3319F`。
- 従来観測／新cohort観測／OFF、48k同率・44.1→48k・48→44.1k、2→2／22→22ch、各3trial交互順。各trial128warmup＋2048callbacks（128／512／1024frames混在）で実rubato・HeapRb・queue mapping/readを行う。CPUとallocatorのbinary／runを分けた各54rowsで、3方式の既知PCM checksum同一・保存則が成立。新cohort invalid bits0・window completion成功。全heap rowsでRT alloc/free0、破棄後live0。
- seal後に残る要求生存量bytes（OFF／旧／新）：2ch同率57,863／489,670／1,019,471、2ch44.1→48k101,945／533,752／1,063,551、2ch48→44.1k101,321／533,128／1,062,927。22chは同率631,303／1,063,110／1,592,911、44.1→48k910,765／1,342,572／1,872,371、48→44.1k901,821／1,333,628／1,863,427。Allocator Layoutのfixture全体であり、純粋な観測structだけ／OSメモリ／Engine全体ではない。
- callback2048回合計の新−旧壁時計差は、2ch48k同率の3trialで+239.3／+1,189.0／−815.9µs、22ch44.1→48kで+4,950.3／+4,461.6／+2,210.3µs。他条件にも正負のばらつきがある。3標本を速度保証へ換算しない。生成・PCMhash・制御処理はRT計時外、window完了はcallback内包、sealは内部drainを内包するため足し算しない。
- single-thread固定fixtureであり、実OS callback競合・whole Engine CPU・VST／WebView／OBS・deadline保証・独立clock・長時間・実信号遅延を測定したものではない。compiler／fixtureの全4実行はJob0／所有終了確認、入力不変。

### #28／#30／#48 最新固定release Engineの既知信号smoke

- v2／v3の失敗は録音metadata.hostの正式値`WASAPI`を、要求host名`Wasapi`と誤比較した検証側条件による。製品は変更せず、v4で要求名とmetadata名を分離し10条件を個別照合した。初回のre import漏れとsignalCorrespondence wire値の不一致も検証側で修正し、旧版／失敗記録を残した。
- helper v4 SHA256 `546FE252263EFD46905D3FB4A19E3EC5DA39EF7CDF67785DFF5FAA4B0EF3EAF6`、manifest `B95F4B3A50CF5ECF0D334105260807D255CDA866989E982D6A266DED414C0B7A`。実行report `issue-backlog-latest-engine-smoke-v4-run-499205b86dce4c1c82d7f8c13d5f281d/report.json` SHA256 `487DEF5EEE142D5B6796F90CB07E7BCC2C2DB72A5A42A6733CD1EA3CB6F6B009` はPASS。
- 同じ固定Engineを各新Jobで起動し、CABLE48kHz／512指定・2→2ch。mainのgain0を開始前ACK、global muteはfalseで通常mic処理を通す。先にmainだけでinput gain1→0.5→1の3窓がrequested／completed／appliedまで進み、cohortに通常mic・一致frame・同epoch・信号対応未測定を確認。NR OFF→low→high→OFFの4条件は実rate48k／frame480／10ms、current段別情報と一致し、測定totalの追加なし。
- 次にsourceを別Jobへ起動、入力gain0を開始前ACKしてfeedbackを防止。8kHz指定・-34／-28／-22dBの各1秒信号を6秒録音へ送出。静かな前後のenvelope peak0、3段peak0.017326355／0.0345726／0.068977356、段階上昇を確認した。envelopeで周波数を測定したとは扱わず、PCM／生envelopeは保存しない。
- 同じsealed録音で希望2種を生成しv2希望／revision／録音／設定世代が一致。旧候補IDを拒否して最新候補を保持、分析だけで現在設定を変えず、誤recordingIdと古いCAS revisionを拒否。再prepare後の正しいApplyはRT適用まで確認し、Undo後のconfig hashは試験前と一致した。
- main61要求／source8要求。両Engineの所有終了・Job0・IO終了・error flags0、設定inventory／C90fixture／固定ソース・binary不変。Hostの保存・OBS・物理試聴・本人歌唱・実384k／fallback・独立clock・長時間はこのsmokeの対象外。Soundblasterの可聴性と#66実DPI／Narratorの未確認は解消していない。

### 最新Hostの実画面と検証後の設定復元（10月24日）

- 最新固定debug Hostと同folderの最新release Engineで、900×600・DPR1・ゲーミングテーマを確認した。#30の5希望値は日本語／英語切替後も同じdialog内で保持され、各selectへscroll／focusして操作できる。#28の停止中の遅延・段別・cohort説明も両言語で確認した。4枚の実画面を保存・目視確認した（内容はJPEG/JFIF、原ファイル名の拡張子`.png`は維持）。実行report `issue-backlog-final-gui-v6-run-5ed62e68791b464b803fcb1b4e3273b5/report.json` SHA256 `82D6BC7EFDA165635561D558CD12F0678EFCEDC5CB648427580CB4009EE4D990` はUI範囲PASS。
- このGUI試験では録音・試聴・適用・OBS操作を行わない。起動warmup後はStop／gain0／muteをACKした。実DPI・OSキーボード・Narrator・動的VST GUIの受入ではなく、#66は利用者指定どおり後日手動確認・現時点未確認のまま。
- 終了前の同contextでは全保存mapが一致したが、別Host寿命の確認で、試験の言語切替が作成した`vst_host_locale`だけが残った。原本ではこのkeyは未存在で、他21keyの値は全て完全一致。失敗reportを保持し、終了前一致だけを再起動後の保持証明としない。終了境界のWebView保存反映と整合するが、原因は確定していない。
- 独立レビュー済みの限定修復で、原本全map・差分1key・その値hashが全て一致する場合だけ試験由来locale keyを削除した。他の値は書き換えず、削除前を新private journalへ保存。inert画面で1秒以上の間隔を置く15回の全map照合が成功した。修復report `issue-backlog-final-gui-storage-proof-run-b9f7e7c066634f4b985d0785aa4a4949/report.json` SHA256 `6C0CFFE04340FC71A03B22409565D6394BDE4DF76A82301BE3AF372BAB850116`。
- さらに新しいHost寿命のLS書込みなし確認で、21key全てのraw文字列が原本と一致した。report `issue-backlog-final-gui-storage-proof-run-9cd2ccd21b9c48af968090164061b39b/report.json` SHA256 `6D67B49D554044D10E105DFA8E06ADFDD704E4EC766BF3101908FAA767368FD9` はPASS。確認はStop／gain／muteのIPCを含み、読み取り専用IPCだけの起動とは表現しない。
- GUI・修復・別寿命確認の各所有Jobはmembership0、親終了、IO終了を確認。終了後にnative6のbytes／未存在とconfig inventory、C90原本、固定ソース／binaryの一致を確認した。元ASIO96kHzストリームは停止したままで、再開済みとは扱わない。raw保存値はprivate recovery journalだけに保持し、通常reportや選択archiveへ含めない。
- 最終再照合でもUI307／native163の現物と固定copyに変更なし。`git diff --check`成功（改行変換の既存warningのみ）。branch／HEADは着手基準のまま、未反映の既存9commitを保持した。ステージ・commit・push・PR・Issue更新／closeは行っていない。

### 承認済み4箇所の補助文整理（10月24日）

- 外観の汎用的なテーマ説明と発光の重複を削減。ボイスチェックの副題を削り、短い録音範囲を常設して、詳細な対象範囲と接続診断の違いを標準のdetails／summaryへ整理。希望欄の操作列挙を削り、OBSの可視ラベルを「連動方式（1つ）」へ統合した。入力名・選択状態・fieldset名・aria名、開始／保存／候補失効の条件は維持した。
- 実装・既存範囲テストの変更は5ファイル。日英各2183keyの一致・重複なし、全UI95files／909tests、tsc、Viteが成功。既存のbundle size warningのみ。UI307入力の現物と固定copyは検証前後一致、manifest SHA256 `94F1D7C4C7C84DFA3E427AFCF0FB6617EEFEB0CC7A982990999F3515ADADF333`。native163入力は不変でRust再buildは行わない。
- 製品差分は独立限定PASS。GUI helper v1は裸の文字列のtransport解釈でテーマ判定に失敗したため、その失敗を保持し、構造化object戻り値に直したv2で再確認した。製品コードの追加修正や検査条件の緩和は行わない。
- 最新Host＋固定Engine、900×600／DPR1／ゲーミングテーマで日英8画像を目視。説明の閉→開→閉、希望5ラベル、OBSのタブ・可視ラベル・aria名、テーマ名・選択状態と重複文の非表示が成功し、独立目視も限定PASS。report `issue-backlog-copy-tidy-v2-run-5e69a1faf75143a18868071a972b5495/report.json` SHA256 `09085A6632D08EB2F37FE601FE002CE5CB03B4EFEA168FF1E6E3AFFBCD937B7B`。
- GUI終了後に原本全mapを復元し、さらに別Host寿命のLS書込みなし確認で原本21keyのraw文字列が全て一致。proof report `issue-backlog-final-gui-storage-proof-run-ec110db66442446f9190bca931637ae3/report.json` SHA256 `D4A858360CE114E40C2E438A29D95FB453E0A441B56D8AF8315D0649C8BAF913`。両確認の所有Job0・IO終了・native6／inventory／固定入力一致を確認した。元ASIOストリームは停止中。実DPI／Narratorは引き続き後日の手動確認であり、push／PR／Issue更新・closeは行っていない。

### PR前の独立レビューと保存サイズの整合修正（10月24日）

- 独立レビューで、配信状態の保存は成功するのに64MiB超では読込みを拒否するP2を確認した。保存／読込の共通上限を設け、シリアライズ後・一時ファイル／保存原本への書込み前に超過を拒否する。上限ちょうどの保存と読戻し、過大な新規保存の拒否、過大な上書きで元のbytesを保持する回帰テストが成功した。
- 修正後のsafe Rust suiteはlib417・audio_queue_contract2・MSIX共存2が成功。all-target check／strict Clippy／rustfmtも成功。実機・OTT integrationをこのsuiteへ追加していない。
- 全UI初回は遅延import待ちの既定1秒でSettingsNavigationの1件が失敗した。単独6件の成功とSuspense待ちのDOMを確認し、初回dialogの表示完了を最大3秒待ってから操作するテスト同期へ修正。製品遷移は変更せず、最終は95files／909tests、tsc、Viteが成功した。既存のbundle-size warningのみ。
- 新規3ファイルの空白エラーを整理。検証helper・退避した設定／録音・過去build・rootのtargetはPR候補から除外する。既存9commitを含む全差分をレビュー対象とし、未完了Issueの自動closeやリリースは行わない。
