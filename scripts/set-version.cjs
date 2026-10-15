const fs = require('fs');
const path = require('path');

function assertStableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
      || version.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('安定版の番号 X.Y.Z を指定してください（先頭の v、先頭ゼロ、検証版・build metadata は不可）。');
  }
}

// TOML全体を再整形せず、指定セクションのversionだけを更新する。
function replaceSectionVersion(text, sectionPattern, version, label) {
  let count = 0;
  const updated = text.replace(sectionPattern, (section) => {
    count += 1;
    if (!/^version\s*=\s*"[^"]+"/m.test(section)) throw new Error(`${label} に version がありません。`);
    return section.replace(/^(version\s*=\s*")[^"]+(".*)$/m, (_, prefix, suffix) => `${prefix}${version}${suffix}`);
  });
  if (count !== 1) throw new Error(`${label} を一意に特定できません。`);
  return updated;
}

function planVersionUpdate(root, version) {
  assertStableVersion(version);
  const files = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  // 全ファイルの読込み・構造検証が済むまで書き込まない。
  return files.map((file) => {
    const absolutePath = path.join(root, file);
    const original = fs.readFileSync(absolutePath, 'utf8');
    let updated;
    if (file.endsWith('.json')) {
      const data = JSON.parse(original);
      if (typeof data.version !== 'string') throw new Error(`${file} に version がありません。`);
      data.version = version;
      if (file === 'package-lock.json') {
        if (typeof data.packages?.['']?.version !== 'string') throw new Error('package-lock.json にルートパッケージの version がありません。');
        data.packages[''].version = version;
      }
      updated = JSON.stringify(JSON.parse(original)) === JSON.stringify(data)
        ? original : JSON.stringify(data, null, 2) + '\n';
    } else if (file.endsWith('.toml')) {
      updated = replaceSectionVersion(original, /^\[package\][\s\S]*?(?=^\[|$(?![\s\S]))/gm, version, `${file} [package]`);
    } else {
      updated = replaceSectionVersion(original, /^\[\[package\]\]\r?\nname = "vst-host"\r?\n[\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm, version, `${file} vst-host`);
    }
    return { file, absolutePath, original, updated, changed: original !== updated };
  });
}

function run(args, root = path.resolve(__dirname, '..')) {
  const check = args.includes('--check');
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (args.some((arg) => arg.startsWith('--') && !['--check', '--dry-run'].includes(arg))
      || (check && (dryRun || positional.length > 0)) || (!check && positional.length !== 1)) {
    throw new Error('使い方: npm run set-version -- <X.Y.Z> [--dry-run] または npm run set-version -- --check');
  }
  const version = check ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version : positional[0];
  const plan = planVersionUpdate(root, version);
  const changes = plan.filter((entry) => entry.changed);
  if (check && changes.length) throw new Error(`バージョン不一致: ${changes.map((entry) => entry.file).join(', ')}`);
  if (!check && !dryRun) {
    for (const entry of changes) fs.writeFileSync(entry.absolutePath, entry.updated);
  }
  console.log(`${check ? '同期確認' : dryRun ? '変更予定（書込みなし）' : '同期完了'}: ${version}`);
  for (const entry of changes) console.log(`- ${entry.file}`);
}

if (require.main === module) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { assertStableVersion, planVersionUpdate, run };
