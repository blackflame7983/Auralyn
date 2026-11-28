---
name: version-management
description: Auralynの変更内容からバージョンとタグを提案し、承認された番号を同期する。
---

# Version Management

作業入口はルート `AGENTS.md`。バージョンの正本は `docs/VERSIONING.md`。
古い同期コード例やモデルの記憶ではなく、必ず現行の正本・実装を確認する。

1. 前回公開安定版と対象SHAを特定し、コミット済み・未コミットを含む全変更を確認する。
2. 保存データ、音声、VST3、対応環境、OBS連携の互換性からmajor / minor / patch / noneを評価する。
3. 正本の形式で候補番号・タグ・理由・互換性・検証・未確認事項・ノート案を提示する。コミット接頭辞だけで判断しない。
4. 反映を依頼された場合は、直下 `Cargo.toml` の `[workspace.package] version` を書き換え、`cargo update -w --offline` で `Cargo.lock` を合わせる。
5. 変更範囲の検証（`npm run verify -- --static --rust` など）を行う。GPUI 版の配布手順ができるまで公開はしない。

番号の判断・依存更新・コミット・タグ作成・公開は、番号の反映とは別に扱う。
push・PR・タグ・公開は、ユーザーが許可した対象と範囲でのみ実施する。
