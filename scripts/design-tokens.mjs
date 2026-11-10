// src/index.css の色トークンを、テーマ別の16進値に変換して design/tokens.json へ書き出す。
// 用途: Pencil（design/auralyn-screens.pen）の変数を index.css から一方向に作る。.pen 側で値を決めない。
// 使い方:
//   node scripts/design-tokens.mjs                 index.css から design/tokens.json を作る
//   node scripts/design-tokens.mjs --snippet vars  .pen の変数を更新する execute 用コードを出力する
//   node scripts/design-tokens.mjs --snippet bind 0 6  ①の写し（先頭から0〜5番目）の色を変数へ置き換えるコードを出力する
// .pen への適用は Pencil MCP の execute で行う。手順は design/README.md。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8');

// コメントを除き、指定セレクターの最初のブロックにある `--name: H S% L%` だけを読む。
function block(selector) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = text.search(new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{`));
    if (start < 0) throw new Error(`${selector} が index.css にありません`);
    const open = text.indexOf('{', start);
    const body = text.slice(open + 1, text.indexOf('}', open));
    const values = {};
    for (const match of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) {
        values[match[1]] = hslToHex(Number(match[2]), Number(match[3]), Number(match[4]));
    }
    return values;
}

function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// 実画面のクラスは light / dark / "dark gaming"。gaming は dark の上に重ねる。
const light = block(':root');
const dark = { ...light, ...block('.dark') };
const gaming = { ...dark, ...block('.gaming') };

const colors = {};
for (const name of Object.keys(light)) colors[name] = { light: light[name], dark: dark[name], gaming: gaming[name] };

const snippet = process.argv.indexOf('--snippet');
if (snippet >= 0) {
    const kind = process.argv[snippet + 1];
    if (kind === 'vars') {
        process.stdout.write(readFileSync(resolve(root, 'design/pen-scripts/set-variables.js'), 'utf8').replace('__TOKENS__', JSON.stringify(colors)));
    } else if (kind === 'bind') {
        const [from, to] = process.argv.slice(snippet + 2, snippet + 4).map(Number);
        if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) throw new Error('--snippet bind <from> <to> を整数で指定してください');
        process.stdout.write(readFileSync(resolve(root, 'design/pen-scripts/bind-tokens.js'), 'utf8').replace('__FROM__', String(from)).replace('__TO__', String(to)));
    } else {
        throw new Error('--snippet には vars か bind を指定してください');
    }
    process.exit(0);
}

const out = resolve(root, 'design/tokens.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: 'src/index.css', themes: ['light', 'dark', 'gaming'], colors, radius: { control: 10, card: 12, lg: 12, md: 10, sm: 8 } }, null, 2) + '\n');
console.log(`${Object.keys(colors).length} colors -> design/tokens.json`);
