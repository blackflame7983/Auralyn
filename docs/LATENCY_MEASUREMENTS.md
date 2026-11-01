# 遅延に関する値と測定範囲

同率・resamplerなしでは入力callback到着から対応frameを含むraw音声キューの読出し完了までを別枠で観測する（[FRAME_TIMING.md](FRAME_TIMING.md)）。
異率では別のoptional `resamplerBatchTiming` で、batchが揃った入力callbackから生成出力frameの実queue読出完了までだけを観測する。過去入力の蓄積待ち全体や、原信号の各sampleへの点対応は未測定である。DSPを通った実信号の出力到達を結ぶ測定も未実装である。
現時点でアプリは全通過時間やOBSの映像同期差を測定していない。

## 配線なしの実機確認（2026-11-01、#211）

利用者の指定により物理ループバック配線と発声は行っていない。
ASIO・WASAPIの起動、実callback長、処理frameの進行、録音内容を確認したが、物理的な往復遅延や段別の信号通過時間の基準値は未取得である。
詳しい条件と結果は [実機確認記録](verification/issues-210-216-20261101.md) を参照する。

96kHzのASIOで64／128／256／512frameを要求したところ、Creative Sound Blaster ASIOは384frame、Voicemeeter Insert Virtual ASIOは512frameで開始し、callback診断もそれぞれ384／512frameだった。
Creativeの384frame指定も含む計9回の開始とframe進行を確認した。
要求した64frame等を、そのまま実稼働バッファや往復遅延の測定条件として記載しない。
仮想CABLEのWASAPIは48kHz・512frame要求だが、観測callback長は480〜1056frameだった。

NR high・内蔵broadcast/0.7・OTT 3本で、Creative ASIOのsidecarとVoicemeeter ASIOの製品Hostをそれぞれ1時間運転した。
両方で入力・要求・消費frameの進行が続き、観測区間内のqueue underflow・zero fill・drop・recoveryの増分は0だった。
製品Hostは最小化中も音声処理を継続し、通常表示への復帰後も稼働していた。
これはキューの継続性の確認であり、1時間分の連続WAVから音切れ回数を数えた結果ではない。
製品Hostの録音は開始付近と中間の各5秒・加工前後の計4ファイルだけで、終端の録音は取得していない。
開始付近は無音、中間は信号があり、固定素材ではなく音源の同定・聴感評価も行っていない。
`glitchCount` はcallback進入間隔の揺らぎを数える既存指標であり、音切れ回数へ読み替えない。

物理配線が用意できた場合は、同じ機器・レート・ドライバー設定を固定して出力→入力を接続し、送信基準と受信信号を共通clockで記録する。
フィードバック経路を切り、低い送出レベルの既知信号で、ASIOの実対応bufferとWASAPI、NR OFF/ON、VST 0/1/3本を各5回以上比較する。
到達位置の検出方法・閾値・未検出・試行数・範囲を残し、DSPの非線形処理や相関peakの曖昧さを区別する。
段別の差は同一経路の対照構成との差として示し、NRの10msフレーム周期やVST申告値とは別に扱う。
固定素材の1時間連続録音と欠損解析も残っているため、#211は未完了である。

## 表示と互換性

既存の `noiseReductionLatencySamples/Ms` は、NR設定ON時の約10msのフレーム長計算を互換保持する。
`totalPluginLatencySamples/Ms` はVST SDKの申告値の和、`totalChainLatencySamples/Ms` はその申告値と旧NR計算値だけの小計である。
これらを総遅延、常に各sampleが待つ時間、実測値とは表示しない。
SDKはu32を直接返し、旧互換APIはprocessor未取得時に0を返す。新しい段別DTOはbackendのOptionでSDK申告0とprocessor未取得nullを区別し、UIで0を取得不能へ推測変換しない。
原音比較（global bypass）の現契約はVSTのみで、NR設定をOFFにする根拠にはならない。

