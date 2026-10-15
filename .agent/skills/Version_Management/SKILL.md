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
4. 反映を依頼された場合に `npm run set-version -- <version> --dry-run`、続いて `npm run set-version -- <version>` を実行する。
5. `npm run set-version -- --check`、`npm run test:release`、`npm run release:check` と変更範囲の検証を行う。

同期対象はpackage.json、package-lock.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock。
フロントの表示は `import.meta.env.PACKAGE_VERSION` を使う。
同期スクリプトは番号の判断・依存更新・コミット・タグ作成・公開を行わない。
push・PR・タグ・公開は、ユーザーが許可した対象と範囲でのみ実施する。
