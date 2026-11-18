import { useRackRestoreBusy } from '@/lib/liveRouting';

// 構成の置き換え（プリセット・プロファイル・テンプレート・復元）は、既存のVSTを外して空にしてから読み込む。
// その途中の空は確定した0件ではないので、置き換えが終わるまでは数を未確定（null）にする。
export function useActiveVstCount(plugins: readonly { enabled: boolean }[], sessionPending: boolean): number | null {
    const replacing = useRackRestoreBusy();
    return sessionPending || replacing ? null : plugins.filter(plugin => plugin.enabled).length;
}
