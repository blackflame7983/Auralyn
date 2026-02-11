---
name: github-management
description: GitHub CLI (gh) を使用して、Issueの追跡、PRのライフサイクル、レビュー処理などを管理するための包括的なガイド。
---

# GitHub管理スキル (GitHub Management Skill)

`gh` CLI を使用して GitHub Issue、PR、Project を操作します。

## 1. Issue 管理 (`create-issue`, `update-issue`)

### Issue 作成
**推奨**: 可能な場合は Web から `.github/ISSUE_TEMPLATE` を使用してください。
**CLI フォールバック**:
```bash
gh issue create --title "タイトル" --body "説明" --label "enhancement" --assignee "@me"
```

### Issue 更新 (実装の同期)
実装が元の Issue から乖離した場合に使用します。
1.  **差分確認**: 実装と Issue 要件を比較。
2.  **更新**:
    ```bash
    gh issue edit <ISSUE_NUM> --body "更新された説明..."
    ```
3.  **プロジェクトステータス**:
    ```bash
    # プロジェクト管理コマンドがある場合
    nr project:status --issue <ISSUE_NUM> --status in_review
    ```

## 2. Pull Request ライフサイクル (`create-pr`)

### フェーズ 1: 準備
1.  ブランチ確認: `git branch --show-current`
2.  変更確認: `git diff master...HEAD --stat`

### フェーズ 2: 作成
**タイトル**: Conventional Commit 形式 (`feat: ...`)
**本文**: `Closes #123` を含める必要があります。
```bash
gh pr create --title "feat: 新機能の追加" --body-file pr-body.md
```

### フェーズ 3: レビューフィードバック (`view-pr-comments`)
特定の行のコメントを取得:
```bash
gh api repos/:owner/:repo/pulls/:number/comments --jq '.[] | {path:.path, line:.line, body:.body}'
```

## 3. プロジェクトボード統合

**ステータスフロー**: `Backlog` -> `Ready` -> `In progress` -> `In review` -> `Done`
