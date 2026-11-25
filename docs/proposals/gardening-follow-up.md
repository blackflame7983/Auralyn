# ガード整備後の確認とmain保護の変更案

2026-11-17にnpm監査とGitHub APIで確認した。これは確認時点の記録であり、将来の設定や安全性の証明には使わない。

## npm監査は開発依存に11件、productionは0件

11件はパッケージ単位の件数で、独立した脆弱性11種類ではない。元の指摘はminimatchのglobpartsによるサービス拒否と、globのAbortSignalによる中断の回避である。

| 経路 | 現在の解決・要求 | 判断 |
| --- | --- | --- |
| typescript-eslint → typescript-estree → minimatch | 10.2.6、要求`^10.2.2` | 修正版11系は要求範囲外。最新版の親もこの要求なので、通常のlockfile更新では解消しない |
| archiver → archiver-utils／zip-stream → glob → minimatch | minimatch 9.0.9、要求`^9.0.4` | npmの修正候補はarchiver 8へのメジャー更新。配布スクリプトの互換確認が必要 |

`npm audit --omit=dev --json`は0件だった。Lint側はリポジトリ内の固定globを使い、配布側は`package_release.cjs`からローカル成果物を扱う。これだけで指摘の成立を完全に否定はしないが、製品が外部からglobを受け取る経路とは区別する。
npmが提案するtypescript-eslint 8.36.0への旧版化、archiverのメジャー更新、依存要求を越えるoverrideは行わない。前者はESLint 10との互換確認、後二者は配布処理の別検証が必要になるため、今回の規約整備へ混ぜない。

一次情報：[minimatchの指摘](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[globの指摘](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)。

## mainはルールセットで保護されているがCI必須化はない

旧branch protection APIは404を返したが、rulesets APIには有効な`main-protect`（ID 26780856）が存在した。
既定ブランチを対象に、削除禁止・force push禁止・PR経由を要求している。bypass設定はない。
必須CIの規則はなく、承認人数は0、Code Ownerレビューと最終pushの承認も必須ではなかった。
現在のmainには`frontend`、`checks`、`browser`、`rustsec`の成功結果があるが、成功結果の存在と必須化は別である。

変更案は[main-protection.json](main-protection.json)。既存の3規則と対象・bypassを維持し、GitHub Actions（app ID 15368）の`frontend`と`rustsec`を必須にする。
`frontend`は`checks`と`browser`の両成功を要求する集約jobなので、下位jobを別々に必須登録する重複を避ける。最新mainへの追随も要求する。
（追記 2026-11-25：`browser` は CI から外し、`frontend` は現在 `checks` と `rust` の両成功を要求する。）

書込権限を持つcollaboratorは所有者1人で、別の承認担当者がいなかった。Code Owner承認を必須にすると本人作成PRが承認不能になる場合があるため、この案には含めない。
ガード変更の独立した人間レビューをGitHubで強制するには、別の承認担当者を決めてから追加設定する。

## 承認後の適用結果

2026-11-17、ユーザーの明示承認後にJSONを`main-protect`へ適用した。直前の設定が提案作成時から変わっていないことを確認してから更新した。
適用後のAPI応答で、GitHub Actionsの`frontend`・`rustsec`の必須化、最新mainへの追随、既存3規則・対象・bypassの維持を確認した。
Code Ownerレビューと承認人数は変更していない。今回のローカル実装のpush・PR作成は行っていない。
設定は[main-protect](https://github.com/blackflame7983/Auralyn/rules/26780856)から確認できる。今後の変更では、この記録だけで現在値を判断せず再取得する。
