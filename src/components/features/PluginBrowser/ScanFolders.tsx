import { useId, useState, type FormEvent } from 'react';
import type { MessageKey } from '@/i18n/messages';
import { useMessages } from '@/i18n/LocaleProvider';
import type { SkippedScanRoot } from '@/api/audio';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
    STANDARD_VST_SCAN_FOLDERS,
    addExtraScanFolder,
    readExtraScanFolders,
    removeExtraScanFolder,
    scanFolderKey,
    writeExtraScanFolders,
    type ScanFolderReject,
} from '@/lib/vstScanFolders';

const rejectKey: Record<ScanFolderReject, MessageKey> = {
    empty: 'pluginBrowser.scanFolderEmpty',
    duplicate: 'pluginBrowser.scanFolderDuplicate',
    invalid: 'pluginBrowser.scanFolderInvalid',
    full: 'pluginBrowser.scanFolderFull',
};

function reasonKey(reason: string): MessageKey {
    switch (reason) {
        case 'missing': return 'pluginBrowser.scanFolderMissing';
        case 'not_directory': return 'pluginBrowser.scanFolderNotDirectory';
        default: return 'pluginBrowser.scanFolderInvalid';
    }
}

export function ScanFolders({ disabled, skippedRoots = [], onChanged }: {
    disabled: boolean;
    skippedRoots?: SkippedScanRoot[];
    onChanged: () => void;
}) {
    const t = useMessages();
    const headingId = useId();
    const [folders, setFolders] = useState(readExtraScanFolders);
    const [draft, setDraft] = useState('');
    const [formError, setFormError] = useState<string | null>(null);

    const commit = (next: string[]) => {
        if (!writeExtraScanFolders(next)) {
            setFormError(t('pluginBrowser.scanFolderSaveFailed'));
            return;
        }
        setFolders(next);
        setDraft('');
        setFormError(null);
        onChanged();
    };
    const add = (event: FormEvent) => {
        event.preventDefault();
        if (disabled) return;
        const result = addExtraScanFolder(folders, draft);
        if (!result.ok) {
            setFormError(t(rejectKey[result.reason]));
            return;
        }
        commit(result.folders);
    };
    const remove = (path: string) => {
        if (disabled) return;
        commit(removeExtraScanFolder(folders, path));
    };

    // 一覧から VST を選ぶ場所なので、ふだんは閉じておく。追加したフォルダーが見つからないときだけ開いて理由を見せる。
    const hasIssue = folders.some(path => skippedRoots.some(item => scanFolderKey(item.path) === scanFolderKey(path)));
    return <section aria-labelledby={headingId} className="mb-3 border-t border-border pt-3">
        <details open={hasIssue || undefined} className="group">
        <summary className="cursor-pointer">
            <h3 id={headingId} className="inline text-ui-control font-semibold">{t('pluginBrowser.scanFolders')}</h3>
            <span className="ml-2 text-ui-support text-muted-foreground">{t('pluginBrowser.scanFolderCount', { count: STANDARD_VST_SCAN_FOLDERS.length + folders.length })}</span>
        </summary>
        <div className="mt-2 space-y-2">
        <p className="text-ui-support text-muted-foreground">{t('pluginBrowser.scanFoldersHint')}</p>
        <ul className="max-h-28 space-y-1 overflow-y-auto">
            {STANDARD_VST_SCAN_FOLDERS.map(path => <li key={path} className="flex items-center justify-between gap-2 text-ui-support">
                <span className="min-w-0 break-all">{path}</span>
                <span className="shrink-0 text-muted-foreground">{t('pluginBrowser.scanFolderStandard')}</span>
            </li>)}
            {folders.map(path => {
                const issue = skippedRoots.find(item => scanFolderKey(item.path) === scanFolderKey(path));
                return <li key={path} className="flex items-start justify-between gap-2 text-ui-support">
                    <span className="min-w-0">
                        <span className="break-all">{path}</span>
                        {issue && <span role="status" className="mt-0.5 block text-warning">{t(reasonKey(issue.reason))}</span>}
                    </span>
                    <Button type="button" variant="outline" size="sm" className="h-auto min-h-9 shrink-0 whitespace-normal"
                        aria-label={t('pluginBrowser.scanFolderRemoveNamed', { path })}
                        disabled={disabled}
                        onClick={() => remove(path)}
                    >{t('pluginBrowser.scanFolderRemove')}</Button>
                </li>;
            })}
        </ul>
        <form className="flex flex-wrap items-end gap-2" onSubmit={add}>
            <div className="min-w-[12rem] flex-1">
                <Field label={t('pluginBrowser.scanFolderPath')} error={formError}>
                    <Input value={draft} disabled={disabled} autoComplete="off" spellCheck={false}
                        onChange={event => { setDraft(event.target.value); setFormError(null); }} />
                </Field>
            </div>
            <Button type="submit" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={disabled}>{t('pluginBrowser.scanFolderAdd')}</Button>
        </form>
        </div>
        </details>
    </section>;
}
