# UI作り直しの方針決定（2026-11-04）

実アプリ（`codex/ui-ux-287-288-20261104` の ee3c818、デバッグ用設定で起動、1024×768）を見ながら、利用者と決めた方針。実装・検証の記録ではない。

## 実アプリで見えた問題

- セットアップ
  - 手順ごとにダイアログの高さが変わって上下に跳ねる。
  - 「自分で聴く」と「PCの音にエフェクトをかける」の違いが読めない。5枚目のカードが半端に余る。
  - 冒頭の「VB-CABLE 等の仮想ケーブルが必要です」は、OBSプラグイン対応後の今は正しくない。
  - 入力手順ではWASAPIの機器しか出ず、ASIOを選べない。理由も表示されない。
- ホーム（音声未設定のとき）
  - 「音声未設定」が3か所、黄色の警告が3つ出る。同じ意味のボタンも2つある（「セットアップを開く」「マイクと出力先を設定する」）。
  - 音調整の各行が「状態を読み取れません」と並び、故障に見える。
  - 本番帯が「歌・雑談の設定 ⌄」だけの大きな空のパネルになっている。
- 設定のオーディオタブ
  - 入力元・機器・チャンネルマッピング・ASIOの出力チャンネル・分離出力・配信ミックス・保存・歌モニターが1画面に縦に並び、高さが約1,500pxある。
  - 見出しの形が4種類混ざっている（枠に重なる見出し、ラベル、アイコン付きカード、大見出し）。

## 決めたこと

| 項目 | 決定 |
| --- | --- |
| 目的のカード | 4枚（OBS・通話・自分で聴く・その他）に統合し、2×2で並べる。「自分で聴く」を選んだら、次の手順で音の元（マイク／PCの音）を選ぶ |
| OBS連携 | プラグインを標準の方法として案内する。仮想ケーブルは「プラグインを使わない場合」の代わりの方法にする |
| ASIO | セットアップで接続方式を選べるようにする。ASIOでは入出力が同じ機器になることを案内する |
| セットアップの見た目 | 全体を作り直す。ダイアログの高さを固定し、手順の切替に動きを付け、選択中のカードにアクセント色を使う |
| 未設定のホーム | 次にやる1歩だけを大きく出す。音調整・本番帯・比較ボタンは、設定が済むまで目立たせない |
| 設定の構成 | 配信ミックス（オケ・配信音を仕上げるVST・歌モニター）をホームのパネルへ移し、表示するかを設定で切り替える。オーディオタブは機器と接続だけにする |
| 見た目と動きの規則 | ホームとセットアップについて、構造の異なる2〜3案を動く試作で作る。実アプリで見比べてから選ぶ |

## 登録したIssue

