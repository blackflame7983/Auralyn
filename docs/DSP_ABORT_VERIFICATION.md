# panic=abort構成のDSP検証

2026-10-16。基準HEADは`e634918`（PR #15マージ後）、作業ブランチは`codex/dsp-abort-verification`。
rustc／cargo 1.92.0、LLVM 21.1.3、Windows x86_64-pc-windows-msvcで確認した。

## 検証の仕組み

通常のCargoテストはpanic=unwindを使うため、`dsp_abort_verification`を通常実行するexampleとして追加した。
明示的な`dsp-verification` featureが必要で、通常のビルドではexample・検証入口・計測器は含まれない。
このfeatureは配布ビルドでは有効にしない。比較用registry版nnnoiselessも、このfeatureを指定した場合だけ通常依存に追加される。
従来どおり、標準テストではdev-dependencyとして参照する。Cargo.lockや依存のバージョンは変更していない。

exampleとライブラリ側の入口の両方で、debug assertions無効・panic=abortであることを検査する。
ビルドの詳細ログでもexampleの`-C opt-level=3 -C lto -C panic=abort`と、ライブラリの`-C opt-level=3 -C panic=abort`を確認した。
`--test`は使わず、通常の実行バイナリを直接起動した。

検証は既存のdsp_rt_tests.rsの5関数を共有する。RtNoiseReducerの処理を別実装へコピーせず、実装そのものを呼び出す。
既存VST安全性テスト内のCountingAllocatorを私有の共通モジュールへ移し、カウンター・TLS・alloc／realloc／dealloc・測定終了処理のロジックは維持した。
記録用Vec・ファイル書込み・最終Dropは従来どおり測定区間外に置く。
最適化された通常バイナリでも陽性対照の確保・解放各1回を検出し、参照版の新規スレッドでの初回確保も検出した。

デバイス列挙、CPALストリームの開始、AudioEngineの起動、Tauri起動、VSTロードは呼び出さない。
メモリ内の入力を処理する検証用のスレッドだけを作り、OSの音声デバイスを使わない。
DSP係数・同梱モデル・窓・正規化・処理式・reset値を変更していない。

## ローカル検証結果

- `cargo build --locked --release --example dsp_abort_verification --features dsp-verification -vv`: 成功。
- 通常のpanic=abortバイナリで、初回／連続処理、標準・独自ownedモデルと借用モデルのreset、Clone元のreset・破棄、5レート×6位置のreducer resetが成功。
  未修正registry版とのサンプル・VADがビット一致し、測定区間の確保・解放は0回だった。
- 新しい空の記録先を使い、同じソースの`cargo test --locked --release --lib`でunwindの全51件が成功。
  `compare-dsp-snapshots.cjs`でabort／unwindの48ファイル・3,060,836バイトが完全一致した。
- 通常feature構成の`cargo test --locked --lib --bins --test audio_queue_contract`: lib 51件＋queue 2件成功。
- `cargo check --locked --all-targets`、通常構成の`cargo clippy --locked --all-targets -- -D warnings`、
  検証構成の`cargo clippy --locked --release --all-targets --features dsp-verification -- -D warnings`: 成功、警告0件。
- 初回の検証構成Clippyでは、構成を検査する定数assertが2件指摘された。同じ条件の分岐へ直し、再ビルド・再実行後も48ファイルが完全一致した。
  `git diff --check`と新規Rustファイル・共有検証ファイルの整形確認も成功した。
- 通常feature構成のnormal依存ツリーにはローカル版nnnoiselessだけがあり、検証featureを指定した場合だけregistry版が加わることを確認した。

ログ・出力記録はignoredの`src-tauri/target/dsp-abort-verification/`へ保存した。
配布用sidecar、比較用の生データや実行バイナリはコミット対象にしない。

## 再実行

`src-tauri`で実行する。各コマンドに成功した場合だけ次へ進み、毎回新しい記録先を作成する。

