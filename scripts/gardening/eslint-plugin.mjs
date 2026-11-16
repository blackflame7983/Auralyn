import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const normalize = value => value.replaceAll('\\', '/');
const filename = context => normalize(path.relative(root, context.filename));
const testFile = name => /(?:__tests__|\.(?:test|spec)\.)/.test(name) || name.startsWith('e2e/');
const infrastructure = name => name.startsWith('src/hooks/internal/');
const hooksFile = name => name.startsWith('src/hooks/') || /\/use[A-Z][^/]*\.tsx?$/.test(name);
const propertyName = node => node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined;

function binding(context, node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    if (node.type === 'MemberExpression') {
        const owner = binding(context, node.object, seen);
        return owner ? `${owner}.${propertyName(node.property)}` : undefined;
    }
    if (node.type !== 'Identifier') return undefined;
    let scope = context.sourceCode.getScope(node);
    while (scope) {
        const variable = scope.set.get(node.name);
        if (variable) {
            const definition = variable.defs[0];
            if (!definition) return node.name;
            if (definition.type === 'ImportBinding') {
                const source = definition.parent.source.value;
                const imported = propertyName(definition.node.imported);
                return source === 'react' ? `react.${imported ?? 'namespace'}` : ['test', 'it', 'describe'].includes(imported) ? `tests.${imported}` : undefined;
            }
            if (definition.type === 'Variable') {
                if (definition.node.id.type === 'ObjectPattern') {
                    const prop = definition.node.id.properties.find(item => item.value?.name === node.name);
                    const owner = binding(context, definition.node.init, seen);
                    return owner && prop ? `${owner}.${propertyName(prop.key)}` : undefined;
                }
                return binding(context, definition.node.init, seen);
            }
            return undefined;
        }
        scope = scope.upper;
    }
    return node.name;
}

const rule = (message, create) => ({ meta: { type: 'problem', schema: [], messages: { forbidden: message } }, create });

