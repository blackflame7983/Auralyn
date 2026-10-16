# RT割当・Drop制約の段階的対応

2026-10-16。基準HEADは`577752e`（PR #12マージ後）、作業ブランチは`codex/rt-allocation-lifecycle`。開始時の作業ツリーはクリーン。DSP係数・演算式・DSP初期状態・依存バージョンは変更しない。

## 今回の段階

入力リサンプラーのコールバック内割当と、異常なAddProcessor拒否時のDropを修正した。DSP初回処理はスレッドローカルなFFTキャッシュの初期化が原因と確認し、低影響の事前処理では解消できないため本段階の未解消事項として残す。コールバック全体の無割当・無Dropを達成したとは扱わない。

## 入力リサンプラー

固定中のrubato 0.14.1のResampler::processは出力のVec<Vec<f32>>を毎回確保して、内部でprocess_into_bufferを呼ぶ。加えて、従来のStreamResampler::processはinterleave用Vecを確保・拡張し、入力コールバック末尾でその出力を破棄していた。

同じFftFixedIn、1024フレームのチャンク設定、sub-chunks=2を維持し、構築時にoutput_buffer_allocate(true)と最大1チャンク分のinterleaveバッファを確保する。新しいprocess_intoはprocess_into_bufferの実出力フレーム数だけをinterleaveし、借用スライスをemitへ渡す。入力が大きくても、チャンク単位の再利用で処理中にバッファを拡張しない。rubatoのエラーは数値フィールドだけのenumで返し、RT側ではanyhowへの変換・文字列化・ログ出力をしない。

既存の公開process APIは非RT用の集約ラッパーとして残す。このAPIと、emitに割当を行うclosureを渡した場合まで無割当を保証するものではない。

入力コールバックは最初の空でない出力を転送するときに、リングバッファへ転送できるフレーム数を1回だけ決める。チャンクごとに上限を取り直して後半だけ多く送らないよう、残り転送数を保持する。チャンネル対応、フレーム単位の転送、容量不足時に末尾を捨てる方針、端数入力の扱いは維持した。

従来はコールバックの全リサンプル出力を作ってからまとめて送っていたが、現在は生成したチャンクから送る。このため実スレッド間の送受信時刻は変わる。サンプル計算・順序は同一で、同じ空き容量条件で転送するprefixも一致する。競合する実機スレッドでの欠落数・遅延まで同一とは保証しない。内部バッファが不正な場合のエラーでは、先に成功したチャンクを既に転送している可能性がある。通常の構築・処理でその内部状態を外部から変更するAPIはない。

## AddProcessor拒否時の所有権

以前は無効indexまたは使用中slotを拒否すると、受信したprocessorをRT側でそのままDropしていた。

通常退役と拒否値を私有DisposedProcessor enumで区別し、既存の回収キューへ返す。非RT側のタイマー処理でのみprocessorを破棄する。Rejectedにはon_processor_retiredを呼ばず、現役slotや別の保留アンロードを誤って解放しない。公開RetiredProcessorの型・フィールドは維持する。

回収キューが満杯ならDeferredDropが拒否値を1件保持する。flush_toが成功するまでは次のコマンドをpopしないため、拒否が連続しても保持領域の拡張・上書きDrop・リークは起きない。異常要求による混雑中は後続の制御コマンドも回収待ちになるが、音声の処理は続く。通常の退役値は引き続き既存のslot別配列で保持する。正常な追加・音声処理順は変更しない。

この対策は稼働中コールバックでの拒否経路を対象とする。ストリーム停止・構築失敗時にCPALがclosureの所有値を破棄するスレッドや、VST内部の割当・同期まで保証する変更ではない。

## DSP初回処理の調査結果と残件

固定中のnnnoiseless 0.5.2はeasyfft 0.4.2を利用する。easyfftのFFT planner、入力コピー、scratch領域はgeneric_singletonのget_or_init_thread_localで初期化する。起動側で別のDenoiseStateを処理しても、そのFFTキャッシュは実際のCPALコールバックのスレッドには移らない。

