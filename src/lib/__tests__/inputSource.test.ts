import { expect, it } from 'vitest';
import { deviceInput, engineInputName, usesAppAudio, type InputSource } from '../inputSource';

const app: InputSource = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Game', rawEndpointId: 'endpoint', purpose: 'voice' } };

it.each([
    { name: '保存もエンジンも機器入力', saved: deviceInput(), engine: deviceInput(), expected: false },
    { name: '保存もエンジンも未確認', saved: undefined, engine: undefined, expected: false },
    { name: '保存した設定だけがアプリの音声', saved: app, engine: deviceInput(), expected: true },
    { name: 'エンジンの実際の入力だけがアプリの音声', saved: deviceInput(), engine: app, expected: true },
    { name: '保存は未設定でエンジンがアプリの音声', saved: undefined, engine: app, expected: true },
    { name: '両方ともアプリの音声', saved: app, engine: app, expected: true },
])('どちらかがアプリの音声なら、アプリの音声を入力にしていると見なす：$name', ({ saved, engine, expected }) => {
    expect(usesAppAudio(saved, engine)).toBe(expected);
});

it.each([
    { name: 'アプリの音声は、機器名が null でもアプリ名', config: { input: null, input_source: app }, expected: 'Game' },
    { name: 'アプリの音声は、機器名より入力元を優先する', config: { input: 'Mic', input_source: app }, expected: 'Game' },
    { name: '機器入力は機器名', config: { input: 'Mic', input_source: deviceInput() }, expected: 'Mic' },
    { name: '入力元を持たない旧い設定は機器名', config: { input: 'Mic' }, expected: 'Mic' },
    { name: '機器名が無く、アプリの音声でもないときは名前なし', config: { input: null, input_source: deviceInput() }, expected: undefined },
    { name: '空の機器名は名前なし', config: { input: '' }, expected: undefined },
    { name: '設定が無いときは名前なし', config: null, expected: undefined },
])('実行中の入力は利用者に分かる名前で返す：$name', ({ config, expected }) => {
    expect(engineInputName(config)).toBe(expected);
});
