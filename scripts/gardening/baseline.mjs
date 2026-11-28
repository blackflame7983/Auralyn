import { createHash } from 'node:crypto';

export const digest = text => createHash('sha256').update(text).digest('hex');

export function reconcile(actual, baseline) {
    const remaining = new Map();
    const errors = [];
    for (const entry of baseline) {
        const key = `${entry.file}|${entry.rule}|${entry.hash}`;
        if (!entry.reason?.trim() || !Number.isInteger(entry.count) || entry.count < 1 || remaining.has(key)) errors.push(`無効な例外: ${key}`);
        remaining.set(key, entry);
    }
    for (const entry of actual) {
        const key = `${entry.file}|${entry.rule}|${entry.hash}`;
        const previous = remaining.get(key);
        if (!previous) errors.push(`${entry.file}:${entry.line} ${entry.rule}: ${entry.message}`);
        else if (entry.count !== previous.count) errors.push(`${entry.file}:${entry.line} ${entry.rule}: 例外の件数が変わりました (${previous.count} → ${entry.count})。増加は修正し、減少は不要な例外を台帳から削除してください。`);
        remaining.delete(key);
    }
    for (const entry of remaining.values()) errors.push(`${entry.file} ${entry.rule}: 対象宣言が変更・削除されました。違反を修正して不要な例外を削除してください。指紋の更新による追認は禁止です。`);
    return errors;
}
