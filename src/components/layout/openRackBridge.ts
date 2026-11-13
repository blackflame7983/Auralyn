// 音づくりのページから、右パネルの VST を開く。開く処理そのものは AppShell の openRack。
let opener: (() => void) | null = null;

export function registerRackOpener(next: () => void) {
    opener = next;
    return () => { if (opener === next) opener = null; };
}

export function requestOpenRack() { opener?.(); }
