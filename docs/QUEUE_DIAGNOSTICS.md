# queue量の観測（#47 段階A）

入力callbackから出力callbackへ渡す既存のf32 ring queueについて、投入・受入・満杯時破棄・読出し不足を観測する。
queue容量、callback時間、NRのモデル、VSTの申告遅延、信号の入出力対応遅延は別の量である。
この観測の時間換算を既存の推定遅延へ加算しない。

## 単位と数える場所

frameは全チャンネル一組、slotは1チャンネルの1サンプル。
受取入力frameは実入力レートで数える。生成・投入対象・受入・破棄・要求・読出し・不足補填は実出力レートのframeで数える。
レートが異なる入力frameと出力frameを直接差し引かない。
resamplerのemitまたは同率passthroughを生成とし、その全量を既存push処理へ渡すため段階Aでは生成と投入対象は一致する。
受入は全output chのpush完了、破棄は投入対象から受入を引いた量で、従来の受入予算と満杯時破棄を維持する。
出力の要求frameはqueueを読むcallbackだけを数える。読出しと不足補填の合計が要求frameになる。
不足callbackは不足補填が1frame以上あるcallbackで、開始直後の不足も含む。
故障フラグによる早期無音化・グローバルミュート・別の試聴音の無音量をこの不足へ混ぜない。

現在量は制御側のread-only observerによるslot観測を全output chで割った完全frame数。
並行publish中の末尾slotはcurrentPartialSlotsとして別表示し、完全frameと主張しない。
容量もcapacityFrames・capacitySlots・capacityRemainderSlotsを分ける。
並行更新で容量範囲外の一時観測になった場合の現在量はunknown。
最大観測量は各入力emit後のqueue量から求め、観測間の真の最大値を保証しない。
時間換算はsnapshotの実outputRateHzを使い、UIの選択値・既定48kHzへ置き換えない。

## 完全frame読出し

producerは各f32を個別に公開するため、output callbackが部分frameだけを観測する場合がある。
従来はそのslotまでpopし、次回のチャンネル境界がずれる可能性があった。
段階AではavailableSlotsをoutput ch数で切り捨て、公開済みの完全frameだけをpopする。
単独consumerでproducerは追加するだけなので、この完全frame数はpopまで減らない。
残った部分slotは次callbackへ残し、要求の不足frameだけを全chゼロ埋めする。
段階Aの観測helper自身は追加待機・queue jump・自動trim・producerの受入方針変更を行わない。段階Bの有限回復は後述の別制御で行う。

## epoch・停止・所有権

Engine epochと開始試行の連番を組み合わせ、fallbackを含む開始試行ごとに統計を作り直す。
準備中・稼働中・停止済み・失敗を区別する。両streamのplay成功前に稼働中とはしない。
停止後は同じepochの累積値を保持し、現在slots/frame/msはnull。
両callback終了後、queueを破棄する直前の残量をqueuedSlotsAtStop/queuedFramesAtStopに封印する。
この残量は消費済み音声や満杯時破棄へ加算しない。未起動・失効engineの統計はなしとする。
各counterは稼働中に同一瞬間の組として取得する保証はなく、相互の保存則は停止後に確認する。
Engineが統計Arcとqueue observerを保持し、stream/callback終了後に制御側でqueueの最後のArcを解放する。
RTではsample単位のatomic・時計取得・ログ・割当・待機を追加せず、callback単位に集計して固定個数のatomicを更新する。

## 検証境界

部分publish、mono/stereo/多ch、ring wrap、ch数の倍数でない容量、burstの受入予算、満杯時破棄、ゼロ補填、停止・再試行epochを実ringを使う単体テストで確認する。
同じpush/pop/統計helperの割当・解放を計測する。UIでは未取得・稼働・停止と実レートによる時間換算を確認する。
これだけで実機CPU、長時間のclock drift、デバイス内変換、総信号遅延、実OBS録音を検証したとはしない。
同率の到着時刻の対応付けは別枠の [FRAME_TIMING.md](FRAME_TIMING.md) で定義する。異率の対応付けとクロック補償は未実装である。queueの有限回復は次節の範囲に限る。


## 有限回復の比較導入（#47 段階Bの一部）

consumerは読出し前の完全frame数を監視する。Bは同試行で観測した最大出力callbackと入力生成burstの大きい方。T=1B、H=3Bとし、Hに次のBを加えた容量が必要。Defaultの実callback増大で成立しなくなれば非対応を保持し、silent clampしない。
H超過が出力frame換算100ms継続すると、通常マイクの最終出力を約10msでフェードし、ゼロの境界でTまで古いframeを除去し、約10msで戻す。output gain意図、NR/内蔵/VSTの設定は変更しない。測定・録音・test tone・legacy再生・global mute中は新たな回復を開始しない。独立試聴は別streamであり対象外。
回復は1開始試行につき最大1回。再超過は診断を保持し、通常出力を止めたり繰返しtrimしたりしない。停止・再開始で状態を再構築する。producer満杯破棄と回復破棄は別計数で、停止後の保存則は accepted = consumed + recoveryDiscarded + queued。requested = consumed + zeroFilled は維持する。
private比較144条件（同thread・各60仮想秒、48/96k・2/22出力ch・512frames）ではT1/H3が全容量へ適合し、output pause8条件だけ1回回復、他40条件の不要回復0。T2/H4は48k22chで容量不足。これは最適値、CPU、実clock、無クリック・音質の保証ではない。ASRCは未実装で、#47全体の段階B完了とはしない。

測定開始要求が回復フェード途中に到着した場合、旧積分を終了し、最新1件のIDを固定サイズで保留する。保留中も新規回復を抑止し、gainがunityへ戻った次のブロックから測定を開始する。取消Noneは保留も終了する。制御側Successは従来どおり要求受理であり、最初の測定結果の即時発生を保証しない。
VoiceCheckのraw/processed録音tapは最終送出fadeより前にある。回復fadeを含む実送出波形との一致や、録音から実出力までの対応を保証しない。

旧Engineのqueue objectに回復情報がない場合、新5項目はnull/未取得として扱い、観測0回や監視成功とは表示しない。
