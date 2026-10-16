# DSP初回処理とresetのRT割当対策

2026-10-16。基準HEADは`c413fb2`（PR #13マージ後）、作業ブランチは`codex/dsp-rt-allocation`。開始時にクリーンなmainとorigin/mainの一致を確認した。

## 固定依存と原因

対象はnnnoiseless 0.5.2、easyfft 0.4.2、realfft 3.5.0、rustfft 6.4.1。
easyfftはFFT計画・入力コピー・scratchをスレッドローカルに遅延確保していた。
別スレッドでのwarmupは実際の音声スレッドのキャッシュを準備できない。
またRtNoiseReducer::reset_stateは2つのDenoiseStateを再構築して置換しており、
Box・モデル状態・作業バッファの確保と旧値の解放をRT側で発生させていた。

## 局所修正

`third_party/nnnoiseless-0.5.2`へ固定版の公開crateを保持し、実行時依存だけをこのローカルソースへ接続した。
dev-dependencyのnnnoiseless_referenceは未修正のregistry版0.5.2で、比較にのみ使う。
Cargo.lockでは2つの取得元を区別する。他のcrateのバージョン・チェックサムは変更しない。

- FFTは従来と同じrealfft::RealFftPlanner・process_with_scratchを使用する。
  各DenoiseFeaturesがforward／inverseの計画、入力コピー、複素数出力、scratchを構築時に所有する。
  入力コピーと逆FFT前のスペクトルコピーは元のeasyfftと同じ方針。
  forward結果は一時領域から既存DynRealDftへ追加でコピーし、公開の形式と周辺演算を維持する。
- 共有の窓・DCT表は構築時に準備する。実稼働状態でのwarmupや無音フレームの先行処理は行わない。
- DenoiseState::resetはモデルを保持し、gain、RNN、pitch、特徴量、履歴、合成、FFT作業領域をnewと同じ初期値へ戻す。
  所有領域の再確保・置換・Dropは行わない。状態フィールドを列挙した分解で初期化漏れを検出する。
- アプリ側は従来のreset_stateのタイミングと順番を維持し、その中でstate.resetを呼ぶ。
  コマンドのpayload・制御順、レート変換・mix・clamp、ゲイン、DSP係数・モデルは変更しない。

構築時の計画作成と各状態が保持するメモリは増える。forward結果の追加コピーもあるため、実機CPU負荷の同一性は主張しない。
構築・Clone・最終破棄は非RT側で行う前提を維持する。
新しいFFT処理にunsafeは追加していない。固定長の計画・領域が一致しない場合のexpectは内部不変条件の検査であり、
モデルや係数を代替するフォールバックではない。

## 原本・ライセンス・配布

原本crateのSHA-256とVCSコミット、各ファイルのハッシュ、変更内容はvendor内のPATCHES.mdとUPSTREAM_HASHES.jsonに記録した。
元のCOPYING・AUTHORS・README・Cargo.toml.origを保持する。7つの既存ファイルに限って変更し、FFT用ファイルと保守記録を追加した。
モデルweights.rnnと他の原本ファイルのバイト一致を確認した。窓・正規化・RNN・pitch・合成の既存演算行は変更していない。

NOTICE.mdとSOURCE-DISTRIBUTION.mdへローカル修正の場所と同梱条件を明記した。
vendorのテキストをLF、モデルを-textとして明示し、Windowsでも原本照合とモデルのバイナリを維持する。
既存のソース生成テストにローカル依存のCargo.toml・COPYING・FFTソース・モデルがアーカイブ内で一致する確認を追加した。
最初の試験ではfixtureのテキストがGitのCRLF変換を受けて失敗したため、実vendorと同じ属性をfixtureにも適用し、再試験が成功した。

`cargo about generate --locked --fail`は成功。既存ライセンス本文と、重複を除いたライブラリ一覧は同一だった。
dev比較版によりnnnoiselessの同一内容の行が1件増えるだけで、既存のライセンス表示は両取得元を同じBSD-3-Clauseでカバーするため変更しない。
本番のnormal依存ツリーはローカル版だけを選択することも確認した。

## 比較検証

- 新品の状態を呼出側で構築してから、新規処理スレッドへ移送する。candidateの初回処理を測る前に参照版を処理しない。
  6種の有限PCM入力×32フレームのサンプルとVADをregistry版とビット比較し、一致した。
  candidateの各処理は確保・解放0回。参照版の初回に確保が発生することも陽性対照として確認した。
- defaultモデルと、テスト内でVAD biasを変えたownedモデルで、0／1／7／32フレームの使用後にresetし、新品のregistry状態と32フレームずつ比較。
  サンプル・VADが一致し、resetと以降の処理は確保・解放0回。DenoiseStateのBoxアドレスも維持された。