実DSPのソースを抽出した隔離probeで、処理状態と入出力バッファを起動側で構築してから新しいスレッドへ移し、初回480サンプルを計測した。各モードを別プロセスで実行した結果は以下のとおり。

| 準備方法 | 計測区間の確保／解放 | 出力ハッシュ |
| --- | --- | --- |
| 起動側で事前処理せず、新規スレッドで処理 | 49／5 | 16053342707342353232 |
| 起動側で別状態を960サンプル処理後、新規スレッドで処理 | 49／5 | 16053342707342353232 |
| 同一スレッドで別状態を事前処理後、未使用の状態で処理 | 0／0 | 16053342707342353232 |

前段の50／5という計測とはスレッド作成・状態構築のfixtureが異なる。本比較の重要点は、別スレッドでの事前処理を加えても回数が減らないことと、未使用状態の出力が一致することである。

実稼働状態そのものをwarmupして初期音声を変える対策や、初回コールバック内で同じ割当を行って解消扱いにする対策は採用しない。次段階では、FFT plannerと作業領域を状態ごとに非RT側で確保できるようにする局所的な依存実装修正を検討する。upstream API、保守・配布条件、初回と連続処理のビット一致を確認してから採用する。依存の置換・vendoring・音声ワーカー化は今回行っていない。

なお既存のRtNoiseReducer::reset_stateもDenoiseStateの再構築・破棄を行い、SetNoiseControlでRT側から呼ばれる。この再設定経路は初回FFTキャッシュ問題とは別に残るため、コールバック全体の無割当を判断するときは対象に含める必要がある。

## ローカル検証

- `cargo test --locked --lib --bins --test audio_queue_contract`: lib 45件＋queue 2件成功。`cargo test --locked --test ott_module_lifetime -- --ignored`: 実OTTの寿命・状態保存・メモリ内無音処理1件成功。合計48テスト。
- `cargo check --locked --all-targets`、`cargo clippy --locked --all-targets --message-format=json -- -D warnings`、`cargo build --locked --bins`: 成功、Clippy警告0件。`git diff --check`成功。既存の全体整形差分を混ぜず、変更箇所と新規ファイルを整形した。
- 最新debug/audio_engineでOTT・TDR Novaの画像、各3回の開閉、二重表示防止、リサイズ、表示中アンロード、応答継続を確認。音声Startコマンドは送信していない。
- RtNoiseReducer・RtBuiltInVoiceChainの定義と、コールバックのノイズ／内蔵エフェクトの処理本体が基準HEADと一致することをソース照合した。
- 回帰テストで、44.1k→48k、48k→44.1k、48k→96k、1／2／4ch、空・短い・端数・9413フレームを含む連続入力を旧rubato::process経路と比較。サンプルのビット列が一致し、新process_intoと事前確保した収集先の確保・解放は初回から0回。
- DeferredDropの回帰テストで、満杯のキューに128回再試行しても値をDropせず、空きができれば再開すること、RT対象区間の確保・解放0回、別スレッドで送信した拒否値のDropが受信側スレッドでのみ起きることを確認。
- 実AddProcessor分岐を抽出した隔離probeで、全u8 index×slot空き／使用中×回収キュー空き／満杯の1024条件を確認。受理したslotと件数、拒否値の分類、保持・後続要求の停止と再開が期待どおりで、対象コールバック処理の確保・解放・Dropは0回。
- 入力転送closureも旧／新ソースから抽出し、648条件でチャンネル変換、空き容量、チャンク分割、受理prefixのサンプルビット列を比較。結果一致、確保・解放0回。実CPALと同時に消費するスレッドの性能試験ではない。

ログ・隔離probeはignoredのsrc-tauri/target/rt-allocation-*に保存する。実機WASAPI／ASIO、実音声・音質・CPU・遅延・デバイス切替・長時間、高DPI、release／インストーラ／署名配布は未検証。実機ストリームを開始するintegration_test・repro_ottはコンパイルのみとする。DSP係数の変更、commit・push・PR作成は行わない。

