import { createHash } from 'node:crypto';
import ts from 'typescript';

export const digest = text => createHash('sha256').update(text).digest('hex');

export function statementFingerprint(source, file, line, column, ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)) {
    const offset = ast.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1));
    const statement = ast.statements.find(node => node.getFullStart() <= offset && offset < node.end);
    return digest((statement ? statement.getText(ast) : source).replaceAll('\r\n', '\n'));
}

export function groupFindings(results, readSource, relative) {
    const groups = new Map();
    for (const result of results) {
        if (!result.messages.length) continue;
        const file = relative(result.filePath);
        const source = readSource(result.filePath);
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        for (const message of result.messages) {
            if (message.fatal || !message.ruleId) throw new Error(`${file}:${message.line} ${message.message}`);
            let hash = statementFingerprint(source, file, message.line, message.column, ast);
            if (['auralyn/no-suppression', 'auralyn/no-comment-workaround'].includes(message.ruleId)) {
                const start = ast.getPositionOfLineAndCharacter(message.line - 1, message.column - 1);
                const end = message.endLine ? ast.getPositionOfLineAndCharacter(message.endLine - 1, message.endColumn - 1) : source.indexOf('\n', start);
                hash = digest(`${hash}|${source.slice(start, end < 0 ? undefined : end).replaceAll('\r\n', '\n')}`);
            }
            const key = `${file}|${message.ruleId}|${hash}`;
            const entry = groups.get(key) ?? { file, rule: message.ruleId, hash, count: 0, line: message.line, message: message.message };
            entry.count++;
            groups.set(key, entry);
        }
    }
    return [...groups.values()].sort((a, b) => `${a.file}|${a.rule}|${a.hash}`.localeCompare(`${b.file}|${b.rule}|${b.hash}`));
}

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