- 不具合・個別: [#289](https://github.com/blackflame7983/Auralyn/issues/289)（Voicemeeter ASIOで停止）、[#290](https://github.com/blackflame7983/Auralyn/issues/290)（アプリの音声が選べない理由）、[#291](https://github.com/blackflame7983/Auralyn/issues/291)（セットアップでASIO）、[#292](https://github.com/blackflame7983/Auralyn/issues/292)（OBSプラグインの案内）
- セットアップ: [#293](https://github.com/blackflame7983/Auralyn/issues/293)（目的カード4枚）、[#294](https://github.com/blackflame7983/Auralyn/issues/294)（見た目と動き）、[#295](https://github.com/blackflame7983/Auralyn/issues/295)（出力の空列）、[#296](https://github.com/blackflame7983/Auralyn/issues/296)（ラジオ位置）
- ホーム・設定: [#297](https://github.com/blackflame7983/Auralyn/issues/297)（未設定時の次の1歩）、[#298](https://github.com/blackflame7983/Auralyn/issues/298)（パネルの跳ね）、[#299](https://github.com/blackflame7983/Auralyn/issues/299)（配信ミックスをホームへ）、[#300](https://github.com/blackflame7983/Auralyn/issues/300)（見出しの規則）
- 追加で見つけたもの: [#302](https://github.com/blackflame7983/Auralyn/issues/302)（開いただけで変更予定）、[#303](https://github.com/blackflame7983/Auralyn/issues/303)（未設定時の初期値がASIO）、[#304](https://github.com/blackflame7983/Auralyn/issues/304)（送り先の並び順）、[#305](https://github.com/blackflame7983/Auralyn/issues/305)（ASIOの注意書きの位置）、[#306](https://github.com/blackflame7983/Auralyn/issues/306)（マイク許可の置き場所）、[#307](https://github.com/blackflame7983/Auralyn/issues/307)（未設定の赤）、[#308](https://github.com/blackflame7983/Auralyn/issues/308)（無効の「次へ」）、[#309](https://github.com/blackflame7983/Auralyn/issues/309)（失敗後に設定が残らない可能性）、[#310](https://github.com/blackflame7983/Auralyn/issues/310)（OBS設計文書）、[#311](https://github.com/blackflame7983/Auralyn/issues/311)（MCP起動手順）
- #302〜#311 対応後の確認で見つけたもの: [#312](https://github.com/blackflame7983/Auralyn/issues/312)（既定の機器を選ばない）、[#313](https://github.com/blackflame7983/Auralyn/issues/313)（保存がなくても読み込みボタン）、[#314](https://github.com/blackflame7983/Auralyn/issues/314)（Wasapi・PC の音の表記）
- 全体: [#301](https://github.com/blackflame7983/Auralyn/issues/301)（見た目と動きの規則を試作で決める）

## 試作の比較と選択（#301、2026-11-05）

`codex/ui-prototypes-301-20261105` の 00d914d で、3案を実アプリのウィンドウに表示して比べた（開発時に `?proto=a|b|c`、または Ctrl+Shift+P）。仮のデータで動かし、音声エンジンと保存設定には触れていない。

| 案 | 構成 | 比較で見えた長所 | 気になる点 |
| --- | --- | --- | --- |
| A ステージ（基本として採用） | 大きな本番帯を1つ置く。セットアップは高さを固定したダイアログで、左の手順レールに沿って横に進む | 迷いにくい。今の構成から移りやすい | 見た目が3案で一番おとなしい |
| B 音の流れ（未設定のホームを採用） | 「マイク→整える→送り方→送り先」の流れが画面の背骨。セットアップはダイアログを開かず、流れがそのまま手順になる | 音がどこを通るかが一目で分かる。決まった区間から線が光る | 送り先から決めるので、右端から始まる |
| C タイル | 機能ごとの大きなタイル。セットアップはウィンドウ全体を使う | 文字が最も少なく、押す場所が大きい | 各機能が何をするか伝わりにくい |

- 利用者の選択：**A を基本にし、未設定のホームだけ B の流れにする**。試作は `?proto=ab`（「A＋B 採用案」）。
- 理由（利用者の評価）:
  - 決め手は未設定のホームの差。A は分かりやすく迷いにくいが、VST ホスト・配信ツールとして並べて使いたくなると思えなかった。
  - A のセットアップには異論がなく、B と比べるとむしろ A の方が好き。
  - C はぱっと見て分かりやすいが、使いたくなると思えなかった。子ども向けの携帯電話を見ている気分になった。
- 「セットアップの見た目」の決定（高さ固定のダイアログ）は、A のセットアップを採るのでそのまま有効。
- 手順の名前は流れの区間名にそろえ、「目的」を「送り先」に改めた。
- 規則は `docs/DESIGN.md` 5.7 にまとめた。

## 未確定・要確認

- 未設定のホームの流れは右端の「送り先」から決め始める。この順のまま案内を工夫するか、決める順を変えるかは、#294・#297 の実装で実アプリを見て決める。

- OBSプラグインは [Auralyn-OBS](https://github.com/blackflame7983/Auralyn-OBS)（Windows x64・OBS 32.2.2専用の試作、ソース名「Auralyn PCM（試作）」）。公開Releaseはまだなく、本体の送信機能も main に入っていない。セットアップでプラグインを標準として案内するのは、この2つが揃ってからにする（[#292のコメント](https://github.com/blackflame7983/Auralyn/issues/292#issuecomment-6630696408)）。
- Voicemeeter Insert Virtual ASIO を選んで保存すると音声エンジンが止まる件は、まだ再現していない。デバッグ起動でエンジンのログを取れる状態にしてある。
- アプリの音声が選べない理由（ASIOを選んでいるため。`ProcessInputPanel.tsx`）を画面に出す件は、Issue化してから直す。
