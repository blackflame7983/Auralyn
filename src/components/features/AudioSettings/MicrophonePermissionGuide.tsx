import { useState } from 'react';
import { desktopApi } from '../../../api/desktop';

// OSの許可状態を推測せず、利用者が設定を確認できる導線を用意する。
export function MicrophonePermissionGuide({ expanded = false }: { expanded?: boolean }) {
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState(false);
    const openSettings = async () => {
        setOpening(true);
        setError(false);
        try {
            await desktopApi.openSettings('microphonePrivacy');
        } catch {
            setError(true);
        } finally {
            setOpening(false);
        }
    };

    return (
        <details open={expanded || undefined} className="text-xs rounded-lg border border-border p-3 space-y-2">
            <summary className="cursor-pointer font-medium">マイクのアクセス許可を確認する</summary>
            <div className="space-y-2 pt-2 text-muted-foreground">
                <p>入力を開始できない場合は、Windowsの「プライバシーとセキュリティ → マイク」で「マイクへのアクセス」と「アプリにマイクへのアクセスを許可する」を確認してください。</p>
                <p>Store・MSIX版は、アプリ一覧に表示されるAuralyn（試作版は試作版の名前）の許可も確認してください。通常配布版は「デスクトップ アプリにマイクへのアクセスを許可する」も確認してください。</p>
                <button disabled={opening} onClick={() => void openSettings()} className="px-3 py-2 rounded-md border border-input text-foreground hover:bg-muted">
                    Windowsのマイク設定を開く
                </button>
                {error && <p role="alert">設定を開けませんでした。Windowsの設定から「プライバシーとセキュリティ → マイク」を開いてください。</p>}
                <p>許可を変更したらこの画面に戻り、入力を選んで再試行してください。ほかのアプリがデバイスを占有している場合も、入力を開始できないことがあります。</p>
            </div>
        </details>
    );
}
