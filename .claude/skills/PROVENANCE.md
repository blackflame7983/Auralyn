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

# impeccable（デザインの監査・調整の手順）

`impeccable/` は、impeccable（https://github.com/pbakaus/impeccable）の `.claude/skills/impeccable/` から、
`SKILL.md`（版 4.11.1）と `reference/` だけを、commit `2fc5e1459efbbf06d92c7306517c286bf12490cf`（2026-11-26）から変更せずに写したもの。
ライセンスは Apache-2.0（`LICENSE-IMPECCABLE-APACHE`）。`reference/ios.md`・`reference/android.md` は ehmo の platform-design-skills（MIT、https://github.com/ehmo/platform-design-skills）を元に書き直したもの（impeccable の NOTICE.md による）。

- `scripts/`（初回にバイナリを取りに行く起動スクリプト、ブラウザーに差し込む live モードの JS）は写していない。
  そのため `impeccable context` などの命令は動かず、SKILL.md の「Launcher unavailable」の手順（PRODUCT.md・DESIGN.md を直接読む）で使う。
- 利用者の指示（2026-11-27）：audit → bolder → polish の流れでデザインを監査・修正する。
- Web 向けの記述は GPUI に読み替える：CSS の値は `gpui_kit` の style、`prefers-reduced-motion` は `cx.reduce_motion()`、
  画面の確認はブラウザーでなく Windows の実機。Auralyn は「Operate」（道具の画面）に当たる。
- 見た目の決定は `docs/DESIGN.md` と `docs/gpui/decisions.md` を優先する。

# anything-frontend-art-direction（題材から意匠を決める手引き）

`anything-frontend-art-direction/` は、https://github.com/RNA4219/anything-frontend-art-direction の
`SKILL.md`・`references/`・`checklists/` を、commit `046e42c7de149373993109cf4a211a577b1c3bcc`（2026-11-24）から変更せずに写したもの。
ライセンスは MIT（`LICENSE-ANYTHING-FRONTEND-MIT`）。

- 作例（`examples/`、数 MB の単体 HTML）・`templates/`・書体事例データ（`data/typography/`）・`sources.md` は大きいので写していない。
  SKILL.md の中のそれらへのリンクは切れている。必要なら上の commit を直接読む。
- Web（ブラウザー）向けの記述は、上の impeccable と同じく GPUI に読み替える。