- 借用した独自モデルでも3回のreset後にregistry版とビット一致。独自モデルのVADが標準モデルと異なる陽性対照を置き、標準への意図しない置換を検出する。
  係数変更はテスト内のコピーだけで、同梱モデルは変更しない。
- 7フレームの履歴をCloneし、元の状態をreset・追加処理・破棄した後、新しいスレッドで複製側を処理する。
  元の履歴を維持したregistry版とサンプル・VADが一致し、複製側の処理も確保・解放0回。
- アプリのRtNoiseReducerを8k／44.1k／48k／96k／192kで、0／1／440／480／511／2000サンプルの後にresetする。
  各8192ステレオサンプルを新品のreducerと比較してビット一致。部分フレームの履歴も初期化され、対象処理・resetで確保・解放0回だった。

原本との差分とログはignoredのsrc-tauri/target/dsp-rt-*へ保存する。比較テストは
src-tauri/src/audio_engine/core/dsp_rt_tests.rsに保持する。

## ローカル検証結果

- `cargo test --locked --lib --bins --test audio_queue_contract`: lib 51件＋queue 2件成功。
- `cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの寿命・状態保存・メモリ内無音処理1件成功。合計54テスト。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json -- -D warnings`、`cargo build --locked --bins`: 成功、Clippy警告0件。
- `npm run test:release`: 27件成功。`npm run release:check`: PASS。
- `cargo about generate --locked --fail about.hbs -o target/dsp-rt-licenses.json`: 成功。ライセンス本文・重複を除いた一覧の一致を確認。
- 最新debug/audio_engineでOTTとTDR Novaの開閉各3回、二重表示防止、リサイズ、表示中アンロード、応答継続を確認。音声Startは送信していない。配布用sidecarは更新していない。
- `git diff --check`成功。製品の変更箇所・新規ファイルとvendorのパッチ部分だけを整形し、upstream本体の一括整形は行わない。

初回のCargo.checkはパス依存で顕在化したupstreamのcargo_c cfg警告を出した。
既存cfgをcheck-cfgへ登録してから最終checkと厳格Clippyは警告なしで成功した。
all-targetsのコンパイルだけを確認した実機integration_test・repro_ottは実行していない。

## 差分レビューの結果

同日のレビューでは、固定版の29ファイルの原本ハッシュを再照合し、既存ファイルの差分が上記7ファイルだけであることを確認した。
resetの全フィールドとnewの初期値、FFTの960点・481複素数・forward／inverseの最大scratch長、所有バッファと共有する不変のArc計画を照合した。
係数・演算式・初期状態の変更や、対象処理中の再確保・解放に関する修正必須の不具合は見つからなかった。

検証の不足として、同じ係数のownedモデルだけでは標準モデルへの置換を検出できなかったため、独自モデル・借用モデルの保持とClone後の寿命を上記のテストで補強した。
ソース配布テストもPATCHES.md・UPSTREAM_HASHES.jsonのバイト一致を追加し、変更記録の同梱を確認した。
レビューではRustの54テスト、all-targets check・厳格Clippy、配布の27テスト・release:checkを再実行し成功した。
ログはsrc-tauri/target/dsp-rt-review-*に保存した。製品コードに追加修正はなく、build・GUI開閉は実装時の同一製品ソースによる確認結果で、レビューでは再実行していない。

提出前の独立検証でも54テスト・配布27テスト・check・厳格Clippy・debugビルドが成功した（ログはsrc-tauri/target/dsp-delivery-*）。
同梱ファイルのステージ後、通常のdiff --checkは未変更のupstream train/dump_rnn.pyの末尾空行1件を検出した。
原本ハッシュ一致を保持するため整形せず、この1ファイルを除いた候補全体の差分チェックは成功した。

## 適用範囲と未検証事項

成功範囲は上記のDSP初回処理・連続処理・resetで、音声コールバック全体の無割当・無Dropを保証しない。
実機WASAPI／ASIO、実音声・音質・CPU・遅延・デバイス切替・長時間、他CPU／OS、release最適化、インストーラ・署名配布は未検証。
比較はサポート環境上の有限PCMと既存モデルを対象とし、任意モデルや非有限入力の全組合せの証明ではない。
vendored crateの未使用bin／dasp／train／capi featureは検証対象外。公開crateにはtest_dataが入っていないため、upstream単体テスト一式の成功は主張しない。

FFTは[realfft 3.5.0のprocess_with_scratch](https://docs.rs/realfft/3.5.0/realfft/trait.RealToComplex.html)の公式API文書と、
固定中のeasyfft・nnnoiselessのregistryソースを照合して実装した。
実装・レビュー段階ではcommit・push・PR作成を行わず、以降の提出はユーザーの明示承認後に行う。
タグ・公開・デプロイはこの対策の対象外。
