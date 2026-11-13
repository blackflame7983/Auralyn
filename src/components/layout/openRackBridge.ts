// 音づくりのページから、VST のページを開く。開く処理そのものは AppShell が登録する。
let opener: (() => void) | null = null;

export function registerRackOpener(next: () => void) {
    opener = next;
    return () => { if (opener === next) opener = null; };
}

export function requestOpenRack() { opener?.(); }
