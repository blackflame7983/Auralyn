import type { BundleDeviceLabel, BundleDeviceRole } from '@/api/bundles';
import type { useMessages } from '@/i18n/LocaleProvider';

// 旧応答に表示名がなくても、識別用IDを通常の表示へ戻さない。
export function deviceDisplayName(t: ReturnType<typeof useMessages>, name: string | null | undefined, role: BundleDeviceRole | 'device') {
    return name?.trim() || t('bundle.device.unknown', { role: t(`bundle.device.role.${role}`) });
}
export function missingDeviceNames(t: ReturnType<typeof useMessages>, count: number, labels: BundleDeviceLabel[] | undefined, role: BundleDeviceRole | 'device' = 'device') {
    return Array.from({ length: count }, (_, index) => deviceDisplayName(t, labels?.[index]?.name, labels?.[index]?.role ?? role)).join(' / ');
}
