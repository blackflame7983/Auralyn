# GPUI Kit の公式スキル

`gpui-kit/` と `gpui-kit-design-guides/` は、GPUI Kit（https://github.com/longbridge/gpui-kit）の
`skills/` を、試作が使う版と同じタグ `v0.11.0`（e97fe438129c5e4ccab504f2e6fafd9a4e396bba）から変更せずに写したもの。
ライセンスは Apache-2.0（`LICENSE-GPUI-KIT-APACHE`）。

- GPUI Kit の版を上げるときは、同じタグのスキルに差し替える。
- Auralyn の見た目の決定は `docs/DESIGN.md` を優先する。GPUI の試作で分かった知見と決定（試作ブランチの `docs/gpui/`）が main に入ったら、それも優先する。

# ponytail（簡潔さを保つ書き方とレビュー）

`ponytail/`・`ponytail-review/`・`ponytail-audit/` は、ponytail（https://github.com/DietrichGebert/ponytail）の
`skills/` を、版 5.3.3 の commit `ebd8654c2c627f721eb8f9c0d1bd4090a29f9e10` から変更せずに写したもの。
ライセンスは MIT（`LICENSE-PONYTAIL-MIT`）。hooks とほかのスキルは写していない。

- 利用者の指示（2026-11-25）：GPUI への移行は、ponytail を使い、コードが複雑になりすぎないよう定期的にレビューしながら進める。
- このリポジトリの規約（AGENTS.md、GARDENING）と食い違うときは、リポジトリの規約を優先する。
