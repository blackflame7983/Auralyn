import { useEffect } from 'react';
import type { LiveModesModel } from './useLiveModes';

/**
 * 操作ロックの鍵は登録の有無にかかわらず右の列に出す。登録済みなら歌・雑談の帯が状態を追うので、
 * 未登録のロック中だけ、モデルの参照数つきの購読（activate）に加わり、バックエンドが保護を失効させたときに鍵の表示を追従させる。
 * 監視はモデル側で1つに共有するので、設定画面が同時に開いていても定期確認は増えない。
 */
export function useLiveProtectionWatch(model: LiveModesModel): void {
    const { activate, snapshot } = model;
    const registered = Boolean(snapshot?.definitions.singing || snapshot?.definitions.talk);
    const watching = Boolean(snapshot?.armed) && !registered;
    useEffect(() => (watching ? activate() : undefined), [watching, activate]);
}
