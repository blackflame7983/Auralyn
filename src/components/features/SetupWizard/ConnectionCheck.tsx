import { receiverDeviceHint } from '../../../lib/audioRouting';
import { useObsUsage } from '../../../hooks/useObsUsage';
import React, { useEffect, useRef, useState } from 'react';
import { obsApi, type ObsAudioReachResult } from '../../../api/obs';

interface ConnectionCheckProps {
    goal: 'obs' | 'discord' | 'listening' | 'other' | null;
    outputName: string;
    isBroadcast: boolean;
    disabled: boolean;
    audioRunning: boolean;
    onStartAudio: () => Promise<boolean>;
    onBusyChange: (busy: boolean) => void;
}

/** 接続先の設定は変更せず、手動手順と既存の到達確認を一つの場所にまとめる。 */
export const ConnectionCheck: React.FC<ConnectionCheckProps> = ({
    goal,
    outputName,
    isBroadcast,
    disabled,
    audioRunning,
    onStartAudio,
    onBusyChange,
}) => {
    const obsInUse = useObsUsage(isBroadcast && goal === 'obs');
    const [host, setHost] = useState('localhost');
    const [port, setPort] = useState('4455');
    const [password, setPassword] = useState('');
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('OBS への接続と音の到達は未確認です。');
    const [result, setResult] = useState<ObsAudioReachResult | null>(null);
    const operationRef = useRef(false);
    const connectionRevisionRef = useRef(0);
    const audioRevisionRef = useRef(0);
    useEffect(() => {
        if (obsInUse) return;
        connectionRevisionRef.current += 1;
        audioRevisionRef.current += 1;
        setConnected(false);
        setResult(null);
        setMessage('OBS への接続は終了しました。再利用するときは接続してください。');
    }, [obsInUse]);
    const portNumber = Number(port);
    const validConnection =
        host.trim() !== '' && /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;

    useEffect(() => {
        if (!audioRunning) {
            audioRevisionRef.current += 1;
            setResult(null);
            setMessage('OBS への音の到達は未確認です。');
        }
    }, [audioRunning]);

    const run = async (operation: () => Promise<void>) => {
        if (operationRef.current || disabled || !obsInUse) return;
        operationRef.current = true;
        setBusy(true);
        onBusyChange(true);
        try {
            await operation();
        } finally {
            operationRef.current = false;
            setBusy(false);
            onBusyChange(false);
        }
    };

    const connect = () =>
        run(async () => {
            if (!validConnection) return;
            const revision = connectionRevisionRef.current;
            setConnected(false);
            setResult(null);
            try {
                await obsApi.connect({ host: host.trim(), port: portNumber, password });
                // 利用を終えた接続の遅い応答で、切断後の画面を接続済みに戻さない。
                if (revision !== connectionRevisionRef.current || document.hidden) return;
                setConnected(true);
                setMessage('OBS に接続しました。音の到達はまだ確認していません。');
            } catch {
                if (revision !== connectionRevisionRef.current || document.hidden) return;
                setMessage(
                    'OBS に接続できませんでした。OBS の起動、WebSocket サーバーの有効化、接続先・ポート・パスワードを確認してください。接続できない場合は下の手動手順で確認できます。',
                );
            }
        });

    const checkReach = () =>
        run(async () => {
            const revision = audioRevisionRef.current;
            const connectionRevision = connectionRevisionRef.current;
            setResult(null);
            setMessage('接続を確認中です。');
            try {
                if (!(await onStartAudio())) {
                    if (connectionRevision !== connectionRevisionRef.current || document.hidden)
                        return;
                    setMessage('音声を開始できませんでした。入力・出力を選び直してください。');
                    return;
                }
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                const next = await obsApi.checkAudioReach(1500);
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                if (revision !== audioRevisionRef.current) {
                    setMessage('音声が中断されました。入力・出力を確認して再試行してください。');
                    return;
                }
                setResult(next);
                if (next.reached === true) {
                    setMessage(
                        'OBS の「Auralyn マイク」で音の到達を確認しました。配信・録画全体の音質や音量の確認ではありません。',
                    );
                } else if (next.reached === 'unsupported') {
                    setMessage(
                        '自動での到達確認を利用できません。下の手動手順で OBS のメーターを確認してください。',
                    );
                } else {
                    setMessage(
                        '音の到達を確認できませんでした。Auralyn の出力先、OBS の入力デバイス・ミュートを確認して再試行してください。',
                    );
                }
            } catch {
                if (connectionRevision !== connectionRevisionRef.current || document.hidden) return;
                setConnected(false);
                setMessage(
                    '到達確認に失敗しました。OBS に再接続し、「Auralyn マイク」ソースと入力デバイスを確認してください。手動での確認もできます。',
                );
            }
        });

    if (!isBroadcast) {
        return (
            <section
                aria-label="接続チェック"
                className="rounded-xl border border-border p-4 space-y-2"
            >
                <h3 className="font-bold">接続チェック</h3>
                <p className="text-sm">
                    出力先は「{outputName}」です。サウンドテストで聴こえるか確認してください。
                </p>
                {(goal === 'obs' || goal === 'discord') && (
                    <p className="text-sm text-amber-500">
                        この出力先から {goal === 'obs' ? 'OBS' : 'Discord'}{' '}
                        への接続は確認できません。仮想ケーブル経由で送る場合は「出力先を選び直す」へ戻ってください。
                    </p>
                )}
            </section>
        );
    }

    return (
        <section
            aria-label="接続チェック"
            className="rounded-xl border border-border p-4 space-y-4"
        >
            <h3 className="font-bold">接続チェック：受け側アプリへ</h3>
            <p className="text-sm">
                Auralyn → {outputName} →{' '}
                {receiverDeviceHint(outputName)} → {goal === 'discord' ? 'Discord' : goal === 'obs' ? 'OBS' : '受け側アプリ'}{' '}
                の順につなぎます。仮想ケーブルへの出力だけでは、受け側への到達確認は完了しません。
            </p>
            {goal === 'obs' ? (
                <>
                    <ol className="list-decimal pl-5 text-sm space-y-2">
                        <li>
                            OBS に「音声入力キャプチャ」を追加し、名前を「Auralyn
                            マイク」にします。既存ソースの設定はこの画面では変更しません。
                        </li>
                        <li>
                            OBS の入力デバイスは「{receiverDeviceHint(outputName)}」を選びます。
                        </li>
                        <li>OBS の該当ソースのミュートを解除し、配信・録画を停止します。</li>
                    </ol>
                    <p className="text-sm">
                        自動確認には OBS WebSocket v5 が必要です。OBS の「ツール →
                        WebSocketサーバー設定」で有効にしてください。利用できない場合は、サウンドテストを開始してマイクに話し、OBS
                        の該当ソースのメーターが動くか手動で確認してください。
                    </p>
                    <fieldset disabled={busy || disabled} className="flex flex-wrap gap-3">
                        <label className="text-sm">
                            接続先
                            <input
                                className="block w-40 bg-background border border-border rounded p-2"
                                value={host}
                                onChange={(e) => {
                                    setHost(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage('接続先を変更しました。OBS に再接続してください。');
                                }}
                            />
                        </label>
                        <label className="text-sm">
                            ポート
                            <input
                                className="block w-24 bg-background border border-border rounded p-2"
                                inputMode="numeric"
                                value={port}
                                onChange={(e) => {
                                    setPort(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage('ポートを変更しました。OBS に再接続してください。');
                                }}
                            />
                        </label>
                        <label className="text-sm">
                            パスワード
                            <input
                                className="block w-48 bg-background border border-border rounded p-2"
                                type="password"
                                autoComplete="off"
                                value={password}
                                onChange={(e) => {
                                    setPassword(e.target.value);
                                    setConnected(false);
                                    setResult(null);
                                    setMessage(
                                        'パスワードを変更しました。OBS に再接続してください。',
                                    );
                                }}
                            />
                        </label>
                    </fieldset>
                    <p className="text-xs text-muted-foreground">
                        パスワードはこの画面から保存しません。他にOBSを使う画面がなければ、ウィザードを閉じると接続を終了します。再利用するときは接続してください。
                    </p>
                    <button
                        type="button"
                        disabled={busy || disabled || !validConnection}
                        onClick={connect}
                        className="px-4 py-2 rounded bg-secondary text-secondary-foreground disabled:opacity-50"
                    >
                        OBS に接続する
                    </button>
                    <p className="text-sm text-amber-500">
                        到達確認では約1.5秒のテスト音が出ます。配信・録画や通話に流れない状態で実行してください。
                    </p>
                    <button
                        type="button"
                        disabled={busy || disabled || !connected}
                        onClick={checkReach}
                        className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
                    >
                        テスト音で OBS への到達を確認
                    </button>
                    <p
                        role="status"
                        className={`text-sm ${result?.reached === true ? 'text-emerald-500' : 'text-muted-foreground'}`}
                    >
                        {audioRunning ? '音声は稼働中です。' : '音声は停止中です。'}{' '}
                        {busy ? '接続を確認中です…' : message}
                    </p>
                </>
            ) : (
                <>
                    <p className="text-sm">
                        {goal === 'discord'
                            ? 'Discord の「設定 → 音声・ビデオ → 入力デバイス」'
                            : '受け側アプリの入力デバイス'}
                        で「{receiverDeviceHint(outputName)}」を選んでください。
                    </p>
                    <p className="text-sm">
                        サウンドテストを開始してマイクに話し、受け側アプリのマイクテストや入力メーターで確認してください。この画面から受け側への到達は自動判定しません。
                    </p>
                </>
            )}
        </section>
    );
};