export default {
    rules: {
        'owned-effects': rule('UI内のEffectは購読と状態遷移の責務を混在させます。操作はイベントハンドラへ、外部同期はsrc/hooks/の専用hookへ移してください。', context => {
            const name = filename(context);
            if (testFile(name) || hooksFile(name) || !name.startsWith('src/components/')) return {};
            return { CallExpression(node) {
                const target = binding(context, node.callee);
                if (/^react\.(?:namespace\.)?(?:useEffect|useLayoutEffect)$/.test(target ?? '')) context.report({ node, messageId: 'forbidden' });
            } };
        }),
        'owned-timers': rule('生タイマーは重複実行と解除漏れを招きます。pollはsrc/hooks/usePolling.ts、描画はsrc/hooks/useAnimationFrame.tsを使ってください。単なる待機で状態の完了を推測しないでください。', context => {
            const name = filename(context);
            if (testFile(name) || infrastructure(name)) return {};
            return { CallExpression(node) {
                const target = binding(context, node.callee);
                if (/^(?:(?:window|globalThis)\.)?(?:setTimeout|setInterval|requestAnimationFrame)$/.test(target ?? '')) context.report({ node, messageId: 'forbidden' });
            } };
        }),
        'architecture': rule('依存方向が逆です。共有型・純粋計算はsrc/lib/へ、Tauri呼出しはsrc/api/へ置き、UIからhook/APIを参照してください。src/libの純粋計算からUI・hookを参照しないでください。', context => {
            const name = filename(context);
            if (testFile(name)) return {};
            const check = node => {
                if (typeof node.value !== 'string') {
                    if (/^src\/(?:lib|api|constants)\//.test(name)) context.report({ node, messageId: 'forbidden' });
                    return;
                }
                const specifier = node.value;
                const resolved = ts.resolveModuleName(specifier, context.filename, compilerOptions, ts.sys).resolvedModule;
                const target = resolved ? normalize(path.relative(root, resolved.resolvedFileName)) : specifier;
                const reverse = /^(?:src\/(?:lib|api|constants)\/)/.test(name) && /^src\/(?:components|hooks|contexts)\//.test(target);
                const pureToInfra = name.startsWith('src/lib/model/') && !target.startsWith('src/lib/model/');
                const uiToNative = name.startsWith('src/components/') && specifier.startsWith('@tauri-apps/');
                const apiToHook = name.startsWith('src/api/') && /^(?:react|sonner)(?:\/|$)/.test(specifier);
                if (reverse || pureToInfra || uiToNative || apiToHook) context.report({ node, messageId: 'forbidden' });
            };
            return {
                ImportDeclaration: node => check(node.source),
                ExportNamedDeclaration: node => { if (node.source) check(node.source); },
                ExportAllDeclaration: node => check(node.source),
                ImportExpression: node => check(node.source),
                Identifier(node) {
                    if (!name.startsWith('src/lib/model/') || !['window', 'globalThis', 'document', 'navigator', 'fetch', 'localStorage', 'sessionStorage', 'process', 'Date'].includes(node.name)) return;
                    const reference = context.sourceCode.getScope(node).references.find(item => item.identifier === node);
                    if (reference && !reference.resolved?.defs.length) context.report({ node, messageId: 'forbidden' });
                },
            };
        }),
        'no-double-assertion': rule('二重アサーションは型検査を迂回します。src/api/またはsrc/lib/のunknown入力を検証する関数で絞り込んでください。テストデータもsatisfiesか完全なfixtureで作成してください。', context => ({
            TSAsExpression(node) { if (['TSAsExpression', 'TSTypeAssertion'].includes(node.expression.type)) context.report({ node, messageId: 'forbidden' }); },
            TSTypeAssertion(node) { if (['TSAsExpression', 'TSTypeAssertion'].includes(node.expression.type)) context.report({ node, messageId: 'forbidden' }); },
        })),
        'no-suppression': rule('新規のLint・型・テスト抑制は許可されていません。原因を修正してください。例外が必要ならdocs/GARDENING.mdに従い人間の承認を得てください。', context => ({
            Program() {
                for (const comment of context.sourceCode.getAllComments()) {
                    if (/eslint-(?:disable|enable)|@ts-(?:ignore|nocheck|expect-error)|istanbul ignore|c8 ignore|v8 ignore/.test(comment.value)) context.report({ loc: comment.loc, messageId: 'forbidden' });
                }
            },
            MemberExpression(node) {
                if (['skip', 'skipIf', 'runIf', 'todo', 'only', 'fail', 'fails', 'fixme'].includes(propertyName(node.property)) && /^(?:tests\.)?(?:it|test|describe)(?:\.(?:describe|serial|parallel|concurrent))?$/.test(binding(context, node.object) ?? '')) context.report({ node, messageId: 'forbidden' });
            },
        })),
        'no-comment-workaround': rule('待機や暫定策の正当化は再発原因を残します。状態遷移・完了イベント・型で根拠を表し、仕様上必要な説明は仕様への参照を付けてください。', context => ({
            Program() {
                for (const comment of context.sourceCode.getAllComments()) {
                    if (/\b(?:HACK|FIXME|workaround)\b|とりあえず|Small delay to let/i.test(comment.value)) context.report({ loc: comment.loc, messageId: 'forbidden' });
                }
            },
        })),
        'no-literal-color': rule('UI色の直書きはテーマ・コントラスト検証を迂回します。src/index.cssの意味別トークン（bg-card、text-foreground等）かCSS変数を使ってください。', context => ({
            JSXAttribute(node) {
                if (testFile(filename(context))) return;
                if (node.name.name === 'className' && node.value?.type === 'Literal' && /(?:bg|text|border|fill|stroke)-\[(?:#|rgb|hsl)/.test(node.value.value ?? '')) context.report({ node, messageId: 'forbidden' });
                if (node.name.name === 'style' && node.value?.expression?.type === 'ObjectExpression') {
                    for (const property of node.value.expression.properties) {
                        if (/(?:color|background|fill|stroke)/i.test(propertyName(property.key) ?? '') && property.value?.type === 'Literal' && typeof property.value.value === 'string' && !/^(?:var\(|currentColor|inherit|transparent)/.test(property.value.value)) context.report({ node: property, messageId: 'forbidden' });
                    }
                }
            },
        })),
    },
};
