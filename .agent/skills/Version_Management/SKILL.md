---
name: version-management
description: Tauriプロジェクトにおけるバージョン管理のベストプラクティスと自動化手法。
---

# Version Management Skill

このスキルは、Tauriプロジェクトにおいて、`package.json` を「唯一の正解（Single Source of Truth）」とし、`src-tauri/tauri.conf.json` やフロントエンドコードへバージョン情報を自動的に同期させるための手法を提供します。

## ベストプラクティス

1.  **Single Source of Truth**: バージョン番号は `package.json` で管理し、他のファイルはそこから読み込むか、スクリプトで同期させます。
2.  **Frontend Injection**: フロントエンドでは `package.json` を直接インポートせず、ビルドツール（Viteなど）の `define` 機能を使用して、環境変数としてバージョン番号を注入します。これにより、クライアントサイドバンドルに `package.json` 自体が含まれるのを防ぎます。
3.  **Automation**: `npm version` コマンドやカスタムスクリプトを使用して、手動での書き換えミスを防ぎます。

## 実装手順

### 1. バージョン注入 (Vite)

`vite.config.ts` で `package.json` を読み込み、`import.meta.env` に注入します。

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
// package.jsonを読み込む（assert type="json" はNodeのバージョンによるため、importやfsを使用）
import packageJson from './package.json';

export default defineConfig({
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version),
  },
  // ...
});
```

`src/vite-env.d.ts` に型定義を追加します。

```typescript
// src/vite-env.d.ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PACKAGE_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

### 2. 同期スクリプト

`scripts/set-version.js` を作成し、`package.json` と `tauri.conf.json` を同期させます。

```javascript
// scripts/set-version.js
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
    console.error('Please provide a version number (e.g., 0.4.0)');
    process.exit(1);
}

// Update package.json
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = require(packageJsonPath);
packageJson.version = version;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`Updated package.json to version ${version}`);

// Update tauri.conf.json
const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
const tauriConf = require(tauriConfPath);
tauriConf.version = version; // Tauri v1
if (tauriConf.package) tauriConf.package.version = version; // Tauri v2 beta might use different structure, check doc
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`Updated tauri.conf.json to version ${version}`);
```

### 3. npm script の追加

`package.json` にスクリプトを追加します。

```json
"scripts": {
  "set-version": "node scripts/set-version.js"
}
```

## 使用方法

新しいバージョンに更新する場合：

```bash
npm run set-version 0.4.0
```
