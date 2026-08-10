# Auralyn GPL配布とリポジトリ公開方針

## 決定

- Auralynの現行版は`GPL-3.0-only`で配布する。
- 開発リポジトリ`blackflame7983/Auralyn`は、機密情報と履歴の公開監査が終わるまでPrivateを維持する。
- 公開リポジトリ`blackflame7983/Auralyn-Releases`の各Releaseには、バイナリと同じGit commitから生成した対応ソースを必ず添付する。
- GPLは有料配布を禁止しないが、受領者の複製・改変・再配布・販売を制限しない。排他的な販売モデルは別プロダクトで扱う。

## リポジトリの役割

| リポジトリ | 可視性 | 役割 |
|---|---|---|
| `blackflame7983/Auralyn` | 当面Private | 開発、Issue、ビルド、署名 |
| `blackflame7983/Auralyn-Releases` | Public | バイナリ、更新情報、各版の対応ソース |

開発リポジトリがPrivateでも、GPLv3 section 6(d)に従い、バイナリの取得場所から追加料金なしで対応ソースへアクセスできる状態を維持する。

## 各Releaseの必須アセット

- インストーラーとTauri updater署名
- `latest.json`
- `Auralyn_v{version}_Source.zip`
- `Auralyn_v{version}_Source.zip.sha256`
- `Auralyn_v{version}_Source.json`
- `LICENSE`、`NOTICE.md`、`SOURCE-DISTRIBUTION.md`
- 必要に応じてPortable版

Source ZIPには少なくとも`LICENSE`、`NOTICE.md`、`SOURCE-DISTRIBUTION.md`、ビルドスクリプト、`package-lock.json`、`src-tauri/Cargo.lock`、実ビルドで使用したASIO SDK 2.3.4の`common`／`host`ソースとライセンスを含める。

## 公開前ゲート

`npm run release:check`は次を検証する。

1. npm/Cargo/方針ファイルが`GPL-3.0-only`で一致している。
2. GPLv3全文、適切な法的告知、ASIO商標表示が存在する。
3. ASIO SDKをGPLv3選択肢で扱う記録がある。
4. ASIO SDK ZIPが固定SHA-256と一致し、同じSDKをビルドとSource ZIP生成の両方に使用する。
5. lockfileがGit管理され、対応ソースへ入る。
6. updater endpointと公開先が`Auralyn-Releases`で一致する。

`npm run release:source -- <version>`と`npm run release:upload -- <version>`は、worktreeがcleanでない場合に失敗する。これにより未コミット機能や、バイナリと説明の不一致を含むソース公開を防ぐ。

## 公開手順

1. `npm run set-version -- <version>`で版を同期する。
2. npm/Cargoの第三者ライセンス一覧を再生成する。
3. 新機能を含む全変更とlockfileをコミットする。
4. `npm run release:check`を実行する。
5. cleanな同じcommitからテストを実行する。
6. `npm run release:source -- <version>`で対応ソースを事前確認する。
7. `npm run release:upload -- <version>`で同じHEADから署名ビルドを再生成し、バイナリと対応ソースを同時公開する。
8. 未認証環境からバイナリ・Source ZIP・checksum・更新確認を実測する。

## 公開開発リポジトリへ移行する場合

Git履歴を含めた機密情報監査後は、開発リポジトリ自体をPublicにしてもよい。その場合も、別Releaseリポジトリでバイナリを配布する限り、各バイナリの横に対応ソースの取得先を明示する。GitHubの自動Source archiveだけに依存せず、リリースcommitとSHA-256を記録する。
