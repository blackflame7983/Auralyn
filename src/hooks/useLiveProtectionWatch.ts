import { useEffect } from 'react';
import type { LiveModesModel } from './useLiveModes';

/**
 * 操作ロックの鍵は登録の有無にかかわらず右の列に出す。歌・雑談の帯はホームにしか無いので、
 * ロック中は登録の有無にかかわらず、ホーム以外のページでも、モデルの参照数つきの購読（activate）に加わり、バックエンドが保護を失効させたときに鍵の表示を追従させる。
 * 監視はモデル側で1つに共有するので、設定画面が同時に開いていても定期確認は増えない。
 */
export function useLiveProtectionWatch(model: LiveModesModel): void {
    const { activate, snapshot } = model;
    const watching = Boolean(snapshot?.armed);
    useEffect(() => (watching ? activate() : undefined), [watching, activate]);
}