参照したAPIは固定バージョンのrubatoのResampler、nnnoiselessのDenoiseState、easyfftのdyn_size/realfft実装。Context7 CLIは資格情報エラー、docs.rsは取得不可だったため、Cargoが取得した固定バージョンのregistryソースで直接照合した。

## 差分レビュー（2026-10-16）

基準HEAD・全差分と、入力転送、回収タイマー、PluginManagerのslot解放、VstProcessorの参照保持・Dropを確認した。追加の製品コード修正を要する不具合は見つからなかった。検証の不足を補うテスト修正・追加と本記録の追記だけを行った。

- rubatoの最大出力フレーム数×channelsを構築時に確保し、process_into_bufferが返した実フレーム数だけを読む。planarの本数と各容量は外部から変更できず、再利用バッファの余白をemitしない。FftFixedInの入力チャンク・FFT設定・演算は同じである。
- 転送上限は最初の非空出力時に1回取得し、後続チャンクでは残数を減らす。0ch・空出力は除外し、1フレーム分の空きを確認してからチャンネルを送る。生成したチャンクから送るという時刻の違いは上記のとおり残るが、同じ空き容量条件のprefixとチャンネル境界を維持する。
- flush_toがfalseなら新しいコマンドをpopしない。pendingはtake後に同じ値を戻すため、再試行時に旧値を上書きしてDropしない。flush後に限ってdeferを呼ぶ契約は、実際のコマンドloopで守られている。保持数は回収キュー32件・通常退役のslot別配列32件・拒否待ち1件の範囲に固定され、回収停止中に音声処理のloop自体を待機させない。
- 非RT側の回収はRetiredのみon_processor_retiredへ渡し、Rejectedはhandleだけを破棄する。VstProcessorはDLLのArc参照とadd_ref済みのprocessorを保持するため、回収までそれらの寿命を維持する。Dropはprocessorのreleaseと所有フィールドの破棄であり、現役インスタンスのactive_flagを変更しない。キュー満杯時に後続の正常コマンドも遅れる制約は意図した有限保持の対策で、通常の空きキュー時の追加・ゲイン設定・音声処理の順序は変わらない。

### 補強した検証

- リサンプラーの比較を192k→8kと8k→192kにも拡張し、5変換比率×1／2／4ch×7連続入力の105ブロックを確認した。monoの0フレームfixtureは従来1サンプル入っていたため、真の空入力になるよう修正した。多chは不完全な末尾サンプルも含める。旧rubato::process経路とビット一致し、処理の確保・解放は0回、planar／interleaveバッファのアドレス・長さ・capacityも不変だった。
- DeferredDropに、96件を容量2の回収キューへ送る回帰テストを追加した。間欠的な回収で何度満杯になっても、送信側の確保・解放・Dropは0回、受信順は0〜95、各値は1回ずつ破棄され、最終的にpendingとキューが空になることを確認した。
- 既存の実OTT寿命テストに、同じ現役インスタンスから余分なprocessor handleを作成・非RT側で破棄する確認を追加した。DLL参照数が元に戻り、slot・active_flag・保存状態・インスタンス数が維持され、その後のメモリ内処理・アンロードも成功した。実キューへの異常メッセージ送信や実音声と同時のreleaseを実行した試験ではない。
- 実AddProcessor分岐と入力転送closureが既存のソース抽出probeと一致することを照合してから再実行した。1024条件の追加／拒否／停止・再開、648条件の転送prefix比較が引き続き成功した。

`cargo test --locked --lib --bins --test audio_queue_contract`はlib 46件＋queue 2件成功、実OTT寿命テスト1件と合わせて49テスト成功。`cargo clippy --locked --all-targets --message-format=json -- -D warnings`も成功、警告0件。`git diff --check`成功。今回の追加変更はテストと記録だけのため、同一製品コードのcheck・build・GUI成功ログを確認し、それらの反復実行は行っていない。

ログはignoredのsrc-tauri/target/rt-allocation-review-*に保存する。DSP初回FFTキャッシュとreset_stateのRT割当、ストリーム停止時の破棄スレッド、同時消費がある実機音声・性能・長時間等は引き続き未解消または未検証。DSP係数の変更、commit・push・PR作成は行わない。