optionalの `latencyMetadata`（schemaVersion=1）は実stream稼働有無、出力設定レート、固定バッファ要求、NRの設定とフレーム計算基準、VST申告samplesを分離する。
Defaultバッファ時の内部512仮値は固定要求として公開しない。
NR専用checked factoryはactual出力rate（fallback後も再確認）を受け取り、8k〜384k、frame数floor((rate+50)/100)を使用する。従来のshared 8k〜192k clampはtone／voicecheck／capture用に維持し、NRへ流用しない。
既存表示の時間換算はsamples／出力設定rateであり、NR実設定rateも併記する。段別NRはframe数／NR実設定rateによるフレーム周期を明示する。384kでは3840frame＝10msであるが、192k超の実機可否・音質・信号対応は未確認である。
固定バッファは1回分の換算、callback長は別の観測値、queue量は既存の別枠で示す。
固定WASAPI+20ms、入出力各1バッファの仮定、品質gradingによる総遅延表示は使用しない。
停止・異常・未取得・旧応答のmetadata欠落・不正値は、現在の0ms測定成功に置き換えない。
NR設定はRT ACKの観測ではなく、VST申告0も信号通過時間0の保証ではない。
OBS同期は録画で利用者が測った差を使う。これらの値を自動適用しない。

## #48の独立数値study

ignoredの `src-tauri/target/issue-backlog-noise-study-report.md` とmanifestに出典・再現コマンド・hashを記録した。
44.1/48/96k、合成信号546条件の出力はfiniteだった。reset・OFF→ON・同値ONは各rateで別途比較した。
特定coded-noiseのwet相関lagとcold impulse peakは約19.98msだったが、即時dryとの混合では最大相関lagが0になる条件もある。
非線形・状態依存処理の信号別観測であり、NR全体の固定遅延や公開総遅延20msとはしない。
0〜40msの全sample lagを探索する一方、解析sample対は約3kHzへ間引く近似である。
周期性・alias・競合peakが残り、warm impulseは対照run差分であって線形インパルス応答ではない。

実RtNoiseReducer sourceを取り込むが、最終mixはhelperで再構成し、detector/profile条件は固定している。
NNは既存release rlibを利用しdep-infoがvendor 0.5.2を指す。現在sourceからartifactを再構築した証明ではない。
CPUはstandalone opt3/LTOのNR＋再構成mix＋checksum、512frame・39条件・3trialの観測であり全engineのdeadline保証ではない。
正式計時は `timing-confirmed-idle.json` のみ。計時時sourceと実行ファイルのhashはprovenanceへ保存し、その後の相関修正とは区別した。
歌唱素材は未提供で、聴感・歌唱適性・実driver総遅延・長時間・384k音質は未確認である。
この結果を理由に常時20msを加算したり、モデルを置き換えたり、原音へ遅延を追加したりしない。


## 異率resampler申告値の分離

`resamplerBatchTiming.declaredResampler.declaredOutputDelayFrames` は固定rubatoの公開 `output_delay()` の申告出力frame数であり、runtime分位とは別である。
入力/出力rate、入力chunk数、最大出力chunk数も開始準備中の固定descriptorとして返す。
これを分位へ足す/引く、OBS遅延へ自動転記する、既存 `totalChainLatency` へ合算することはしない。
`(n-D)*in/out` による中心referenceは申告モデルの将来検証候補であり、このsliceではruntime信号点対応として公開しない。


## FFT入力chunk512の適用範囲（#46）

異率4組（44.1↔48、48↔96kHz）だけ入力chunkを512へ変更し、他の異率は1024、同率は無変換を保持する。
rateの実値を照合し、比率だけで未検証の組合せへ広げない。
既存の `totalPluginLatency`、NRの旧計算値、`totalChainLatency` の計算へFFT delayを追加しない。

`firstEmitSubmittedInputFrames` は私有helperへ入力を投入して最初の出力batchが生じた時点で、申告 `output_delay()` や実信号の到達とは別である。
chunkを縮めるとwrapperの入力待ちやfilterの申告delayは変わり得るが、内部FFT単位・carry・実callback分割にも依存する。
大きなcallback1回に両chunkが収まる場合や、rate/gcdによって内部単位が変わらない場合もあるため、全条件で遅延半減とは表示しない。

