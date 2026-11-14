// 追加した探索先は画面だけが覚え、スキャンの引数として渡す。標準の2つは Rust の default_roots と同じ。
export const VST_SCAN_FOLDERS_KEY = 'auralyn_vst_scan_folders';
export const MAX_EXTRA_SCAN_FOLDERS = 32;

export const STANDARD_VST_SCAN_FOLDERS = [
    'C:\\Program Files\\Common Files\\VST3',
    'C:\\Program Files\\Steinberg\\VST3',
] as const;

export type ScanFolderReject = 'empty' | 'duplicate' | 'invalid' | 'full';
export type ScanFolderAddResult = { ok: true; folders: string[] } | { ok: false; reason: ScanFolderReject };

export function scanFolderKey(path: string): string {
    return path.trim().replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function browserStorage(): Storage | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null;
    }
}

export function readExtraScanFolders(): string[] {
    const storage = browserStorage();
    if (!storage) return [];
    try {
        const value: unknown = JSON.parse(storage.getItem(VST_SCAN_FOLDERS_KEY) ?? '[]');
        if (!Array.isArray(value)) return [];
        const seen = new Set(STANDARD_VST_SCAN_FOLDERS.map(scanFolderKey));
        const folders: string[] = [];
        for (const item of value) {
            if (typeof item !== 'string') continue;
            const path = item.trim();
            if (!path || path.includes('\0') || path.length > 32767) continue;
            const key = scanFolderKey(path);
            if (seen.has(key)) continue;
            seen.add(key);
            folders.push(path);
            if (folders.length >= MAX_EXTRA_SCAN_FOLDERS) break;
        }
        return folders;
    } catch {
        return [];
    }
}

export function writeExtraScanFolders(folders: readonly string[]): boolean {
    const storage = browserStorage();
    if (!storage) return false;
    try {
        storage.setItem(VST_SCAN_FOLDERS_KEY, JSON.stringify(folders));
        return true;
    } catch {
        return false;
    }
}

export function addExtraScanFolder(current: readonly string[], raw: string): ScanFolderAddResult {
    const path = raw.trim();
    if (!path) return { ok: false, reason: 'empty' };
    if (path.includes('\0') || path.length > 32767) return { ok: false, reason: 'invalid' };
    if (current.length >= MAX_EXTRA_SCAN_FOLDERS) return { ok: false, reason: 'full' };
    const key = scanFolderKey(path);
    const known = new Set([...STANDARD_VST_SCAN_FOLDERS, ...current].map(scanFolderKey));
    if (known.has(key)) return { ok: false, reason: 'duplicate' };
    return { ok: true, folders: [...current, path] };
}

export function removeExtraScanFolder(current: readonly string[], path: string): string[] {
    const key = scanFolderKey(path);
    return current.filter(item => scanFolderKey(item) !== key);
}