```powershell
cargo build --locked --release --example dsp_abort_verification --features dsp-verification
if ($LASTEXITCODE -ne 0) { throw 'abort検証用ビルド失敗' }
$runDir = Join-Path (Get-Location) ('target/dsp-abort-' + [guid]::NewGuid().ToString('N'))
$previousSnapshotDir = [Environment]::GetEnvironmentVariable('AURALYN_DSP_SNAPSHOT_DIR', 'Process')
try {
    New-Item -ItemType Directory -Path "$runDir/abort", "$runDir/unwind" | Out-Null
    $env:AURALYN_DSP_SNAPSHOT_DIR = "$runDir/abort"
    & target/release/examples/dsp_abort_verification.exe
    if ($LASTEXITCODE -ne 0) { throw 'abort検証失敗' }
    $env:AURALYN_DSP_SNAPSHOT_DIR = "$runDir/unwind"
    cargo test --locked --release --lib
    if ($LASTEXITCODE -ne 0) { throw 'unwind検証失敗' }
    node ../scripts/compare-dsp-snapshots.cjs "$runDir/unwind" "$runDir/abort"
    if ($LASTEXITCODE -ne 0) { throw '出力比較失敗' }
} finally {
    [Environment]::SetEnvironmentVariable('AURALYN_DSP_SNAPSHOT_DIR', $previousSnapshotDir, 'Process')
}
```

## 差分レビュー

通常の配布スクリプトはfeatureを指定せずにsidecarをビルドしており、cfgで検証入口・計測器・検証関数を除外する。
通常のnormal依存ツリーにはローカル版nnnoiselessだけが含まれることを再確認した。
共有した計測器のロジックと5つの検証関数の測定区間は移動前と一致し、RtNoiseReducerを含む既存エンジン本体の差分はない。
呼び出すのはDenoiseStateとRtNoiseReducerの構築・処理・reset、およびメモリ内の比較だけで、音声デバイス・ストリームへ到達する経路はない。

記録先の指定ミスがpanic=abortで異常終了していたため、exampleの入力検査をResultによるエラー終了へ変更した。
環境変数未指定・不存在ディレクトリ・ファイル指定・非空ディレクトリの4ケースを終了コード1で拒否し、成功表示や出力記録を生成せず、既存ファイルを保持することを確認した。
ディレクトリ検査のハンドルも検証へ入る前に閉じる。比較不一致・割当検出のassertは維持し、検証失敗を成功扱いにはしない。

修正後のpanic=abortバイナリの5検証関数と、新しい記録先でのunwind全51件が成功し、48ファイル・3,060,836バイトが完全一致した。
通常構成の`cargo build --locked --release --bin audio_engine -vv`も成功し、ライブラリのコンパイル引数に検証featureと比較用参照依存が含まれないことを確認した。
検証用release構成の全target厳格Clippyは警告0件。debug構成でもexampleをビルド・実行し、DSP検証へ入る前に終了コード1で拒否することを確認した。
通常構成のテスト53件・check・厳格Clippyは前段の同じ測定器・DSPソースでの結果を引き継ぎ、レビューでは変更したexampleの正常・異常系と上記のrelease検証を再実行した。
レビューのログ・記録はignoredの`src-tauri/target/dsp-abort-review/`へ保存した。

## 検証範囲

確認できたのは、計測器を有効にしたpanic=abort・release最適化の検証用バイナリ内の、対象DSPの出力とRust allocator経由の確保・解放である。
通常配布のaudio_engine.exeで音声を動かした結果ではない。構築・Clone・最終破棄は非RT側で行う前提を維持する。
音声コールバック全体の無割当・無Drop、他スレッドや外部DLL内の確保、任意モデル・非有限入力の全組合せは保証しない。
実機WASAPI／ASIO、実音声・音質・性能・CPU・遅延・長時間・デバイス切替、他CPU／OS、署名・インストーラー・公開配布は未検証。
実装・レビュー段階ではcommit・push・PR作成を行わず、提出はユーザーの明示承認後に行う。
