# 録音から内蔵処理の候補を提案する

この機能は固定ルールによる比較候補を作る。声質・部屋・好みに合う値や品質改善を保証しない。本人の歌唱音声は未提供で、聴感は未確認。解析と適用は別操作で、準備だけでは通常送出・録音・再生デバイス・NR・VST・入力音量・出力音量・ミュートを変更しない。

## 測定と初期候補

入力音量とチャンネル選択後、NR・内蔵処理・VST前の封印済みrawステレオ録音を使う。生PCMをIPCや外部ファイルへ書き出さない。従来の品質解析APIは一時WAVと左右平均を使う別機能で、この提案の根拠には使わない。

左右別にpeakと二乗和を求め、20ms相当の窓で `(L² + R²) / 2` の平均エネルギーを算出する。左右を平均してから二乗しないため逆相で消えない。片チャンネルは集約値で3dB低くなるが、左右別の測定値も保持する。窓のサンプル数は整数に丸められる。

`singing-rules-v1` の閾値は暫定値である。

- 対応録音は8〜192kHz、3〜30秒。録音と候補の既存容量制限も維持する。
- 非finite、どちらかのchで絶対値0.999以上、ほぼ無音、-45dBFS以上の窓が50未満なら候補を作らない。0.999はサンプル上限付近の検出であり、機器側のクリップを網羅する判定ではない。
- 活動窓RMSのP10/P50/P90をnearest-rankで求める。P90−P10が9dB以上ならdynamics 0.35、未満なら0.20を比較候補とする。この幅は歌声固有のダイナミックレンジやLUFSではない。
- HPF80Hz、brightness0dB、残響OFFは測定から決めた最適値ではなく初期候補。既存の残響mix/decay/damping値は保持してenabledだけOFFにする。その他の既存設定値も必要なく初期化しない。

活動窓は音量による分類で、声・ノイズ・伴奏を識別しない。SNRや部屋の残響も推定しない。定常ノイズや伴奏を含む録音で歌声向けの妥当性を保証できないため、理由と限界を表示し、利用者がA/Bして判断する。NRや高域、残響を自動で個人最適化したとは表示しない。

## APIと寿命

既存 `voice_check_preview` のsession/operation envelopeへ `prepare_proposal { recordingId, builtinEpoch, expectedRevision }` を追加する。外側の `epoch` は試聴sessionのepoch、`builtinEpoch` はBuiltinSnapshotのepochであり同一視しない。準備はデバイス列挙もstream構築も行わない。 Hostは既存engineのgenerationとchild生存を送信前後に確認し、reader終了通知が遅れてもensureや再起動へ進まない。再生中は先に停止する。

既存の1worker・保留job1件を共用する。非RT workerで解析した後、同じ内蔵candidate rendererを通す。`candidate_status` / `cancel_candidate` / `start(candidateId)` は従来のものを使う。workerの結果配送は非RT側だけで待機し、満杯による完了通知の破棄をしない。原本は変更しない。候補にはNR・外部VST・outputGainを含めず、通常ラック全体との同値を主張しない。

CandidateSnapshotの任意field `proposal` は `id / epoch / recordingId / baseRevision / ruleVersion / config / metrics / reasons / limitations` を持つ。ここでのepochはBuiltinSnapshotのもの。`proposalError` は解析失敗の `code / args / fallbackJa` を返す。メッセージcodeは表示言語から独立し、argsは有限の数値だけ。従来のaction/state tokenや既存エラー形式は変更しない。

新提案だけは、受付時・worker結果採用時・適用時に次を確認する。

- 同じ封印済み原本Arc・録音ID・Builtin epoch/revision・音声条件revisionである。
- 録音中に条件変更がなく、metadataのrevisionと現在の音声条件revisionが一致する。
- 録音tap/レートが確認でき、録音・通常再生・AutoGain利用や内蔵設定の反映待ちと競合していない。

録音単独の差し替え、条件変更、close/cancel、engine交代で提案は失効する。古いworkerが成功を返しても現在の候補へ採用しない。この厳密化を理由なく既存手動 `prepare_candidate` へ広げない。

## 明示適用とUndo

既存 `builtin_effects` に `apply_proposal { epoch, expectedRevision, proposalId, recordingId }` を追加する。Hostは既存engine接続だけを使い、復元のreservation中は拒否する。本番保護は既存の明示内蔵変更の契約を維持し、提案用にarm/disarmしない。engineの終了が確認された場合の従来の保護失効は維持する。

Coreは同じ制御dispatch内で提案witnessを照合して設定を解決し、直後に既存Builtin CAS Applyを行う。間にawaitや別commandは入らない。Closeが先に処理されればApplyを拒否し、Applyが先なら受理した結果を後続Closeで取り消さない。

適用により音声revisionが進み提案が失効しても、返却した設定ACK・RTのpending状態・Undo tokenを失敗へ書き換えない。既存の一世代Undo CASを使い、別の内蔵変更やprofile適用が挟まれば古いUndoは拒否する。IPC timeout等の結果不明は成功・未適用のどちらとも断定せず、従来どおり再取得して判断する。自動再適用や旧APIへのfallbackをしない。

提案自体と測定値は永続化しない。明示適用したBuiltinConfigだけが従来のprofile/preset保存対象となり、保存形式・旧profileの既定値は変更しない。

## 検証の境界

