// 接続とホットキーの未保存、保存処理中の移動を、ページの外の入口からも同じ規則で止める。
import { useEffect, useState } from 'react';

export type LeaveDecision = 'allow' | 'block' | 'confirm';

type Guard = () => LeaveDecision;
type OpenListener = (open: boolean) => void;

let guard: Guard | null = null;
let skipOnce = false;
let pending: (() => void) | null = null;
let generation = 0;
let locked = false;
let settingsCloser: () => void = () => {};

const openListeners = new Set<OpenListener>();
const generationListeners = new Set<() => void>();
const lockListeners = new Set<(locked: boolean) => void>();

export function registerLeaveGuard(next: Guard | null) {
    guard = next;
    return () => { if (guard === next) guard = null; };
}

/** 保存に成功したときなど、確認も処理中の停止も挟まずに一度だけ離れる。 */
export function allowNextLeave() { skipOnce = true; }

/** 一度だけの通過が予約されていれば消費して true。同じ場所への移動でも取りこぼさない。 */
export function consumeLeaveSkip() {
    if (!skipOnce) return false;
    skipOnce = false;
    return true;
}

export function requestLeave(apply: () => void) {
    if (consumeLeaveSkip()) { apply(); return; }
    const decision = guard?.() ?? 'allow';
    if (decision === 'block') return;
    if (decision === 'confirm') {
        pending = apply;
        openListeners.forEach(listener => listener(true));
        return;
    }
    apply();
}

export function cancelLeave() {
    pending = null;
    openListeners.forEach(listener => listener(false));
}

/** 変更を捨てて移動する。ページ側は世代を進めて編集中の状態を捨てる。 */
export function acceptLeave() {
    const apply = pending;
    pending = null;
    generation += 1;
    generationListeners.forEach(listener => listener());
    openListeners.forEach(listener => listener(false));
    apply?.();
}

export function subscribeLeave(listener: OpenListener) {
    openListeners.add(listener);
    return () => { openListeners.delete(listener); };
}

export function subscribeLeaveGeneration(listener: () => void) {
    generationListeners.add(listener);
    return () => { generationListeners.delete(listener); };
}

export function leaveGeneration() { return generation; }

export function useLeaveGeneration() {
    const [value, setValue] = useState(generation);
    useEffect(() => subscribeLeaveGeneration(() => setValue(leaveGeneration())), []);
    return value;
}

export function usePageLock() {
    const [value, setValue] = useState(locked);
    useEffect(() => subscribePageLock(setValue), []);
    return value;
}

export function setPageLocked(next: boolean) {
    if (locked === next) return;
    locked = next;
    lockListeners.forEach(listener => listener(next));
}

export function subscribePageLock(listener: (locked: boolean) => void) {
    lockListeners.add(listener);
    listener(locked);
    return () => { lockListeners.delete(listener); };
}

export function registerSettingsCloser(next: () => void) {
    settingsCloser = next;
    return () => { if (settingsCloser === next) settingsCloser = () => {}; };
}

/** 登録された閉じる処理そのもの。確認は呼び出し側が挟む。 */
export function runSettingsCloser() { settingsCloser(); }

/** レールのホームなど、設定ページを閉じる製品の入口。 */
export function requestSettingsClose() { requestLeave(settingsCloser); }
