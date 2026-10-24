# ASIOのDevice共有・入出力rate・入力先行登録（#45）

ASIOは入力→出力の順にbuildし、固定CPAL/asio-sysのcallback登録を入力先行にする。
WASAPIのbuild順と両Hostのplay順は出力→入力を維持する。DSP・mute・gain・ch routing・rubato標準1024は変更しない。
固定asio-sys 0.2.6はcallbackをVecの末尾へ登録し、同じ順で実行する。入力callbackによるqueue転送後に出力callback内のDSPが実行される。
これはdriverやOSの物理的な往復遅延、無欠測、1周期分の改善を保証しない。比較実機検証は別に行う。

## 同じDeviceの共有

CPAL 0.17.3のASIO DeviceはDriverに加えて `asio_streams: Arc<Mutex<AsioStreams>>` と出力callback flagを持つ。
同じdriver名を独立列挙して得たDevice同士は、Driver内部を共有しても `asio_streams` は別の場合がある。
入力・出力を解決した後、公開Device.id()が両方取得でき同じであることを確認し、出力Deviceのcloneを入力にも使う。
もとの入力Deviceは能力取得前に制御側で解放する。ID不明・不一致を名前の類似だけで受理しない。
WASAPIではDeviceを統一せず、この追加ID問い合わせも行わない。

固定依存の根拠は `cpal-0.17.3/src/host/asio/device.rs` のDevice／Clone・Devices::next、`asio-sys-0.2.6/src/bindings/mod.rs` のload_driverである。
ASIO列挙はDeviceごとにstream状態を作り、同名Driverの内部だけを再利用する。DeviceのCloneはそれらのArcも共有する。

## 選択rateと能力の根拠

出力rateは既存のoutput_config選択方針で決め、ASIOでは入力configにもそのrateを設定する。
入出力各方向の既定ch数を維持し、現在のf32 builderに対応するF32能力を次のどちらかで確認する。

- 選択rateがその方向のadvertised default rateと一致し、defaultのsample formatがF32。
- 同じ既定ch数・F32のsupported rangeが選択rateを明示的に含む。

一覧取得失敗でもdefault F32自身が示す同率は既知能力として扱う。非既定rate・別ch・別形式のrangeを対応と推測しない。
default形式が別でも明示F32 rangeがあれば、形式だけを理由にその能力の証拠を捨てない。
ただし現CPAL ASIOのsupported rangesはdefaultのsample formatを複製し、buildもdriver native formatとの一致を確認する。
純粋snapshotテストの組合せがそのまま実hardwareから返る／受理されるという保証ではない。

locked buffer検出と各方向への有効buffer反映は既存の方針を保ち、ASIO入力には補正後のoutput config.buffer_sizeを共有する。
min=max512の機器で128／256を要求した場合も、最後のinput prepareへ元の128／256を再適用せず512を渡す。DefaultはDefaultのまま共有する。
両方のplay成功時だけStartedを公開する。
defaultの512仮値を固定要求へ昇格させない。rate・Device整合はcallback時刻の物理的な正確さやdriver内部bufferの遅延を保証しない。

## 再試行と回収

ASIOでは、整合した入力だけを独立default rateへ戻すWASAPI向けfallbackを使わない。
能力整合の拒否、出力build拒否、入力build拒否は、同じ出力default fallback予算を一度だけ使える。
fallbackはその試行で取得したadvertised output default rate・Default bufferを要求し、新しい試行で両方向の能力を取り直して再びrateを揃える。
ASIOは最大2試行で、入力・出力別の追加retryを積み重ねない。play失敗は既存どおり開始失敗として両streamを回収する。

再試行前は生成済みstreamと未実行build closureを破棄する。次にその試行のローカルinput／output Deviceを明示的にdropし、制御側の共通cleanupで返却済みprocessor・共有キューを回収してから、次のhost／Device解決・能力snapshotへ進む。
出力build closureが持つprocessorは、入力先行buildが失敗して出力closureが未実行でも、callback返却キューを通して制御側で解放する。
両方向のbuild失敗は方向付きのエラーとして既存fallbackへ戻す。play失敗も両stream破棄後に終端cleanupし、Startedを通知しない。
ASIO Hostが持つloaded_driverはWeakであり、ローカルDeviceを持ったまま再帰すると古いdriverを再利用し得るため、この解放順を明示する。
このDevice解放境界はWASAPIの既存入力／出力retryでも使うが、選択条件・出力rate／有効bufferを保つ入力fallback・最大3試行の予算は変えない。

CPAL公開APIだけでは外部機器・driver clockの巻戻しを保証できない。失敗後の物理rateを以前の値に自動復元したとは主張しない。
固定binaryで要求config・最終Started・デバイス側設定を比較し、必要なら利用者の既存設定を確認する。

## 検証範囲

同一IDだけの共有clone、WASAPIの独立Device、48k要求／96k defaultで両config48k、拒否後の両96k、F32能力根拠、有限retry予算、Device drop→次snapshot順を非実機テストで確認する。
両build順で最初／2番目のbuild失敗、出力／入力play失敗、成功commit、未実行closureの回収、Device→processor→次snapshotの順をlifecycleテストで確認する。stream／callback／processorの回収とRT最終解放禁止は既存のlifecycleテストも実行する。純粋mockを物理ASIO driverの偽装として使わない。
実ASIOの受理・状態保持・停止再開・VSTありなし・trace差は独立review後に固定binaryで確認する。
この段階だけで1周期待ちの削減、capture／playback同期、全信号遅延の改善を確認したとはしない。
