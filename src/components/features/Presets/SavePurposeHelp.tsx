import { InfoPopover } from '@/components/ui/InfoPopover';
import { useMessages } from '@/i18n/LocaleProvider';

// 登録・保存の各入口で、対象と使う場面を同じ内容で確認できるようにする。
export function SavePurposeHelp() {
    const t = useMessages();
    return <InfoPopover label={t('saveHelp.title')}>
        <dl className="space-y-3">
            <div><dt className="font-semibold">{t('saveHelp.modeTitle')}</dt><dd className="mt-1">{t('saveHelp.mode')}</dd></div>
            <div><dt className="font-semibold">{t('saveHelp.profileTitle')}</dt><dd className="mt-1">{t('saveHelp.profile')}</dd></div>
        </dl>
        <p className="mt-3 border-t border-border pt-3">{t('saveHelp.appliedOnly')}</p>
    </InfoPopover>;
}
