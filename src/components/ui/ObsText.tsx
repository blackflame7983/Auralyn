import { useMessages } from '@/i18n/LocaleProvider';
import { obsTextParts } from '@/lib/obsUiText';
import { ErrorDetails } from './ErrorDetails';

// 未知の文や失敗理由を本文に混ぜず、項目ごとの詳細に残す。
export function ObsText({ text, legacy, parts }: { text?: unknown; legacy?: unknown; parts?: ReturnType<typeof obsTextParts> }) {
    const t = useMessages();
    const { summary, detail } = parts ?? obsTextParts(t, text, legacy);
    return <>{summary ?? t('obsSetup.textUnavailable')}{detail && <ErrorDetails detail={detail} />}</>;
}
