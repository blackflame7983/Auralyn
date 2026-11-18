import { expect, it } from 'vitest';
import { deviceInput, usesAppAudio, type InputSource } from '../inputSource';

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
