import { useState } from 'react';

/**
 * 操作ロックに断られた理由をダイアログの中に出しているあいだ、ロックが外れたら理由を消す。
 * 「ロック中 → 解除」の変化だけを見る。未取得（undefined）や、断られる前から解除の表示だった場合は消さない。
 */
export function useClearOnLiveUnlock(armed: boolean | undefined, clear: () => void): void {
    const [previous, setPrevious] = useState(armed);
    if (previous === armed) return;
    setPrevious(armed);
    if (previous === true && armed === false) clear();
}
