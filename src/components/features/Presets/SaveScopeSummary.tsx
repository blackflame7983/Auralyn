import { useMessages } from '@/i18n/LocaleProvider';

/** 保存の入口ごとに、実際の対象を同じ形式で示す。保存形式や範囲は変更しない。 */
export function SaveScopeSummary({ kind }: { kind: 'io' | 'profile' | 'session' }) {
    const t = useMessages();
    return <p className="text-ui-support text-muted-foreground"><span className="font-medium text-foreground">{t('save.includes')}: </span>{t(`save.${kind}Scope`)}</p>;
}
