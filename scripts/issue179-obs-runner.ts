import { chromium, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyObsAcceptance } from '../e2e/native/obsAcceptance.ts';

const session = JSON.parse(await readFile('test-results/issue179-session.json', 'utf8'));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
try {
    const page = browser.contexts()[0].pages().find(value => value.url().startsWith('http://127.0.0.1:1427'));
    if (!page) throw new Error('検証用HostのWebViewがありません');
    const info = { outputPath: (...parts: string[]) => join(session.root, 'results', ...parts) } as TestInfo;
    await verifyObsAcceptance(page, session.root, info);
    await writeFile(join(session.root, 'results', 'obs-real.json'), JSON.stringify({
        at: new Date().toISOString(), result: 'passed',
        scope: 'portable OBS preview/cancel/apply/history/undo; normal OBS settings hash unchanged',
    }, null, 2));
    console.log('実OBS: preview/cancel/apply/history/undo と通常設定の不変を確認');
} finally { await browser.close(); }
