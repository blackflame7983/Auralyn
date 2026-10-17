# DSP release性能比較

2026-10-16 23:46 JST。基準HEADは`10233aa`（PR #16マージ後）、作業ブランチは`codex/dsp-release-performance`。
実機ストリームを使わず、未修正registry版nnnoiseless 0.5.2と現行の局所修正版を比較した。変更は計測example・登録・記録のみで、DSP本体・係数・モデル・依存バージョンは変更していない。

## 結果

初回処理とresetの中央値は現行版で短くなった。連続処理の中央値差は約−0.6%〜＋0.3%で、3回の実行の揺れと重なる範囲だった。明確な連続処理の改善・悪化とは結論しない。
2状態を同一スレッドで保持する場合、初回後の要求ヒープ量は86,408→103,784バイト（＋17,376バイト、約17 KiB）。1状態では現行版のほうが少なく、状態数に応じた増減がある。

以下は各runのp50を取り、その3値の中央値を示す。単位はµs、セルは「registry → 現行」。p50／p95／p99はnearest-rank、外れ値除去・タイマ差引きは行わない。
各runの連続処理・resetの分位点は、7 trialの生サンプルを結合して計算する。表は3 runを結合した分位点ではなく、各runの分位点の中央値である。trial内の連続サンプルを独立した実験の反復とは扱わず、差の統計的有意性や信頼区間は算出していない。

| 入力 | 初回処理 | 連続処理／frame | reset／回 |
| --- | ---: | ---: | ---: |
| silence | 98.0 → 34.0 | 19.2 → 19.2 | 1.7 → 0.6 |
| tiny | 96.8 → 33.8 | 18.9 → 18.8 | 1.5 → 0.6 |
| sine | 121.5 → 59.3 | 35.6 → 35.5 | 1.4 → 0.6 |
| noise | 128.3 → 60.8 | 35.6 → 35.4 | 1.3 → 0.6 |
| impulse | 121.9 → 60.7 | 36.0 → 36.0 | 1.3 → 0.6 |
| square | 122.4 → 60.6 | 35.7 → 35.8 | 1.4 → 0.6 |

### 連続処理のばらつき

noise入力の分布を抜粋する。p95／p99も3 runの各値の中央値、最大値は3 run全体の観測最大。単位はµs。

| 指標 | registry | 現行 |
| --- | ---: | ---: |
| p50 | 35.6 | 35.4 |
| p95 | 52.6 | 51.4 |
| p99 | 77.4 | 70.9 |
| 各runのp50範囲 | 35.5〜35.8 | 35.3〜35.9 |
| 観測最大 | 501.3 | 2892.5 |

現行版のnoise入力で最大2.8925 msを観測した。ほかの入力・実装にも長い外れ値があり、最大値の増減は条件・試行によって混在する。原因を特定した計測ではなく、OSスケジュールや背景処理も分離していない。中央値が近いことから最悪時間や実機安定性まで同一とは判断しない。

### 保持メモリ

単位はバイト、registry → 現行。同一スレッド上の1・2・8状態を、各ケース別プロセスで測定した。連続処理後・reset後の生存量は初回後と同じだった。メモリ測定を2回繰り返し、全値が一致した。

| 状態数 | 構築直後 | 初回処理後 | 状態破棄後・スレッド終了前 |
| --- | ---: | ---: | ---: |
| 1 | 31,684 → 51,892 | 54,724 → 51,892 | 23,040 → 0 |
| 2 | 63,368 → 103,784 | 86,408 → 103,784 | 23,040 → 0 |
| 8 | 253,472 → 415,136 | 276,512 → 415,136 | 23,040 → 0 |

現行版は構築時にFFT領域を各状態で保持し、原本は初回に23,040バイトのスレッド内キャッシュを追加した。原本の破棄後の23,040バイトは、スレッド終了前に保持しているキャッシュで、リークを示す値ではない。状態のBox内レイアウトは14,648→14,752バイト（＋104）で、上表のヒープ量に含まれる。

## 測定条件と範囲

