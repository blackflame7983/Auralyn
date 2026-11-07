import { useMessages } from '@/i18n/LocaleProvider';

// 原文は閉じた詳細に置き、要約と次の操作は呼び出し元で示す。
export function ErrorDetails({ detail }: { detail: string }) {
    const t = useMessages();
    return <details className="min-w-0 text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">{t('common.rawDetail')}</summary>
        <pre className="mt-2 select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono">{detail}</pre>
    </details>;
}
