import { useState } from 'react';
import { normalizeReceiver } from '@/lib/preparation';

// 受け側の入力名は、入力中は下書きだけを変え、確定したときに1回だけ保存する。
// 保存済みの値が外から変わったら、下書きもそれに合わせる。
export function useReceiverDraft(saved: string, save: (receiver: string) => void) {
    const [draft, setDraft] = useState(saved);
    const [seen, setSeen] = useState(saved);
    if (seen !== saved) { setSeen(saved); setDraft(saved); }
    const commit = (value: string = draft) => {
        const next = normalizeReceiver(value);
        setDraft(next);
        if (next !== saved) save(next);
    };
    const inputProps = {
        value: draft,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        onBlur: () => commit(),
        onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') commit(); },
    };
    return { draft, commit, inputProps };
}
