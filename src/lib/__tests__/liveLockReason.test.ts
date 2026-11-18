import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isLiveLockRejection, LIVE_LOCK_REJECTION_MARKER } from '../liveLock';

const root = resolve(import.meta.dirname, '../../..');
const source = readFileSync(resolve(root, 'src-tauri/src/audio_engine/live_modes.rs'), 'utf8').replace(/\r\n/g, '\n');

const commands = readFileSync(resolve(root, 'src-tauri/src/audio_engine/core/commands.rs'), 'utf8').replace(/\r\n/g, '\n');

function protectedReason(): string {
    const match = /pub\(crate\) const PROTECTED: &str =\s*"([^"]+)";/.exec(source);
    if (!match?.[1]) throw new Error('src-tauri の PROTECTED の文を読めませんでした。見分けの語と文の一致を確かめる試験を、定義の形に合わせて直してください。');
    return match[1];
}

it('バックエンドの保護の拒否文を、フロントの見分けが拒否として扱う', () => {
    const reason = protectedReason();
    expect(reason).toContain(LIVE_LOCK_REJECTION_MARKER);
    expect(isLiveLockRejection(reason)).toBe(true);
    expect(isLiveLockRejection(new Error(reason))).toBe(true);
});

it('保護以外の失敗は、保護の拒否として扱わない', () => {
    expect(isLiveLockRejection('Plugin not found')).toBe(false);
    expect(isLiveLockRejection(new Error('engine busy'))).toBe(false);
});

it('同じ「本番保護中は」で始まる別の拒否（出力構成の変更）は、VST の保護の拒否として扱わない', () => {
    const related = '本番保護中は出力構成を変更できません';
    expect(commands).toContain(related);
    expect(isLiveLockRejection(related)).toBe(false);
    expect(isLiveLockRejection(new Error(related))).toBe(false);
});
