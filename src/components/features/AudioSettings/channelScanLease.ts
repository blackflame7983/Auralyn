import { audioApi } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';

let users = 0;
let applied: boolean | null = false;
let queue: Promise<void> = Promise.resolve();
let revision = 0;
let session = 0;
let subscription: Promise<void> = Promise.resolve();
let unlisten: (() => void) | undefined;
const observers = new Set<{ restarting: () => void; failed: () => void }>();

// 要求を直列化し、遅い開始の後でも最後の利用状況を適用する。
function reconcile(): Promise<void> {
    const request = queue.catch(() => {}).then(async () => {
        while (applied !== (users > 0)) {
            const desired = users > 0;
            const requestRevision = revision;
            try {
                await audioApi.setChannelScan(desired);
                applied = requestRevision === revision ? desired : null;
            } catch (error) {
                applied = null;
                throw error;
            }
        }
    });
    queue = request;
    return request;
}

export function acquireChannelScan(observer: { restarting: () => void; failed: () => void }) {
    users++;
    observers.add(observer);
    if (users === 1) {
        const currentSession = ++session;
        subscription = listen('audio-started', () => {
            if (currentSession !== session || !users) return;
            revision++;
            applied = null;
            observers.forEach(item => item.restarting());
            void reconcile().catch(() => {
                if (currentSession === session) observers.forEach(item => item.failed());
            });
        }).then(stop => {
            if (currentSession !== session || !users) stop();
            else unlisten = stop;
        });
        // 利用終了後に失敗した購読も未処理の rejection にしない。
        void subscription.catch(() => {});
    }
    let released = false;
    const ready = subscription.then(() => reconcile());
    return {
        ready,
        release: () => {
            if (released) return queue;
            released = true;
            observers.delete(observer);
            users--;
            if (!users) {
                session++;
                unlisten?.();
                unlisten = undefined;
            }
            return reconcile();
        },
    };
}

export function retryChannelScan() { return reconcile(); }
