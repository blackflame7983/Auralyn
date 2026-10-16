# Auralyn向け局所修正

基準はcrates.ioのnnnoiseless 0.5.2。公開crateのSHA-256は
`805d5964d1e7a0006a7fdced7dae75084d66d18b35f1dfe81bd76929b1f8da0c`、
upstreamのVCSコミットは`924a2dd143ccad7bce9e5bda061b60ca32911a67`。
元の各ファイルのSHA-256は`UPSTREAM_HASHES.json`に保持する。
Cargoの取得済みcrateをコピーし、キャッシュ用.cargo-ok、単独crate用Cargo.lock、
upstreamのCI設定だけを除外した。元のCOPYING・AUTHORS・モデルデータを保持する。
Cargo.toml.origはupstream原本の参照用で、ビルドに使う定義はCargo.toml。

## 変更範囲

- `src/fft.rs`を追加。同じrealfft 3.5.0のforward／inverse計画と
  入力コピー・複素数バッファ・scratchを構築時に確保する。
  easyfftのTLS planner／scratchへ初回処理中に到達しない。
- `src/features.rs`のforward／inverse呼出しだけを新しい作業領域へ接続する。
  DynRealDftのデータ形式、窓、正規化、スペクトル演算、合成の式は変えない。
  共有の窓・DCT表はnewで準備し、信号の処理状態は進めない。
- DenoiseState、DenoiseFeatures、RnnState、PitchFinderにin-place resetを追加。
  全状態領域をnewと同じ初期値へ戻し、確保した領域とモデルを保持する。
  FFTの作業バッファもゼロ化するが、計画の再構築・破棄はしない。
- `src/lib.rs`に私有fftモジュールを追加。
- Cargo.tomlへ、従来easyfft経由で固定されていたrealfft 3.5.0の直接参照と、
  upstreamの既存cargo_c cfgを認識するcheck-cfg設定を追加する。
- .gitattributesでテキストのLFとモデルのバイナリ扱いを明示し、Windowsの
  checkout・ソース配布でもモデルや原本照合用テキストを改変しない。

モデル`src/weights.rnn`、係数、RNN・pitchの演算本体はupstreamと同一。
ライブラリのバージョンアップや別のFFTアルゴリズムへの移行ではない。
Cloneは従来どおり状態を複製し、新たな作業領域も複製する。
reset以外の既存公開シグネチャ・feature定義は維持する。

## 検証と保守

Auralynのdev-dependency `nnnoiseless_reference`は未修正のregistry版0.5.2を指す。
`src-tauri/src/audio_engine/core/dsp_rt_tests.rs`で同じ入力の出力とVADをビット比較し、
新規スレッドへの状態移送後の初回処理、連続処理、reset後の新品状態との一致、
確保・解放0回を確認する。構築・Clone・最終破棄は非RT側で行うこと。

upstream crateにはtest_dataが同梱されていないため、同梱されたupstream単体テスト
一式の成功を主張しない。Auralyn側の比較テストを検証の入口とする。
未使用のbin／dasp／train／capi featureと他プラットフォームは未検証。

将来更新するときはUPSTREAM_HASHESと局所差分を照合し、状態フィールド追加を
resetへ反映する。モデルや演算の差分がある場合は、このパッチと混ぜず判断する。
公式配布では、このディレクトリ全体を対応ソースへ同梱する。
