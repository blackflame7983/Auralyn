# 現行の実装計画と後続対応

実装・受入の状況は、現行コード、個別の検証記録、各GitHub Issueを照合して判断する。
戦略と優先順位は[2026-11の見直し](../STRATEGY_REVISION_2026-11.md)を参照する。

## プロセス入力は段階1の残る受入を確認する

[プロセス単独入力から、マイク＋オケとミックス後VSTへ拡張する](PROCESS_LOOPBACK_AND_MIXING.md)を現行計画とする。
別出力先を使える環境ではプロセス入力、使えない環境では仮想ケーブル入力を使い、ゲーセン配信素材でのNR評価につなげる。

- 段階0〜1のローカル実装とChrome・VLC各65分の記録は`74a3aba`に含む。[段階1の記録](../PROCESS_LOOPBACK_STAGE1.md)を参照する。
- 後続の[原音比較の切替改善](../COMPARISON_SWITCH_TRANSITION.md)は、利用者の再試聴でクリックノイズ・音量低下が許容範囲と確認済み。
- [改善版の長時間運転と異常時確認](../PROCESS_LOOPBACK_FOLLOWUP_2026-11-02.md)を追加した。callback遅延・音声待機の評価と、機器切断などの未確認条件は残る。
- 利用者提供のゲーセン配信で[現行NRを比較](../NR_MATERIAL_EVALUATION_2026-11-02.md)し、「NRありで周囲の環境音が減り、好ましい」という聴感結果を得た。強度ごとの優劣と声の保持の評価は残る。
- [停止後に学習値を失う不具合を修正](../PROCESS_INPUT_LEARNING_RETENTION_2026-11-03.md)し、実素材の声用途でのNR切替と、実WASAPI機器入力・プロセス入力間の学習値の保持を確認した。物理マイク・ASIOの確認は別に残す。
- 段階2〜3の二入力ミックス・時間合わせ・ミックス後VSTには、段階1後に他の残件と優先順位を比較して着手する。

## 後続は素材・実機の準備状況に応じて進める

| 対応 | 追跡先 | 次に確認すること |
| --- | --- | --- |
| プロセス単独入力の残る受入 | [#233](https://github.com/blackflame7983/Auralyn/issues/233) | 遅延・待機と聴感を評価し、機器切断などを確認する。Chrome音声子プロセス終了後は元アプリ側の読み直しで復帰する条件を記録済み |
| ゲーセン配信素材でのNR比較 | [#220](https://github.com/blackflame7983/Auralyn/issues/220)・[#93](https://github.com/blackflame7983/Auralyn/issues/93) | NRありへの好評価と実Engineでの切替を確認済み。強度と声の保持、歌の回帰、物理マイクでの学習結果保護を確認する |
| 未保存状態の退避・復帰 | [#221](https://github.com/blackflame7983/Auralyn/issues/221) | [所有者・復帰範囲の契約](../UNSAVED_RUNTIME_RESTORE.md)と、単一出力・カスタム構成・声用途の機器入力のコード改修を完了。[確認記録](../UNSAVED_RUNTIME_ACCEPTANCE_2026-11-03.md)でVST欠落・空ラック・音量ゼロを含む実Hostの結果と、別に残るV-03を確認する |
| 全構成の保存・復帰 | [#222](https://github.com/blackflame7983/Auralyn/issues/222) | [分離出力・枝別処理・trim](../OUTPUT_CONFIGURATION_RESTORE.md)、[歌／雑談・関連VST](../LIVE_MODE_STATE_RESTORE.md)、[プロセス単独入力](../PROCESS_STATE_RESTORE.md)の保存・復帰に対応。プロセス入力と処理分離・モードの組合せ、一時利用前の分離出力退避とV-04の実機受入は残す |
| 主シナリオの導線と実機評価 | [#109](https://github.com/blackflame7983/Auralyn/issues/109)・[#72](https://github.com/blackflame7983/Auralyn/issues/72) | 評価で特定した操作上の問題を改善し、同じ条件で再測定する |
| 歌枠の遅延・音切れの基準値 | [#211](https://github.com/blackflame7983/Auralyn/issues/211)・[#219](https://github.com/blackflame7983/Auralyn/issues/219) | 物理配線と歌の固定素材を使う。プロセス入力の65分を代用にしない |
| OBSソースプラグイン | [#223](https://github.com/blackflame7983/Auralyn/issues/223) | 先にライセンス・配布、クロック、停止・再接続、互換性を設計する |

素材・実機の準備を待つ間は、一時利用前の分離出力・モード退避を拡張する。
#221の[5条件との対応](../UNSAVED_RUNTIME_RESTORE.md#221の5条件を今回の改修範囲へ対応付ける)を明記した。契約と初期範囲のコード改修に、#222の全構成保存と共有PCの実機受入を混ぜない。
一時利用前の退避では、プロセス入力・分離出力まで復帰可能と扱わない。
NRの変更や二入力への拡張は、関連する受入条件を満たしたと確認してから判断する。

## 実装済みの設計契約

[本番モードとVSTラックの一体切替](LIVE_MODE_VST_TRANSACTION.md)は実装済み範囲の設計資料として保持する。
実機受入の状況は同文書から参照する実装・検証記録で確認する。

2026-07の旧6計画と文言棚卸しは削除した。実装前の前提や古い順序が現在の残件と混同されるためである。
既存機能の品質は現行コード・[検証手順](../TESTING.md)・[文言ガイドライン](../COPY_GUIDELINES.md)と各Issueで確認する。
旧文書が必要な場合は、`74a3aba`時点の`docs/plans/`をGit履歴から参照できる。