- AMD Ryzen 7 7800X3D、8 cores／16 logical processors、Windows 11 Pro 10.0.26300。電源プランはバランス。優先度・affinityは変更せず、背景処理を停止していない。
- rustc／cargo 1.92.0、LLVM 21.1.3、x86_64-pc-windows-msvc。opt-level=3・LTO・panic=abort、dsp-verification feature無効をビルドログと起動ガードで確認。
- 時間は独自GlobalAllocのないdsp_performance、メモリは別バイナリdsp_retained_memoryで測る。既存の割当回数計測器は使わない。
- 1 DenoiseState、480 mono samples／frame、標準モデル、6種の有限PCM。初回は毎回別プロセス内で状態を構築してから新規スレッドへ移送し、最初のprocess_frameだけを測る。生成・new・スレッド／プロセス開始時間は含まない。CPU／OSのコード・ページキャッシュを消した測定ではない。
- 連続処理は新規スレッドで64 frameをwarmupしてから2,048 frame×7 trial。resetも各trialの先頭で64 frameをwarmupする。その最初のreset前には入力frame 0〜3を追加し、2回目以降は直前のreset後の出力確認1 frameに入力frame 0〜3を追加するため、reset前の履歴長は同一ではない。どちらの実装にも同じ順序で128回×7 trialを適用し、毎回全状態を初期化するresetを測る。
- 構築やDropの指示以外の準備・入力生成・記録用Vecの追加・出力検査・JSON生成は時間区間外。入力は事前生成し、各frameの時間記録は処理の間に挟まるため、通常の連続呼出しとキャッシュ等の条件まで同一ではない。black_boxによる観測とInstantの空区間コストは差し引かない。
- registryにはreset APIがないため、旧エンジンと同じ新品Boxへの置換（構築＋旧値Drop）と現行のin-place resetを比較する。newを非RT側へ前倒ししたコスト自体は未計測で、総起動時間の短縮は主張しない。
- 初回は31 sample／入力／実装、連続・resetは7 trial。各ペアの実行順を交互にし、全体を3 run実行。各runのsteady 14,336 samples、reset 896 samples／入力／実装。
- 空の時計対は平均24〜26 ns、p95は100 nsだった。特に短いresetの絶対時間はこの分解能・観測コストを含む。
- 測定外で各入力64 frameとreset後64 frameを全サンプル・VADのビット比較。初回の各ペア、連続・resetの各trialの最終出力もハッシュ比較し、一致した。時間測定中は値をblack_boxへ渡し、処理の削除を防ぐ。
- メモリはnoise入力65 frame後にreset。worker内のRust Layout要求サイズの生存差分で、Box内状態・所有Vec・FFT計画・スレッド内キャッシュを含む。fixtureのVec、stack、静的モデル、allocatorの管理領域・丸め、OS RSS／private working setは含まない。4,096バイトの確保・拡張・縮小・解放で測定器を検査した。
- メモリJSONのlive_bytesは各観測時点の保持量、peak_bytesは直前のbegin_phase以降の要求ヒープ生存差分の最大値。after_newだけは計測開始時から、after_resetはreset完了まで、after_dropは同じphaseを継続してreset後の出力確認・状態破棄までを含む。reallocは成功後の要求サイズ差分を記録し、allocator内部で一時的に旧・新領域が共存する量は測らない。registryの複数状態resetは逐次置換であり、旧エンジンの2状態同時置換のピーク値そのものではない。
- 2状態はステレオ相当を模した状態数で、エンジン全体・44.1k→48k変換・mix・VST・デバイスバッファを含む測定ではない。実機音声・音質・CPU使用率・遅延・長時間・デバイス切替・別CPU／OS・配布物は未検証。

## 再実行と記録

`src-tauri`で実行する。計測器featureを指定せず、コンパイル等の負荷を並行実行しない。出力先は新しいディレクトリを用意し、コマンドの失敗時には次へ進まない。

```powershell
cargo build --locked --release --example dsp_performance --example dsp_retained_memory
if ($LASTEXITCODE -ne 0) { throw "計測用ビルド失敗" }
$runDir = Join-Path (Get-Location) ("target/dsp-performance-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory $runDir | Out-Null
for ($i = 1; $i -le 3; $i++) {
    & target/release/examples/dsp_performance.exe > "$runDir/timing-$i.json"
    if ($LASTEXITCODE -ne 0) { throw "時間測定失敗" }
}
& target/release/examples/dsp_retained_memory.exe > "$runDir/memory.json"
if ($LASTEXITCODE -ne 0) { throw "メモリ測定失敗" }
```

短い動作確認にはdsp_performance.exe --quickを使える。本結果にはpilotの値を使っていない。
集計値・各trial中央値・環境・ソース／バイナリSHA-256は[measurements/dsp-release-performance-2026-10-16.json](measurements/dsp-release-performance-2026-10-16.json)。全ns生データ・ログはignoredのsrc-tauri/target/dsp-performance/へ保存した。
このJSONだけでは生データからの再集計はできない。生データとログはGitの配布対象に含まれず、別環境では再実行が必要となる。

## ローカル検証

- 6入力の出力比較、全36条件×3 runの件数・分位点を生データから再計算して一致確認。メモリは別プロセスの6条件×2回で一致。
- cargo test --locked --example dsp_performance: 集計の既知データ検査1件成功。
- cargo check --locked --all-targets、通常構成とdsp-verificationを有効にしたrelease全targetの厳格Clippy: 成功。
- 初回Clippyの生成入力の剰余判定1件は、同じ判定のis_multiple_ofへ修正した。最終チェックは警告なし。詳細buildログには未修正registry版の既存cargo_c警告がある。
- Cargo.lock・DSP本体・同梱モデルは不変。実機ストリーム開始、性能改善実装、commit・push・PR作成は行わない。

### 2026-10-17 レビュー時の再確認

時間・保持メモリのバイナリ分離、初回の別プロセス条件、resetの新品置換とin-place初期化の対応を確認した。計測コードの変更は不要と判断し、reset前の履歴長、分位点の集計単位、メモリのpeak範囲、生データの保存範囲の説明を補った。元の測定値と測定時のSHA-256は変更していない。

- 生データから108条件の集計値・504個のtrial中央値・件数を再計算して一致。記録されたソースとバイナリのSHA-256、保持メモリの2回分の一致も再確認。
- `cargo test --locked --example dsp_performance`（1件）、`cargo clippy --locked --all-targets -- -D warnings`、3ソースのrustfmtチェック、`git diff --check`が成功。
- 記録と同じreleaseバイナリで`dsp_performance --quick`の36条件・出力比較が成功。`dsp_retained_memory`の全6条件は元の記録と完全一致。追加ログは`src-tauri/target/dsp-performance-review-44695bea52434273850ab7454dfe8a2b/`（ignored）。quickの時間は上表の集計に追加していない。
