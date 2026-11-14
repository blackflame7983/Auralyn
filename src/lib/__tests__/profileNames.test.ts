import { expect, it } from 'vitest';
import { message } from '@/i18n/messages';
import { isRecoveryProfileName, profileDisplayName } from '../profileNames';

const recovery = 'VST-recovery-f6051925-1234-4abc-8def-0123456789ab';

it('UUID の形だけを復旧の退避とみなす', () => {
    expect(isRecoveryProfileName(recovery)).toBe(true);
    expect(isRecoveryProfileName('VST-recovery-abc')).toBe(false);
    expect(isRecoveryProfileName('VST-recovery-f6051925')).toBe(false);
    expect(isRecoveryProfileName('VST-recovery-F6051925-1234-4ABC-8DEF-0123456789AB')).toBe(false);
    expect(isRecoveryProfileName(`${recovery}-extra`)).toBe(false);
    expect(isRecoveryProfileName(`prefix-${recovery}`)).toBe(false);
    expect(isRecoveryProfileName('夜')).toBe(false);
    expect(isRecoveryProfileName('__backup_previous')).toBe(false);
});

it.each(['ja', 'en'] as const)('退避だけ、ID の先頭8文字を添えた表示名にする（%s）', locale => {
    const shown = profileDisplayName(recovery, locale);
    expect(shown).toBe(message(locale, 'profile.recoveryName', { id: 'f6051925' }));
    expect(shown).toContain('f6051925');
    expect(shown).not.toContain(recovery);
    expect(profileDisplayName('VST-recovery-abc', locale)).toBe('VST-recovery-abc');
    expect(profileDisplayName('夜', locale)).toBe('夜');
});
