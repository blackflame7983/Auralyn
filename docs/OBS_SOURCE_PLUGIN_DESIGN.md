# OBSソースプラグインの設計案（#223）

## 現状（2026-11-04）

- 本体の送信機能は `codex/obs223-production-readiness-20261103` などの未マージブランチに試作がある。main およびこの文書の更新時点の作業ブランチには入っておらず、公開済み通常版で利用できるとは扱わない。
- 受信側は別リポジトリ [Auralyn-OBS](https://github.com/blackflame7983/Auralyn-OBS) に実装されている。Windows x64・OBS Studio 32.2.2専用の試作で、ソース名は「Auralyn PCM（試作）」。実機検証の条件と残件は同リポジトリの [README](https://github.com/blackflame7983/Auralyn-OBS/blob/main/README.md) と [配布準備](https://github.com/blackflame7983/Auralyn-OBS/blob/main/docs/DISTRIBUTION_READINESS.md) を参照する。
- [公開Release](https://github.com/blackflame7983/Auralyn-OBS/releases)・インストーラーはまだない。配布の準備と実機・聴感等の受入は継続中で、仮想ケーブル不要という製品表示はまだ行わない。

以下は2026-11-02時点の設計案であり、実装・対応版・検証結果の正本ではない。試作では通信方式、rate、補間方式やライセンスなどがこの案と異なる。現行の詳細は上記リポジトリと本体の該当ブランチを確認する。方針は [優先順位の見直し](STRATEGY_REVISION_2026-11.md)、本体の配布条件は [ソース配布](../SOURCE-DISTRIBUTION.md)と [リリース計画](RELEASE_PLAN.md)。

## 構成と責任

```text
Auralyn Host（操作・同意・世代・状態表示、既存JSON-RPC）
  └ audio_engine sidecar
      加工済みの配信用音声 → 音量/緊急ミュート → 有界SPSC → 送信worker
                                                           │ ローカルIPC
OBSプロセス                                                ▼
  Auralyn Source plugin: 受信worker → clock補正/resample → obs_source_output_audio
```

本体はlibobsをリンクしない。OBSプラグインは独立したプロジェクト・成果物としてlibobsにリンクし、本体とはIPCだけで接続する。OBSを起動・配信開始・録画開始したり、シーン/既存ソースを書き換える機能をこのプラグインへ持たせない。通話は既存WASAPI/ASIOと仮想ケーブルの経路を維持する。OBSソースを選んでも、既存の通話経路や自分用モニターを暗黙に切り替えない。

初期範囲はWindows 11 x64、単一の配信用ステレオ送出。モノラルはL/R同値へ写像する。音声は32bit float、入力側の実rateを通知し、受信側でOBSのrateへ変換する。44.1/48/96kHzを初期試験対象とし、他rateは対応を宣言せず接続時に拒否する。VST/NR/内蔵処理の位置を変えず、raw音への代替を禁止する。

tapは配信用処理・出力gain・global muteを適用した後とする。独立試聴、原音比較用録音、テスト音を送出へ混ぜない。主出力と共有するcallbackで行うのは、事前確保したqueueへの有界コピーとatomic状態更新だけ。IPC、OSの待ち、ログ、割当、resampler、model処理は行わない。送信workerの停止・満杯で既存の主出力や自分用モニターを待たせない。キュー満杯・frame不正はfaultを立て、OBS経路を停止し、無音から明示再開する。

## IPCと世代

制御は同一Windows利用者にACLを制限した名前付きpipe、PCMは利用者限定の`Local`共有メモリ上の有界SPSCとする。ネットワーク待受は追加しない。複数instanceを列挙して利用者が明示選択する。PIDや名前だけで別Hostへ自動接続しない。session nonceや接続能力はログ・OBSのソース表示名へ含めない。

接続時にprotocol version、Host instance、Engine generation、stream generation、選択した配信用endpoint、rate/ch/format/block上限、容量とmute世代を照合する。共有領域のoffset/length、frame数、sequence、finiteなsampleを受信workerで検証し、不正値・不明version・範囲外なら無音のまま拒否する。共有メモリを信頼できる構造体として直接castしない。所有権とatomicのメモリ順序、map解放とworker joinの順序を実装時の契約にする。

接続状態は `未接続 → 接続照合 → 無音で準備 → 明示送出 → 稼働`。Stop・緊急mute・Engine交代・切断・format変更では世代を進め、双方のqueueとresampler履歴を破棄して無音へ戻す。受信workerは旧世代のpacketを捨て、接続が戻っても古い音を再送しない。源が同一である照合と新しいgenerationの準備は自動で再試行できるが、Host/Engine再起動後の音声開始とmute解除は利用者の明示操作を待つ。試聴・録音・比較候補も自動再開しない。

同じ送出を複数のOBSソースで受ける構成は初期版では拒否し、二重音を防ぐ。ソースの複製・コレクション切替では受信所有権を取り直す。最終録画トラックやデスクトップ音声の二重取り込みはOBS側で別に確認する。

## clock差とresampling

OBSの音声sourceは `OBS_SOURCE_AUDIO` と `obs_source_output_audio()` を使う。[公式Source API](https://docs.obsproject.com/reference-sources)が説明する出力契約に合わせ、packetのframe数と単調なtimestampを与える。Auralynのsample counterとOBSの送出clockを同一clockだと仮定しない。

プラグインの受信workerで可変比率のresamplingを行う。初期候補はlibsamplerateのstreaming `src_process`（`SRC_SINC_FASTEST`）。`src_ratio = OBS rate / Auralyn実rate` を基準とし、queue占有率の平滑値からゆっくり補正する。比率変更の平滑化は [Full API](https://libsndfile.github.io/libsamplerate/api_full.html) にある契約を使う。固定rate変換だけでは機器clockのppm差を吸収できないため、OBSの通常のrate変換へ任せきりにしない。

補正は初期案で±500ppmを上限、1秒当たりの変化を20ppm以下とする。目標は3blockの占有。occupancy増加時には入力消費が増える向きへ出力/入力比率を下げる。PI係数、filter遅延、補正飽和時間、初期安定時間は合成clock試験で固定する。上限に張り付きqueueが安全域を外れた場合は、音を間引いて継続せずfault・無音へ戻す。`src_new`等の確保・解放は接続のworker側だけで行い、rate/世代変更時に履歴をリセットする。実装時に選択版とhash、source、[BSD-2-Clauseの表記](https://libsndfile.github.io/libsamplerate/license.html)を固定する。今回は依存を追加しない。

## bufferと遅延の予算

48kHz相当の10ms block（480frame）を標準とし、rateに応じてframe数を変える。初期案は送信側queue上限2block、共有ring上限8block、受信側変換作業buffer上限2block。共有ringの目標占有は3block。各段の容量と遅延を別々に記録する。満杯時に無制限queueへ逃がさずfaultとする。

目標の共有部分30msに加え、送信queue、変換filter、worker scheduling、OBS内部のbufferとmixがある。容量上限の合計を通常遅延の実測値と呼ばない。Auralynの既存10msフレーム計算やVST申告値を足しただけで、OBS到達・映像同期を表示しない。初期値は安全な試作の出発点であり、ゲーセン配信の実測で調整する。自分用モニターをこのbridge経由へ変更しない。

停止通知・mute世代はPCMとは別の制御状態でも公開する。受信側で最新世代を確認し、旧音をqueueから排出して鳴らすことを禁止する。送信workerのheartbeatが100ms更新されない場合は古い共有bufferを捨て、以後は無音packetを出す。短いunderflowもそのblockは無音とし、反復時はfaultとして手動再開へ戻す。resamplerエラー、nonfinite、sequenceの欠落/逆行、queue overflowも無音にする。既存のraw/マイク/別ケーブルへ自動代替しない。

停止や異常直前に既にOBSへ渡した音は取り消せない。100msは検出期限の設計値であり、耳までの完全無音の期限ではない。実録画でfault検出から最後の音までの上限とばらつきを測り、C-6として別に判定する。

## ライセンスと分離配布

OBS上流は [README](https://github.com/obsproject/obs-studio/blob/master/README.rst) と [COPYING](https://github.com/obsproject/obs-studio/blob/master/COPYING)でGPL-2.0以降を示している。新規plugin自身も`GPL-2.0-or-later`として配布する方針とする。本体のGPL-3.0-onlyやASIO SDKの選択は変更しない。本体のGPL-3.0-only実装をpluginへコピーせず、共有するwire形式の定義と文書は両側で使える許諾を明示する。別ファイルにしただけで依存の配布条件がなくなるとは扱わない。

pluginは独立したversion、source commit、binary ZIP、source ZIP、SHA-256、source manifest、LICENSE/NOTICE、再現build手順を揃える。依存の改変とpatch・選択版も対応sourceへ含める。本体のSource ZIPと混同せず、同じ配布ページから対応を一意に追えるようにする。ASIO SDKや市販VST/driverをpluginへ同梱しない。

現在の `config/release-policy.json` と本体uploaderはpluginを扱わない。合意後の実装PRで別の検証・梱包jobを追加し、source欠落・hash不一致・dirty treeを拒否する。現行本体の公開ゲートを迂回しない。Store/MSIX版がOBSのpluginフォルダへ黙って書き込む構成にせず、利用者が別配布物を明示導入する。

## OBSの対象版

当初案はOBS Studio **33.0.0/33.0.1、Windows x64** だったが、現行試作は上記のとおり32.2.2に限定される。33.0系への対応・動作を宣言するものではない。当初は [33.0.1 release](https://github.com/obsproject/obs-studio/releases/tag/33.0.1) と配置規則を調べ、33.0.0のSDK/headersでbuildし33.0.1も検証することを想定していた。

32.2.2以外の版、ARM64/macOS/Linuxへの対応は宣言しない。minor/patch更新では起動・ソース保存/再表示・停止/再接続・rate変更・1時間clock試験を再実施し、major更新ではABI/loader/配置/source APIを再調査する。「対象版」は実機合格後にのみ製品の対応表へ載せる。

## 合意後に行う検証と採用ゲート

| 層 | 検証 | 成功と区別する未確認 |
| --- | --- | --- |
| 単体・機器なし | 不正長/version、複数reader、queue wrap/full、古い世代、mute競合、worker停止、callback alloc/free/待ち/I/Oゼロ | 実OBS到達・聴感 |
| 合成clock | ±50/100/250/500ppm、44.1/48/96k変換、1時間以上の占有/比率/位相傾向、scheduling揺らぎ・飽和で無音停止 | 実機clockの安定性、音楽の品質 |
| 隔離実OBS | 対象2版でソース追加→非公開録画、mute/Stop、Host/Engine/OBS停止・再起動、sleep、rate変更、二重ソース拒否 | 通常配信環境の合格 |
| 実信号・実機 | 1時間以上の参照/受信同時収録、clockずれの傾向、欠損、bridge追加遅延、停止後の残留音、CPU合計と上限 | 診断値だけで可聴成功とはしない |
| 経路維持 | OBS pluginと通話の既存仮想ケーブル、自分用分離monitor、歌枠の守る線 | plugin試験だけで他経路を合格にしない |
| 配布 | clean source再build、source/binaryの対応、依存表記、配置・削除・OBS更新、MSIX本体との併用 | 設計文書の存在を配布成功とはしない |

試作は許諾済み/自作信号を使い、実配信と区別する。A-4（clock）、C-6（誤送出）、F-3（導入手数）、G-1（OBS連携）、H-4（配布条件）、D-1（RT維持）を測る。現行仮想ケーブルとの同一作業比較と、#219の回帰を揃えて採用を判断する。個別の実機試験は進んでいるが、一般配布の受入全体を合格としない。