合成音で逆相・片ch・複数rate・無音・短音・nonfinite・上限付近・活動窓・暫定ルールを確認する。非実機で古い録音/条件/epoch、遅いworker完了、Close/Apply順序、CAS/Undo、原本・NR・VST・gain・mute不変を確認する。実機の可聴性、本人歌唱の聴感、ノイズ判別、最適なEQ/コンプ/残響、長時間性能は別検証である。


## 希望を指定するv2比較（singing-rules-v2）

旧requestはruleVersion／preferences／preferencesRevisionが全て省略またはnullならv1のまま動く。新UIは `ruleVersion: "singing-rules-v2"`、5つのpreferences、1〜2^53−1のpreferencesRevisionを明示する。部分欠落、未知版、未知の希望値は拒否する。同じ試聴session内では希望世代を逆戻りさせない。SeedからJob、Proposalへ希望と世代を所有値で固定し、提案には同じruleVersionと世代を返す。新UIは返却版・世代が一致しない旧backendのv1候補を希望反映済みとして試聴・Applyしない。

希望の既定は自然、低域維持、現在の明るさ維持、部屋不明、現在の残響維持。現在値とはCASのbase configであり、未保存manual draftを解析へ混ぜない。base.reverbが無ければOFFのまま保持し、部屋の選択だけで残響をONにしない。本人音源による聴感は未確認で、歌／部屋／SNR／好みの識別は行わない。

一つのworker内で候補を直列に処理する。v2ではrawから左右別二乗和の共通20ms活動maskを一回作り、最大1501窓の集計だけを持つ。非標準rateのfloor(rate/50)丸めによって1501窓を越える場合は、v2だけ解析前に明示拒否し、旧v1の受付を変更しない。候補ごとに活動を再分類せず、絶対録音levelを正規化・増幅しない。候補PCMを全grid分保持せず、選択した1件だけ既存rendererへ渡す。raw解析・gridは256frame以内ごとに取消を確認する。gridの最悪はHPF4＋未達時40Hz再評価1＋対照1＋comp5＋最終1の12passで、実機CPU・全engine負荷の保証ではない。

固定ルールの暫定工程は次のとおり。閾値は工学的制約であって音質の合否ではない。

- HPF40／60／80／100Hzを弱い順に評価する。活動窓のHPF前後energy損失を使い、低域維持は0.25dB以下、軽い整理は0.15〜1dBの候補を選ぶ。該当しなければ40Hzに戻し、energy目標未達を表示する。後のピーク・有限性制約を免除するfallbackではない。
- 自然はdynamics0。少し均一は、選択した同じHPF・brightness0のdynamics0対照に対し、0／.15／.25／.35／.50の順に評価する。P90−P10の縮小1dB以上、活動energyの減衰0〜3dB、実DSP最大gain reduction6dB以下、clamp前超過なしを満たす最弱値を使う。未達ならdynamics0と理由を返し、強い値へ押し切らない。低い録音を勝手に持ち上げないため、弱い入力でGRが働かない場合も未達となる。
- brightness維持は現在値、明るく／柔らかくはそれぞれ+1／−1dBを本人希望として使う。録音から最適な高域量を推定した値ではない。
- 残響維持は部屋の申告にかかわらず現在configをそのまま保持する。なしはenabled=false。短いはmix.05／decay.6s。広めは乾いた部屋で.10／1.2s、不明で.07／.9s、響く部屋で.05／.6sへ控えめにし、最後の場合は希望を弱めた旨を説明する。dampingは.6。いずれもRT60を測定した値ではない。

SingingChainの同じ演算経路から固定Copy observerでHPF後／gain後の左右energy、実gain、shelf後かつ±.98clamp直前のpeak／超過sample数を分離する。通常processはno-op observerへ委譲し、再計算や永続DSP状態は追加しない。dynamics0でもclampし得るため、最終PCMが小さくなっただけではGR成功と判定しない。逆相、片ch、左右交換を左右和の相殺で失わない。

最終brightness／reverb込みconfigについて、source+tailの正確なframesと既存64MiB candidate budgetを確保前に確認する。超過を切詰めず、黙って残響OFFにしない。同じrawをSinging→Reverbへ一度だけ通し、source活動区間の最終energy減衰3dB以下、最大GR6dB以下、finite、clamp前超過なし、clamp前／tail末尾fade前の最大peak≤.980001を確認する。制約違反はunsafeCandidateとして候補を拒否し、希望未達の説明とは区別する。選択1件の通常renderでも確保前・render後の取消を確認し、既存世代/witness検査を通った結果だけ採用する。

Proposalにはpreferences／preferencesRevisionとevaluation（共通活動窓数、HPF損失、対照/候補spread、最終level損失、最大GR、clamp前peak/超過数、tail fade前peak）を追加する。code+有限数値args+JP fallbackの既存表示形式を使い、これらを永続化しない。適用したconfigだけが従来保存対象である。

希望編集はその場でApplyを失効させ、旧candidate IDだけ取消す。遅いprepare ACKから新候補を取消さず、hidden／close／録音変更／条件変更／epoch交代の既存失効も維持する。試聴中は希望編集を禁止し、停止してから変更する。新しい希望の準備・再生・適用は全て明示操作で、device/安全確認やmanual draftをlocale切替でリセットしない。適用とclose/cancelの処理順、CAS／一世代Undo／結果不明／stopUnconfirmedは既存契約のままである。
