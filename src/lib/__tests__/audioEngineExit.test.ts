import { describe, expect, it } from 'vitest';
import { message } from '../../i18n/messages';
import { crashedPluginMarker, renderAudioEngineExit, type AudioEngineExit } from '../audioEngineExit';
import { readPending } from '../pluginIdentity';

it.each(['ja', 'en'] as const)('%sでVST名と操作を表示する', locale => {
    const rendered = renderAudioEngineExit((key, args) => message(locale, key, args), { cause: 'vst_operation', op: 'load', name: 'Echo', path: 'C:/VST/Other.vst3' });
    expect(rendered).toBe(locale === 'ja' ? 'Echoの読み込みの途中で音声エンジンが停止しました。' : 'The audio engine stopped during loading for Echo.');
});

it.each(['C:\\VST\\実名.vst3', '/VST/実名.vst3'])('名前がない場合はパス%sのファイル名を表示する', path => {
    expect(renderAudioEngineExit((key, args) => message('ja', key, args), { cause: 'vst_operation', op: 'restore', path, name: ' ' }))
        .toBe('実名.vst3の復元の途中で音声エンジンが停止しました。');
});

it.each(['ja', 'en'] as const)('%sのunknownは残存メタデータからVSTを推定しない', locale => {
    const rendered = renderAudioEngineExit((key, args) => message(locale, key, args), { cause: 'unknown', name: 'Echo', path: 'C:/VST/Echo.vst3', op: 'load' });
    expect(rendered).toBe(locale === 'ja' ? '音声エンジンが停止しました。原因のVSTは特定できません。' : 'The audio engine stopped. The VST responsible could not be identified.');
    expect(rendered).not.toContain('Echo');
});

it.each(['load', 'restore', 'set_state', 'get_state', 'open_editor', 'remove', 'resume', 'processing_setup'] as const)('操作%sは日英で解決できる', op => {
    for (const locale of ['ja', 'en'] as const) {
        const rendered = renderAudioEngineExit((key, args) => message(locale, key, args), { cause: 'vst_operation', op, name: 'Echo' });
        expect(rendered).not.toMatch(/audioNotices|undefined|\{operation\}/);
        if (locale === 'en') expect(rendered).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    }
});

it('個別名や未知の操作がなくても安全な文言を返す', () => {
    expect(renderAudioEngineExit((key, args) => message('ja', key, args), { cause: 'vst_operation', op: 'future' } as unknown as AudioEngineExit))
        .toBe('VSTの操作の途中で音声エンジンが停止しました。');
});

describe('crashedPluginMarker', () => {
    it('Hostが特定したVSTを、読み込み以外の操作でも除外候補にする', () => {
        const marker = crashedPluginMarker({ cause: 'vst_operation', op: 'open_editor', path: 'C:/VST/Echo.vst3', classId: 'abc' }, null);
        expect(readPending(marker)).toEqual({ path: 'C:/VST/Echo.vst3', classId: 'abc' });
    });

    it('Hostの特定を、読み込み中の印より優先する', () => {
        expect(crashedPluginMarker({ cause: 'vst_operation', op: 'get_state', path: 'B.vst3' }, 'A.vst3')).toBe('B.vst3');
    });

    it('特定できないときは、読み込み中の印に戻す', () => {
        expect(crashedPluginMarker({ cause: 'unknown' }, 'A.vst3')).toBe('A.vst3');
        expect(crashedPluginMarker({ cause: 'vst_operation', op: 'processing_setup' }, null)).toBeNull();
        expect(crashedPluginMarker(undefined, null)).toBeNull();
    });
});
