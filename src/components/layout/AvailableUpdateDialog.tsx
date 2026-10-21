import { useState } from 'react';
import { Modal } from '../ui/modal';
import type { AvailableUpdate } from '@/hooks/useUpdates';

export function AvailableUpdateDialog({ update, downloaded, busy, onClose, onDownload, onInstall }: {
    update: AvailableUpdate; downloaded: boolean; busy: boolean; onClose: () => void;
    onDownload: () => Promise<void>; onInstall: () => Promise<void>;
}) {
    const [confirmed, setConfirmed] = useState(false);
    return <Modal title="アップデート" onClose={() => { if (!busy) onClose(); }}>
        <div className="modal-overlay-base"><div className="modal-surface-base flex max-h-[85vh] w-full max-w-lg flex-col">
            <h2 className="modal-header-base shrink-0 font-bold">v{update.version}のアップデート</h2>
            <div className="modal-body-base space-y-4 text-sm">
                <p className="whitespace-pre-wrap break-words">{update.body || '更新内容は配布ページをご確認ください。'}</p>
                {update.canInstall ? <>
                    <p>{downloaded ? 'ダウンロード済みです。' : 'ダウンロード中も現在の版で使い続けられます。'}</p>
                    <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />適用時はVST状態を保存して音声を停止し、アプリを終了することを確認しました。録音・試聴中は適用できません。</label>
                </> : <p>Portable版またはインストール先が不明なため、この画面から適用しません。配布ページの新しい版へ更新してください。</p>}
                <a className="underline" href="https://github.com/blackflame7983/Auralyn-Releases/releases" target="_blank" rel="noreferrer">配布ページを開く</a>
            </div>
            <div className="modal-footer-base flex shrink-0 flex-wrap gap-2">
                <button disabled={busy} className="rounded border px-3 py-2" onClick={onClose}>後で</button>
                {update.canInstall && !downloaded && <button disabled={busy} className="rounded border px-3 py-2" onClick={() => void onDownload()}>ダウンロード</button>}
                {update.canInstall && downloaded && <button disabled={busy || !confirmed} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void onInstall()}>保存して更新を適用</button>}
            </div>
        </div></div>
    </Modal>;
}
