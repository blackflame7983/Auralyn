import { RuleTester } from 'eslint';
import parser from '@typescript-eslint/parser';
import path from 'node:path';
import plugin from './eslint-plugin.mjs';

const tester = new RuleTester({ languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' } });
const ui = path.resolve('src/components/Example.tsx');
tester.run('owned-timers', plugin.rules['owned-timers'], {
    valid: [
        { filename: ui, code: 'function f(setTimeout) { setTimeout(); }' },
        { filename: path.resolve('src/hooks/internal/polling.ts'), code: 'setTimeout(tick, 100)' },
    ],
    invalid: [
        'setTimeout(tick, 100)', 'window.setInterval(tick, 100)', "globalThis['requestAnimationFrame'](tick)",
        'const later = setTimeout; later(tick, 100)', 'const { setTimeout: later } = window; later(tick, 100)',
    ].map(code => ({ filename: ui, code, errors: [{ messageId: 'forbidden' }] })),
});
tester.run('owned-effects', plugin.rules['owned-effects'], {
    valid: [
        { filename: ui, code: 'function useEffect() {} useEffect()' },
        { filename: path.resolve('src/hooks/useExample.ts'), code: "import {useEffect} from 'react'; useEffect(() => {}, [])" },
    ],
    invalid: [
        "import {useEffect as effect} from 'react'; effect(() => {}, [])",
        "import * as React from 'react'; React.useEffect(() => {}, [])",
        "import React from 'react'; React.useLayoutEffect(() => {}, [])",
    ].map(code => ({ filename: ui, code, errors: [{ messageId: 'forbidden' }] })),
});
tester.run('architecture', plugin.rules.architecture, {
    valid: [{ filename: path.resolve('src/lib/example.ts'), code: "import {a} from './audioChannelRouting'" }],
    invalid: [
        { filename: path.resolve('src/lib/example.ts'), code: "import {PluginCard} from '@/components/features/PluginRack/PluginCard'" },
        { filename: path.resolve('src/lib/example.ts'), code: "export * from '../components/features/PluginRack/PluginCard'" },
        { filename: path.resolve('src/lib/example.ts'), code: "import('../components/features/PluginRack/PluginCard')" },
        { filename: ui, code: "import {invoke} from '@tauri-apps/api/core'" },
        { filename: path.resolve('src/lib/model/example.ts'), code: "import {helper} from '../appVisibility'" },
        { filename: path.resolve('src/lib/model/example.ts'), code: "const saved = localStorage.getItem('key')" },
        { filename: path.resolve('src/lib/model/example.ts'), code: "const data = globalThis.fetch('/api')" },
        { filename: path.resolve('src/lib/example.ts'), code: 'import(variable)' },
    ].map(item => ({ ...item, errors: [{ messageId: 'forbidden' }] })),
});
tester.run('no-double-assertion', plugin.rules['no-double-assertion'], {
    valid: ['const value = { mode: "insert" } as const'],
    invalid: ['const value = input as unknown as Model', 'const value = <Model><unknown>input'].map(code => ({ code, errors: [{ messageId: 'forbidden' }] })),
});
tester.run('no-suppression', plugin.rules['no-suppression'], {
    valid: ['const ok = 1'],
    invalid: ['// eslint-disable-next-line\nconst value = 1', '// @ts-ignore\nconst value = 1', '// @ts-expect-error: TS1234 reason\nconst value = 1', "test.skip('ignored', () => {})", "import {test as scenario} from '@playwright/test'; scenario['skip']()"].map(code => ({ code, errors: [{ messageId: 'forbidden' }] })),
});