私有の固定旧wrapper1024/512比較は4pairの離散帯域、channel保全、requested heap、同一process内fresh5のcomponent時間を対象とする。
その比較には新しいframe-timing観測の処理費用を含まず、最新製品の全Engine CPU・実機遅延・聴感・長時間の確認には代えない。
製品での申告descriptor、batch-ready観測、実機検証を分け、OBS同期設定へ自動適用しない。

## 蓄積入力cohortの追加観測（#28 phase2a）

`resamplerCohortTiming`は、変換処理で消費した原入力callback群の最早／最遅到着から、対応する通常mic出力slotを含むbufferの書込み完了までを別表示する。既存`resamplerBatchTiming`の「batchが揃った直近callback→queue読出完了」とは観測始点・終点が異なるため、同一の値として置換・加算しない。wrapper蓄積とrubato内部の未処理入力carryも含む処理cohortを追うが、FIR前回overlapを含む全信号依存やsampleの中心referenceを実測するものではない。

schemaVersion=2のstatusはcollecting／partial／invalid／sealed／unsupported／pending／substituted。metadata不足、回復skipや不整合ではunknown／永久失効とし、0msにはしない。差替え出力はmic分位を隠し、通常mic復帰時は新窓を開始する。同率はsameRateInputToOutputBufferEndとして別観測を返す。旧backendのmissing／null／旧schemaは現在窓が未取得である。seal後の値と旧epochを現在値として表示しない。

NR／内蔵処理／VSTが有効でも`signalCorrespondence=notMeasured`である。処理呼出しの出力slotまでの経過時間と、DSP内部の実信号遅延は異なる。NRのsynthetic相関約20ms、10msのframe計算、VST getLatencySamples申告、reverbのdecayをこの観測へ機械的に足さない。phase2bの段別declared／計算／unknownは下記の別情報であり、signalCorrespondenceをmeasuredへ変更しない。


処理条件変更はrequested／completed／applied／rejected revisionと同じRT FIFOのmarkerで区別し、streamを止めず観測窓だけ再開する。appliedはRT受理・状態反映であり、平滑化／VST内部完了ではない。拒否は残存状態での新窓として表示する。metadata fault／回復skipの永久失効を設定変更で復活させない。read／poll／localeは不変。旧rawとbatch-readyの数値／traceは維持し、同率の新しい出力完了分位と加算しない。詳細はFRAME_TIMING.md。


## 段別の根拠（phase2b）

latencyMetadata.stageBreakdownはoptional、schemaVersion=1、queryBasis=queriedAtRuntimeStats。既存VST小計と段別の申告値は、一回のgetLatencySamples巡回から同時生成する。32段を上限とし、IDと公開名だけを返し、path／state／設定JSONは含めない。active／bypassed／muted／unavailableと個別bypass／mute、全体VST-only bypassを区別する。SDK申告0はSome(0)、processor未取得はnull。未知段を含む小計やu32 overflowは新しいknown subtotalをnullとする。旧小計は従来の飽和とmute段を含む集計を維持し、有効信号チェーン全体の和とは呼ばない。

停止・異常ではcurrent=falseとし、段別の現在申告値・NR計算値を出さない。旧backendのstageBreakdown欠落／null、未知schema、異なるqueue epochも表示は未取得となる。次のRuntimeStatsで再照会するが、RT適用ACK、VST GUI変更通知、restartComponent後の鮮度は保証しない。新pollは追加しない。

NRの480frame／48kモデルは10msの分析フレーム周期という計算根拠であり、wet履歴やdry/wet混合の各信号の待ち時間はunknown。内蔵IIR位相／コンプ状態／reverb tailもunknownであり、decayやdelay-line長を固定通過時間へ換算しない。これらをcohort／rawの分位やVST申告へ足した新しい総遅延は作らない。

NRは対応rateならOFFでも制御側で事前確保し、ON／OFF／resetでRT再確保しない。最大3840frameの可変4配列payloadは61440Bであり、nnnoiselessモデル・FFT・state・固定配列・allocator等を含む総保持量ではない。非対応rateでのNR有効化は両setterともintent／queue更新前に拒否し、停止中の保存意図は次Start時に検証する。OFFではNR専用のrate拒否を増やさないが、他DSPや機器の対応範囲を広げるものではない。万一未準備のONがRTへ届いた場合は無音と固定atomic通知から制御側停止へ移り、別rate処理やpanicへ置換しない。profile復元の既存エラー伝播を維持し、拒否を成功summaryへ追加しない。

