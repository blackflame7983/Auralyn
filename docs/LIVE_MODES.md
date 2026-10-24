# 歌／雑談モードの契約（#36）

通常プロファイルとは別のschemaVersion=1の保存データに、内蔵音作り設定だけを歌／雑談それぞれ任意で保存する。未割当はエラーで、通常プリセットへfallbackしない。device／VST／NR／入出力gain／muteはモードに含めない。`active` は声の処理だけ、残響は独立。雑談保存値の `reverb.enabled=true` は拒否する。

## 実装前の遷移表

|現在／操作|制御側の目標|RT／tail|確認状態|
|---|---|---|---|
|未割当へ歌／雑談指定|変更せず明示エラー|変更なし|失敗、fallbackなし|
|停止中に指定|選択と内蔵設定を保持|通信queueへ古い変更を残さない|stopped、次回開始で反映|
|起動時|最新の保持設定だけで構築|旧tailなし|最初callback用設定。稼働確認は別|
|稼働中の指定|1実行＋最新目標1件|固定2voice状態間を約20ms線形crossfade|受理／RT受付／補間完了を区別|
|切替中に同じ指定|revisionとランプを再開始しない|実行継続|同値idempotent|
|切替中に逆方向／連打|実行中は完了させ、待機目標だけ最新へ置換|完了後に最新へ約20ms。無制限queueなし|古いACKで目標を巻き戻さない|
|歌→雑談|雑談voiceへ移行|歌の残響係数とringを保持、送入だけ滑らかに0、tail出力を保持|voice完了とtail残存は別|
|雑談→歌|歌voice／歌残響設定を使用|送入を滑らかに戻す。残響係数も既存平滑化|補間完了は無音断保証ではない|
|手動内蔵設定／profile変更|Customへ移行、古いmode操作を失効|通常設定の既存挙動へ戻す|mode適用済みと主張しない|
|gain／mute／NR変更|mode目標は保持|mute時はtail即消去、mute中に新tailを作らない|解除しても旧tailは復活しない|
|停止／異常／再起動|最新目標を停止保持|ring／遷移状態は破棄、次回は最新値|旧epochのACKは無効|

20msは初期実装の暫定値で、聴感・クリック・CPU・実機の品質保証ではない。voiceは線形crossfadeのため二つの出力の凸結合となるが、外部VSTの出力や楽器との最終ミックスまで保証しない。mode変更はVSTロード／アンロード／順序変更やengine restartを呼ばない。

## 本番保護と操作入口

保護は明示arm/disarmで、OBS接続だけでは自動armしない。arm中はdevice設定変更／新規scan／ラック変更／全profile適用をbackendで実行前拒否し、解除案内を返す。停止・ミュート・同設定の障害復旧は妨げない。通常profileはNRやgain変更より前にpreflightする。保存済み設定だけから自動キー登録しない。既存8操作と最大8登録を維持し、歌／雑談の明示指定を追加する。後着workerが古いキー意図を実行しないよう入口で順番を管理する。

OBSは世代・連番付きの実scene changeだけを新routerへ渡す。接続時のcurrentScene取得はmode操作にしない。未割当／切断／古いイベントは変更なし。同じイベントで同名preset再ロードとmode指定を二重実行しない。frontend routerとStream Deck実機は後続確認であり、backend完成だけで完了扱いしない。


## APIと保存・世代

`live_modes({request})` を同じUI／Hotkey入口に使う。snapshotは未起動engineを起動しない。`save {expectedVersion:string,singing:Config|null,talk:Config|null}` は独立 `live_modes.json` の `schemaVersion:1,version:string` をCAS更新する。壊れた保存値は自動上書きしない。`singing_on`／`talk_on` は `intent:{clientId,sequence,expectedEpoch}` を必須とし、client内の逆順とHost世代の不一致を拒否する。異なる入口もengineの単一revisionへ集約する。client数は16を上限とし、上限時は明示エラー。`arm`／`disarm` は保存しない。

snapshotにはHost epoch、running、revision／acceptedRevision／completedRevision、target／applied、phase、armed、naturalTail、definitions、errorを返す。初回sidecar起動ではHost epochを変えず、既存engineの終了／交代で失効する。`live-modes-invalidated` は空payloadで再取得を要求する。異常交代では保護を解除して復旧を妨げず、選択目標はHostが停止状態へ再設定する。app終了を越えて選択目標や保護を自動復元しない。

保護のarm前には具体的input/outputと実rate/bufferを要求する。arm中の復旧はその厳密な設定だけを許可し、Noneを同一と推測しない。frontendの自動復旧はarm中だけ `get_audio_state` の具体値を使う。明示engine restartや全profile適用は、kill／backup／NR／gain変更より前にpreflightする。frontendで複数IPCを使う旧preset復元も `preflight_live_changes` を最初に呼び、保護中は開始しない。

OBSの新入口は `obs://live-scene-changed {sceneName,connectionGeneration,sequence}`。`obs_live_scene_status` は接続状態と現在の世代・連番だけをローカル取得し、currentScene取得や音声操作をしない。`obs://live-scene-invalidated` は購読終了を知らせる。routerは明示enable時点のbaseline以降の最新実eventだけを受理し、世代・連番とmode intentの両方を照合する。旧 `obs://scene-changed` は互換保持するが、新routerと既存同名preset連動は排他にする。


## 保護操作の順序と復元予約

`arm` と `disarm` も歌／雑談指定と同じ `intent:{clientId,sequence,expectedEpoch}` を必須とする。Hostはensure前後のepochを照合し、内部Engine epochへ置換した後もEngine側でepoch／順番を検証する。初回idleのarmは入出力の明示状態を先に検証し、未設定ならengineを起動せず拒否する。

複数IPCのpreset／profile復元は `preflight_live_changes()` → `begin_live_changes()` → 復元全体 → `finally end_live_changes({token})` で囲む。BeginはHostだけで保護preflightと二重予約を検証し、engineを起動しない。予約中はモード指定／arm／モード定義保存を拒否する。Snapshot／disarm／停止／ミュートは利用できる。profile内部のpure preflightは自分の予約を拒否しない。予約は自動期限で解除せず、正しいtokenによるEndだけが解放する。空／不一致／旧tokenは新しい予約を解除しない。

初回ensureと同じ復元処理からの明示restartは予約を維持する。予期しないengine交代やIPC障害ではepochを失効して保護を解除し、予約はcanceled状態で保持する。古いworkflowの各tokenless IPCを強制停止する保証はないため、その終了前に新しいモード指定／arm／定義保存／Beginを受理しない。元workflowのfinallyからmatching tokenでEndしたときだけ予約を解放する。終了処理が失われた場合はアプリ再起動が必要で、自動期限解除はしない。予定したrestartやfatal後のcanceled予約ではtokenの元epochと現在epochが異なっても、保持中の完全一致tokenで解放できる。一度解放して新しい予約を取得した後に、古いtokenで新予約を解放することはできない。これは原子的な全profile適用や失敗時の自動rollbackを保証するものではなく、復元途中へのモード／保護操作の割込みを防ぐ予約である。
