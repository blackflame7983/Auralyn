import { expect, it } from 'vitest';
import { message } from '@/i18n/messages';
import { renderShortcutError } from '../shortcutNotice';

it.each([
    ['tooManyBindings', 'Up to 8'],
    ['invalidShortcut', 'Check the shortcut format: Alt+KeyM'],
    ['modifierRequired', 'Use a modifier'],
    ['duplicateBinding', 'cannot be registered twice'],
    ['stateUnavailable', 'Could not retrieve shortcut settings'],
    ['loadFailed', 'Could not read the saved shortcut settings'],
    ['registerFailed', 'Could not register Alt+KeyM'],
    ['registrationConflict', 'Check for conflicts with other apps'],
    ['saveFailed', 'Could not save shortcut settings'],
    ['unregisterFailed', 'Could not unregister a previous shortcut'],
    ['operationFailed', 'Could not complete the shortcut settings operation'],
    ['audioStateUnavailable', 'Could not retrieve the audio state'],
    ['gainPending', 'gain adjustment is still being confirmed'],
    ['actionFailed', 'Could not apply the shortcut action'],
])('native理由 %s は英語案内と未翻訳詳細を分離する', (code, expected) => {
    const result = renderShortcutError((key, args) => message('en', key, args), { code, shortcut: 'Alt+KeyM', detail: 'OS: 未翻訳の実名' });
    expect(result).toContain(expected);
    expect(result).toContain('Original detail (untranslated): OS: 未翻訳の実名');
    expect(result.split('\n')[0]).not.toMatch(/[ぁ-んァ-ン一-龯]/);
});

it.each(['旧Hostの日本語', { code: 'futureError', detail: 'OS raw 実名' }, { code: 'toString' }, new Error('外部エラー')])('未知のエラー %j を翻訳済み扱いにしない', error => {
    expect(renderShortcutError((key, args) => message('en', key, args), error)).toMatch(/^Original detail \(untranslated\): /);
});