## #211 配線前の計測準備とオフライン解析

`scripts/loopback_measurements.py` はデバイスを起動せず、計測計画と非発声の計測用信号を作成し、別途録音した WAV を解析する。Python の numpy、scipy、soundfile が必要。出力先は毎回存在しない新規ディレクトリを指定し、既存ファイルは上書きしない。

```powershell
python scripts/loopback_measurements.py prepare out/plan --rate 48000 --device "機器名" --driver "ドライバーと版" --build "ビルド識別子" --routing "配線と経路" --buffers 128 256 512
python scripts/loopback_measurements.py a1 recording-a1.wav out/a1
python scripts/loopback_measurements.py a3 recording-a3.wav out/a3
python -m unittest discover -s scripts -p test_loopback_measurements.py -v
```

plan は ASIO／WASAPI、指定した要求 buffer、NR OFF／ON、VST 0／3本の各組合せにつき5回を示す。各 backend・機器の実対応値を確認して指定する。要求値は実 callback 長ではなく、WASAPI の512要求も観測するまで unknown である。実際の rate、機器、ドライバー、build、経路、NR・VST 設定、callback 長と各試行の結果を別途記録する。VST 1本の比較も必要な場合は追加試行として記録する。

A1 はフィードバック経路を切り、送出レベルを安全な低さから確認する。生成された `fixture.wav` は人声ではなく、固定 seed の3秒間の計測信号である。送信基準と処理後を同じ ADC clock の外部録音機で同時録音し、左を reference、右を processed とする2ch WAV を用意する。配線図、機器の入出力、録音レート、ゲイン、外部録音機、クロックと、直結などの校正条件を記録する。同一 clock を確認できない録音は比較根拠にしない。各条件5回の結果と不明な試行を残す。

A1 の絶対相関は極性反転も許容し、processed の reference に対する相対 lag を返す。peak が0.2未満、1ms以上離れた競合 peak が最大の80%以上、無音、短時間、非有限値は unknown とする。閾値を満たしても信号経路・DSPで誤検出はあり得るため波形と校正を確認する。この lag は録音した2経路の差であり、校正なしに物理端子の往復遅延や OBS 同期値とは呼ばない。

A3 は固定の非無音素材を1時間以上流し、同一録音の左 reference・右 processed を保存する。10ms窓ごとに reference RMS が0.01以上のとき processed RMS がその1%以下なら疑い区間とし、連続窓を結合する。JSON に区間開始、長さ、件数、参照が不活性または非有限で未解析の時間を出す。1時間未満、参照活性なし、非有限値は unknown であり、いずれも合格判定ではない。録音全体を一括ロードしない。

上記の10ms減衰判定とは別に、processed のサンプルが正確に0である連続区間をブロック境界を越えて追跡する。1ms以上で、その区間内の reference RMS が0.01以上のものを `digitalZeroIntervals` と `digitalZeroIntervalCount` に報告する。1サンプルのゼロ交差は数えない。参照が不活性な時間を含む1時間以上の録音は `partial`、参照活性なし・非有限値・1時間未満は `unknown` とし、完全な解析としない。ゼロ区間の参照活性は区間全体のRMSによる判定であり、区間内の各瞬間の活性を保証しない。短いゼロ、非ゼロの小振幅、参照の不活性や欠落はこの検出では見逃し得る。2種類の件数は重複し得るため足し合わせない。

この検出は NR の抑制、意図的ミュート、DSP による減衰と欠損を区別できない。削除された frame、両チャンネル同時の欠損、閾値や窓より短い変化は検出できる保証がない。素材と設定、未解析範囲を確認し、疑い箇所の波形・聴感と他の観測を照合する。`suspectedIntervalCount` は確定音切れ回数ではなく、既存 `glitchCount` とも別である。これらは配線・実測待ちの準備であり、物理遅延、実際の音切れ回数、聴感の合格は未確認である。
