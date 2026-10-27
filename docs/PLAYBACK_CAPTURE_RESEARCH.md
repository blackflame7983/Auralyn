# PC再生音の取り込み方式（Issue #111 段階2）

確認日: 2026-10-27〜28。段階2の調査記録であり、取り込みエンジンは実装していない。

## 判断

段階1では仮想ケーブルを使う。段階3の最初の検証候補は、WASAPI の再生エンドポイントを入力として扱う方式とする。同梱 CPAL にその基盤があり、既存の入出力ストリームへ接続する範囲を限定できるためである。ただし、同じ出力を取り込んで戻す自己循環と、加工前後の二重再生を避ける構成が成立するまで製品へ有効化しない。アプリ単位の取り込みは追加候補として保留する。

これは実機未検証の設計判断である。仮想ケーブル不要や遅延改善を保証するものではない。

## 方式の比較

| 観点 | 再生エンドポイントのループバック | プロセスループバック |
| --- | --- | --- |
| 対象 | 選んだ再生機器へ出る全アプリのミックス。全出力機器を1本で取り込む方式ではない | 指定 PID と子プロセスの音。対象を除外する指定もある |
| 対応条件 | WASAPI の共有モード。Windows 10 1703 以降はイベント駆動に対応 | Microsoft の API 定義・サンプルの最小条件は Windows 10 Build 20348。Issue の「2004以降」をそのまま対応保証にしない |
| 元の再生 | コピー元は鳴り続ける | コピー元は鳴り続ける。キャプチャ自体は再生を抑止しない |
| 遅延 | 機器の周期、キュー、DSP、出力の条件次第。数値は未測定 | 取り込み周期と同じ後段に加え、対象の変更・無音区間を測る必要がある。数値は未測定 |
| 現行ライブラリ | 同梱 CPAL 0.17.3 に render device を input stream に渡す実装がある | 現行 CPAL に PID を指定する公開経路は見当たらない。Windows API の capture adapter が必要 |
| 採否 | 別入力種別としての限定検証候補 | アプリ限定の需要と二重再生対策を確認してから追加する候補 |

Auralyn の製品サポートは従来どおり Windows 11 x64 とする。API の最小条件を、製品として検証済みの OS 一覧に読み替えない。

CPAL の公開資料も [公式 WASAPI 実装](https://github.com/rustaudio/cpal/blob/master/src/host/wasapi/device.rs) と照合した。公開資料の master は同梱版と API が異なる可能性があるため、実現可否の根拠は上記の同梱 0.17.3 を優先する。

対応条件とキャプチャの範囲は [Microsoft のプロセスループバック API](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params) と [公式サンプル](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) に基づく。共有モードとイベント駆動の条件は [Loopback Recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) を参照した。

## 二重再生と自己循環

どちらの方式も、元の再生音を自動で消す仕組みではない。加工前の音がヘッドホンへ届き、Auralyn の加工後の音も同じヘッドホンへ届けば二重になる。エンドポイント方式で Auralyn 自身の出力を取り込み元にすると、自己循環の危険もある。

入力用の再生先と、加工後を聴く出力先を明示的に分ける設計が必要になる。使っていない出力へ元アプリを送る案では、その出力をミュートした際に取り込み側まで無音にならないかを機器ごとに確認する。アプリの音量をゼロにする手順を、確認せず二重再生対策として勧めない。プロセス方式でも、対象アプリの出力先を変える必要が残る。

## 現行コードとの接続

- `third_party/cpal-0.17.3/src/host/wasapi/mod.rs` と `device.rs` は、再生機器に対する input stream 作成で `AUDCLNT_STREAMFLAGS_LOOPBACK` を設定する。
- Auralyn の `src-tauri/src/audio_engine/devices.rs` は、通常入力を `input_devices()` から解決する。出力名を入力欄へ追加するだけでは接続できない。入力の種別、実 ID、ホストを区別する契約が必要になる。
- `core.rs` の既存の rate 選択・ストリーム構築・異率変換へ接続し、取り込み側の mix format、処理 rate、出力 rate を区別する。形式変更や機器消失では停止と再選択へ戻し、別機器へ無言で切り替えない。元の音を聴かずに取り込める専用の再生先を用意できない場合は、この方式を勧めず仮想ケーブル方式を案内する。
- プロセス方式は `ActivateAudioInterfaceAsync` と非同期 COM 初期化、対象 PID の寿命、capture buffer を既存の有界キューへ渡す adapter の設計が必要になる。既存 `windows` crate の feature だけで実現できる範囲は未コンパイルであり、依存追加が不要とは断定しない。
- `loopback_probe` は接続確認用の短時間取得であり、常時取り込みとして流用しない。
- [FRAME_TIMING.md](FRAME_TIMING.md) の内部観測は、耳まで・OBSまでの遅延ではない。実装後は加工前と加工後の外部録音を含め、二重再生、停止、rate 変更、無音、長時間運転を別に検証する。

段階3で必要になる設計・検証を整理したもので、今回はライブラリ、音声 callback、入力ストリーム、既定デバイスを変更していない。
