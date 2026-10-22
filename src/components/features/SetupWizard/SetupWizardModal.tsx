import { buttonVariants } from '@/components/ui/button';
import { receiverDeviceHint, deviceDisplayName } from '../../../lib/audioRouting';
import { Modal } from '../../ui/modal';
import React, { useEffect, useRef } from 'react';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { MdCheckCircle, MdWarning, MdMic, MdVolumeUp, MdSettings, MdCast, MdHeadphones, MdMusicNote, MdArrowForward, MdPlayArrow, MdStop, MdError, MdClose } from 'react-icons/md';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionCheck } from './ConnectionCheck';
import { MicrophonePermissionGuide } from '../AudioSettings/MicrophonePermissionGuide';

import { saveBeginnerMode } from '../../../hooks/useBeginnerMode';
import { useSetupWizard } from './useSetupWizard';
import { isVirtualOutput, type SetupWizardModalProps } from './wizardModel';

export const SetupWizardModal: React.FC<SetupWizardModalProps> = (props) => {
    const { isOpen, onClose, onSkip, onOpenSettings, onOpenTroubleshoot } = props;
    const { audioStartError, beginnerChoice, setBeginnerChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, inputLevel, loadDevices, handleRescanVirtualDevices,
        selectGoal, runQuickStart, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply } = useSetupWizard(props);
    const bodyRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isOpen || !bodyRef.current) return;
        bodyRef.current.scrollTop = 0;
        // 短い画面では外側がスクロール主体になるため、両方を戻す。
        if (surfaceRef.current) surfaceRef.current.scrollTop = 0;
        const heading = bodyRef.current.querySelector('h2');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }, [isOpen, state]);

    if (!isOpen) return null;

    return (
        <Modal title="セットアップウィザード" onClose={handleCloseRequest} dismissible={!isBusy && !isCheckingConnection}>
        <div className="modal-overlay-base">
            <div ref={surfaceRef} className="modal-surface-base w-full max-w-3xl flex flex-col max-h-[90vh]">

                <div className="modal-header-base shrink-0 pr-16 py-3"><p className="font-bold">セットアップウィザード</p></div>
                {/* Close Button */}
                <button
                    onClick={handleCloseRequest}
                    disabled={isBusy || isCheckingConnection}
                    aria-label="セットアップウィザードを閉じる"
                    className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors z-10"
                >
                    <MdClose className="w-6 h-6" />
                </button>

                <ConfirmDialog
                    isOpen={isCloseConfirmOpen}
                    title="セットアップを中断しますか？"
                    description="途中で終了しても、「オーディオ設定」からいつでも再開できます。"
                    confirmLabel="中断する"
                    cancelLabel="続ける"
                    variant="default"
                    onConfirm={() => {
                        setIsCloseConfirmOpen(false);
                        performClose();
                    }}
                    onCancel={() => setIsCloseConfirmOpen(false)}
                />

                {/* Header Steps */}
                {state !== 'welcome' && state !== 'complete' && state !== 'configuring' && (
                    <div aria-label="セットアップの進捗" className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border relative">
                        {/* Progress Bar Background */}
                        <div className="hidden" />

                        {[
                            { id: 'usage_selection', label: '目的' },
                            { id: 'input_selection', label: '入力' },
                            { id: 'output_selection', label: '出力' },
                            { id: 'confirmation', label: '確認' }
                        ].map((step, idx) => {
                            const isCurrent = state === step.id;
                            const isPast = ['usage_selection', 'input_selection', 'output_selection', 'confirmation'].indexOf(state) > idx;

                            return (
                                <div key={step.id} className="flex items-center gap-2">
                                    <div aria-current={isCurrent ? 'step' : undefined} className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors
                                        ${isCurrent ? 'border-primary bg-primary text-primary-foreground' :
                                            isPast ? 'border-primary bg-primary/20 text-primary' :
                                                'border-muted text-muted-foreground bg-card'}`}>
                                        {isPast ? <MdCheckCircle /> : idx + 1}
                                    </div>
                                    <span className={`text-xs ${isCurrent ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{step.label}</span>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div ref={bodyRef} className="modal-body-base min-h-0 flex flex-col">
                    {initialStateError && <p role="alert" className="text-sm text-amber-500 mb-4">現在の音声設定を取得できませんでした。テストと保存は実行できません。ウィザードを開き直してください。</p>}

                    {/* --- STEP 1: WELCOME --- */}
                    {state === 'welcome' && (
                        <div className="text-center space-y-4 animate-in zoom-in-95 duration-300 my-auto">
                            <div className="space-y-2">
                                <p className="text-muted-foreground text-sm leading-relaxed">
                                    用途に合わせてマイクと出力先を選びます。<br />
                                    OBS・Discord へ送る場合は <strong className="text-foreground">VB-CABLE 等の仮想ケーブル</strong> が必要です。
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    音が届かない・設定に迷ったときは、ヘルプの
                                    {onOpenTroubleshoot ? (
                                        <>
                                            {' '}
                                            <button
                                                type="button"
                                                onClick={() => void performClose(onOpenTroubleshoot)}
                                                className="underline underline-offset-2 text-primary hover:text-primary/80"
                                            >
                                                接続診断
                                            </button>
                                        </>
                                    ) : (
                                        ' 接続診断'
                                    )}
                                    をご利用ください。
                                </p>
                            </div>

                            <fieldset className="space-y-2 text-sm">
                                <legend className="mb-2 font-semibold">
                                    設定後の表示（あとから変更できます）
                                </legend>
                                <label className="flex items-center justify-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={beginnerChoice}
                                        onChange={() => setBeginnerChoice(true)}
                                    />
                                    配信をはじめたい（かんたん表示）
                                </label>
                                <label className="flex items-center justify-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={!beginnerChoice}
                                        onChange={() => setBeginnerChoice(false)}
                                    />
                                    VSTで音を調整したい（詳細表示）
                                </label>
                                <p className="text-xs text-muted-foreground">
                                    表示はあとから切り替えられます。音声やエフェクトの設定は変わりません。
                                </p>
                            </fieldset>


                        </div>
                    )}

                    {/* --- STEP 2: USAGE SELECTION --- */}
                    {state === 'usage_selection' && (
                        <div className="space-y-3 animate-in slide-in-from-right-10 duration-300">
                            <h2 className="text-xl font-bold text-foreground text-center">どのような用途で使用しますか？</h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
                                <SelectionCard
                                    onClick={() => selectGoal('obs')}
                                    icon={<MdCast className="w-8 h-8 text-blue-500" />}
                                    title="OBSで配信"
                                    description="声を加工してOBSに送ります。（VB-Cable推奨）"
                                    active={config.goal === 'obs'}
                                    color="blue"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('discord')}
                                    icon={<DiscordIcon className="w-8 h-8 text-indigo-500" />}
                                    title="ボイスチャット"
                                    description="DiscordやZoomなどへ、加工した声を届けます。（仮想ケーブルが必要な場合があります）"
                                    active={config.goal === 'discord'}
                                    color="indigo"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('listening')}
                                    icon={<MdMusicNote className="w-8 h-8 text-pink-500" />}
                                    title="音楽鑑賞・テスト"
                                    description="エフェクトを通して音楽を聴いたり、音作りを楽しみます。"
                                    active={config.goal === 'listening'}
                                    color="pink"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('other')}
                                    icon={<MdSettings className="w-8 h-8 text-emerald-500" />}
                                    title="手動で設定"
                                    description="自分で詳しくデバイスを選びます。"
                                    active={config.goal === 'other'}
                                    color="emerald"
                                />
                            </div>
                        </div>
                    )}

                    {/* --- STEP 3: INPUT SELECTION --- */}
                    {state === 'input_selection' && (
                        <div className="space-y-3 animate-in slide-in-from-right-10 duration-300">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">
                                    {config.goal === 'listening' ? '入力デバイス (ソース) を選択' : 'マイクを選んでください'}
                                </h2>
                                <p className="text-sm text-muted-foreground">
                                    {config.goal === 'listening'
                                        ? '音声エンジンの入力に使用するデバイスを選択します。'
                                        : 'お使いのマイクをリストから選択してください。'}
                                </p>
                                {availableInputs.length === 0 && !isLoadingDevices && onOpenSettings && <button onClick={() => void performClose(onOpenSettings)} className="underline text-primary">WASAPI の入力が見つからない場合はオーディオ設定を開く</button>}
                            </div>

                            <div className="max-w-md mx-auto space-y-4">
                                <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError)} />
                                {isLoadingDevices ? (
                                    <div className="py-8 text-center text-muted-foreground animate-pulse">デバイスを検索中...</div>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-foreground">
                                                {config.goal === 'listening' ? '入力デバイス' : '入力デバイス (マイク)'}
                                            </label>
                                            <select
                                                aria-label="入力デバイス"
                                                className="w-full p-3 bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                                value={config.input?.name || ''}
                                                onChange={(e) => {
                                                    const dev = availableInputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, input: dev || null }));
                                                }}
                                            >
                                                <option value="">入力デバイスを選択してください</option>
                                                {availableInputs.map((d, i) => (
                                                    <option key={`${d.name}-${i}`} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {!config.input && availableInputs.length > 0 && (
                                            <div className="flex items-center gap-2 text-yellow-500 text-sm bg-yellow-500/10 p-3 rounded-lg">
                                                <MdWarning /> デバイスを選択してください。
                                            </div>
                                        )}
                                        {availableInputs.length === 0 && (
                                            <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 p-3 rounded-lg">
                                                <MdError /> 入力デバイスが見つかりませんでした。
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="text-center">
                                <button disabled={isLoadingDevices} onClick={() => void loadDevices(true)} className="px-4 py-2 rounded border border-border disabled:opacity-50">入力デバイスを再検出</button>
                            </div>


                        </div>
                    )}

                    {/* --- STEP 4: OUTPUT SELECTION --- */}
                    {state === 'output_selection' && (
                        <div className="space-y-3 animate-in slide-in-from-right-10 duration-300">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">音の出力先を選んでください</h2>
                                <p className="text-sm text-muted-foreground">
                                    {config.goal === 'obs' ? '配信の場合は「仮想デバイス」がおすすめです。' : '通常は「Windows既定」または「ヘッドホン」を選びます。'}
                                </p>
                                {!config.input && <p role="status" className="text-sm text-amber-500">入力デバイスが未選択か、再検出で見つかりませんでした。「戻る」で入力を選び直してください。</p>}
                                {availableOutputs.length === 0 && !isLoadingDevices && <p className="text-sm text-amber-500">WASAPI の出力デバイスが見つかりません。接続を確認して再検出してください。</p>}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
                                {/* Option 1: Default */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('default')}
                                    icon={<MdVolumeUp className="w-8 h-8 text-sky-500" />}
                                    title="Windows既定"
                                    description="普段PCから音が出ている場所から鳴らします。"
                                    active={config.outputMode === 'default'}
                                    color="sky"
                                />

                                {/* Option 2: Headphones */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('monitor')}
                                    icon={<MdHeadphones className="w-8 h-8 text-orange-500" />}
                                    title="ヘッドホン/スピーカー"
                                    description="特定のヘッドホン等を直接指定します。"
                                    active={config.outputMode === 'monitor'}
                                    color="orange"
                                />

                                {/* Option 3: Broadcast */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('broadcast')}
                                    icon={<MdCast className="w-8 h-8 text-purple-500" />}
                                    title="仮想デバイスへ"
                                    description="VB-CABLE等へ出力し、OBS等で拾います。"
                                    active={config.outputMode === 'broadcast'}
                                    color="purple"
                                />
                            </div>
                            <div className="max-w-xl mx-auto space-y-2" aria-label="選択した方式の出力デバイス">
                                    {config.outputMode === 'default' && config.output && (
                                        <div className="mt-2 p-2 bg-background/50 rounded text-xs text-foreground">
                                            {config.output.name}
                                        </div>
                                    )}
                                    {config.outputMode === 'default' && !config.output && (
                                        <p role="status" className="mt-2 text-sm text-muted-foreground">
                                            Windows の既定の物理出力を確認できませんでした。「ヘッドホン/スピーカー」で出力先を選ぶか、再検出してください。
                                        </p>
                                    )}
                                    {config.outputMode === 'monitor' && (
                                        <select
                                            aria-label="ヘッドホン・スピーカー"
                                            className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                            value={config.output?.name || ''}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                const dev = availableOutputs.find(d => d.name === e.target.value);
                                                setConfig(prev => ({ ...prev, output: dev || null }));
                                            }}
                                        >
                                            <option value="">出力先を選択してください</option>
                                            {availableOutputs.filter(d => !isVirtualOutput(d)).map((d, i) => (
                                                <option key={i} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                            ))}
                                        </select>
                                    )}
                                    {config.outputMode === 'broadcast' && (
                                        <>
                                            <select
                                                aria-label="仮想ケーブルの出力先"
                                                className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                                value={config.output?.name || ''}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => {
                                                    const dev = availableOutputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, output: dev || null }));
                                                }}
                                            >
                                                <option value="">仮想ケーブルを選択してください</option>
                                                {availableOutputs.filter(isVirtualOutput).map((d, i) => (
                                                    <option key={i} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                                ))}
                                                {/* Fallback if no cable */}
                                                {!availableOutputs.some(isVirtualOutput) && (
                                                    <option value="">仮想デバイス未検出</option>
                                                )}
                                            </select>
                                            <p className="mt-2 text-xs text-muted-foreground">Auralyn の出力先です。受け側では {config.output ? receiverDeviceHint(config.output.name) : "選択したケーブルと対になる録音デバイス"} を選びます。</p>
                                            {availableOutputs.filter(isVirtualOutput).length > 1 && !config.output && <p role="status" className="text-sm text-amber-500">複数の仮想ケーブルから、使う出力先を選択してください。</p>}
                                            {!availableOutputs.some(isVirtualOutput) && (
                                                <div className="mt-2 flex flex-col items-center gap-1.5">
                                                    <p className="text-xs text-center text-amber-500">仮想ケーブルが見つかりません。公式サイトから導入し、必要に応じて Windows を再起動してから再検出してください。</p>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            invoke('open_url', { url: 'https://vb-audio.com/Cable/' }).catch(() => window.open('https://vb-audio.com/Cable/', '_blank'));
                                                        }}
                                                        className="text-[10px] underline text-primary hover:text-primary/80"
                                                    >
                                                        VB-CABLEをダウンロード
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void handleRescanVirtualDevices();
                                                        }}
                                                        disabled={isLoadingDevices}
                                                        className="text-[11px] px-3 py-1 rounded-full border border-purple-400/40 bg-purple-500/10 text-foreground hover:bg-purple-500/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                                                    >
                                                        {isLoadingDevices ? '再確認中...' : 'インストールしました → 再スキャン'}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                            </div>


                            <div className="text-center">
                                <button disabled={isLoadingDevices} onClick={() => void (config.outputMode === 'broadcast' ? handleRescanVirtualDevices() : loadDevices(true))} className="px-4 py-2 rounded border border-border disabled:opacity-50">{isLoadingDevices ? '再検出中…' : '出力デバイスを再検出'}</button>
                            </div>

                        </div>
                    )}

                    {/* --- STEP 5: CONFIRMATION & TEST --- */}
                    {state === 'confirmation' && (
                        <div className="space-y-3 animate-in slide-in-from-right-10 duration-300">
                            <div className="text-center mb-6">
                                <h2 className="text-xl font-bold text-foreground">設定と接続の確認</h2>
                                <p className="text-sm text-muted-foreground">入力・出力と受け側アプリを順に確認します。確認できない項目は手動で確認できます。</p>
                            </div>

                            <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError)} />
                            <div className="bg-muted/30 p-6 rounded-xl border border-border max-w-lg mx-auto space-y-4">
                                <div className="grid grid-cols-[auto_1fr] gap-4 items-center">
                                    <MdMic className="w-5 h-5 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs text-muted-foreground">入力 ({config.goal === 'listening' ? 'ソース' : 'マイク'})</div>
                                        <div className="font-medium text-foreground truncate w-full">{config.input && deviceDisplayName(config.input.name)}</div>
                                    </div>

                                    <div className="col-span-2 flex justify-center py-2">
                                        <MdArrowForward className="rotate-90 text-muted-foreground/50" />
                                    </div>

                                    {/* Output Icon Logic */}
                                    {config.outputMode === 'broadcast' ? <MdCast className="w-5 h-5 text-purple-500" /> :
                                        config.outputMode === 'monitor' ? <MdHeadphones className="w-5 h-5 text-orange-500" /> :
                                            <MdVolumeUp className="w-5 h-5 text-sky-500" />}

                                    <div>
                                        <div className="text-xs text-muted-foreground">出力 ({config.outputMode === 'broadcast' ? '配信へ' : config.outputMode === 'monitor' ? 'モニター' : 'Windows既定'})</div>
                                        <div className="font-medium text-foreground truncate w-full">{config.output && deviceDisplayName(config.output.name)}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-col items-center gap-3">
                                {isTestingSound && (
                                    <div className="flex items-center gap-3 bg-secondary/10 px-4 py-2 rounded-full animate-in fade-in slide-in-from-bottom-2">
                                        <span className="text-xs font-bold text-secondary-foreground">入力</span>
                                        <div className="w-32 h-3 bg-secondary/30 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-green-500 transition-all duration-75 ease-out shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                                                style={{ width: `${Math.min(inputLevel * 100, 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="flex justify-center gap-4">
                                    {!isTestingSound ? (
                                        <button
                                            onClick={startSoundTest}
                                            disabled={isBusy || isCheckingConnection || !initialStateReady}
                                            className="px-6 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground font-bold rounded-lg transition-all flex items-center gap-2"
                                        >
                                            <MdPlayArrow /> サウンドテスト (開始)
                                        </button>
                                    ) : (
                                        <button
                                            onClick={stopSoundTest}
                                            disabled={isBusy || isCheckingConnection}
                                            className="px-6 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-bold rounded-lg transition-all flex items-center gap-2 animate-pulse"
                                        >
                                            <MdStop /> サウンドテスト (停止)
                                        </button>
                                    )}
                                </div>
                            </div>

                            {isTestingSound && (
                                <p className="text-center text-xs text-muted-foreground animate-pulse">
                                    音声エンジン起動中... {config.goal === 'listening' ? '音声を再生して確認してください。' : 'マイクに向かって話してみてください。'}
                                </p>
                            )}

                            <ConnectionCheck
                                key={`${config.input?.name}-${config.output?.name}`}
                                goal={config.goal}
                                outputName={config.output?.name || '未選択'}
                                isBroadcast={!!config.output && isVirtualOutput(config.output)}
                                disabled={isBusy || !initialStateReady}
                                audioRunning={isTestingSound}
                                onStartAudio={startSoundTest}
                                onBusyChange={setIsCheckingConnection}
                            />
                            <p className="text-center text-xs text-muted-foreground">「設定を保存して開始」は音声設定の保存です。受け側への接続確認を完了したことにはなりません。</p>
                            {onOpenTroubleshoot && <button disabled={isBusy || isCheckingConnection} onClick={() => void performClose(onOpenTroubleshoot)} className="underline text-primary">接続診断を開く</button>}

                        </div>
                    )}

                    {/* --- STEP 6: CONFIGURING & COMPLETE --- */}
                    {(state === 'configuring' || state === 'complete') && (
                        <div className="text-center space-y-8 animate-in zoom-in-95 duration-300 my-auto">
                            {state === 'configuring' ? (
                                <>
                                    <div className="w-16 h-16 border-4 border-muted border-t-green-500 rounded-full animate-spin mx-auto" />
                                    <h2 className="text-xl font-medium text-green-500">設定を適用中...</h2>
                                </>
                            ) : (
                                <>
                                    <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-green-500/50 shadow-[0_0_30px_rgba(34,197,94,0.2)]">
                                        <MdCheckCircle className="w-10 h-10 text-green-500" />
                                    </div>
                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-foreground">音声設定を保存しました</h2>
                                        <p className="text-muted-foreground text-sm leading-relaxed">
                                            受け側への到達を確認していない場合は、OBS・Discord 側の入力メーターを確認してください。声の変化は
                                            <strong className="text-foreground"> ボイスチェック</strong>
                                            で確認するのが確実です。音が届かない場合は接続診断をお試しください。
                                        </p>
                                    </div>
                                    <button
                                        onClick={onClose}
                                        className={buttonVariants({ className: "gap-2" })}
                                    >
                                        閉じる
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                </div>
                {state !== 'usage_selection' && <div data-testid="setup-actions" className="modal-footer-base shrink-0 px-4 py-3">
                    {state === 'welcome' && (<>
                            {isLoadingDevices ? (
                                <div className="flex flex-col items-center gap-2 opacity-70">
                                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-muted-foreground">デバイス情報を取得中...</span>
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-2 items-center justify-center">
                                    <button
                                        onClick={() => setState('usage_selection')}
                                        className={buttonVariants({ className: "gap-2" })}
                                    >
                                        <MdArrowForward className="w-5 h-5" />
                                        用途を選んで設定する
                                    </button>
                                    <button
                                        onClick={() => void runQuickStart()}
                                        className={buttonVariants({ variant: "outline", className: "gap-2" })}
                                    >
                                        <MdCheckCircle className="w-5 h-5" />
                                        OBS向けに設定する
                                    </button>
                                    <button
                                        onClick={() =>
                                            void performClose(() => {
                                                saveBeginnerMode(beginnerChoice);
                                                (onSkip || onClose)();
                                            })
                                        }
                                        disabled={isBusy}
                                        className="text-muted-foreground hover:text-foreground transition-colors text-sm underline decoration-muted hover:decoration-muted-foreground underline-offset-4"
                                    >
                                        スキップ（手動設定）
                                    </button>
                                </div>
                            )}
                    </>)}
                    {state === 'input_selection' && (<>
                            <div className="flex justify-center gap-4">
                                <button onClick={() => setState('usage_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">戻る</button>
                                <button
                                    onClick={confirmInput}
                                    disabled={!config.input || isLoadingDevices}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    次へ <MdArrowForward />
                                </button>
                            </div>
                    </>)}
                    {state === 'output_selection' && (<>
                            <div className="flex justify-center gap-4">
                                <button onClick={() => setState('input_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">戻る</button>
                                <button
                                    onClick={() => setState('confirmation')}
                                    disabled={!config.input || !config.output || isLoadingDevices}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    次へ <MdArrowForward />
                                </button>
                            </div>
                    </>)}
                    {state === 'confirmation' && (<>
                            <div className="flex flex-wrap justify-center gap-3">
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('input_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">入力を選び直す</button>
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('output_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">出力先を選び直す</button>
                                <button
                                    onClick={finalApply}
                                    disabled={isBusy || isCheckingConnection || !initialStateReady}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    <MdCheckCircle /> 設定を保存して開始
                                </button>
                            </div>
                    </>)}
                </div>}
            </div>
        </div>
        </Modal>
    );
};

// --- Helper Component ---
interface SelectionCardProps {
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    description: string;
    active: boolean;
    color: string;
    children?: React.ReactNode;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ onClick, icon, title, description, active, children }) => {
    const activeClass = 'border-primary text-foreground';
    const activeBg = 'bg-primary/5';
    const activeRing = 'ring-1 ring-primary/50';

    return (
        <div
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={title}
            onKeyDown={(e) => {
                if (e.currentTarget !== e.target) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
            className={`cursor-pointer flex flex-col items-center p-3 border rounded-md transition-colors group relative overflow-hidden
                ${active ? `${activeClass} ${activeBg} ${activeRing}` : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
        >
            <div className="mb-2">
                {icon}
            </div>
            <h3 className={`font-bold mb-1 ${active ? '' : 'text-foreground'}`}>{title}</h3>
            <p className="text-xs text-muted-foreground text-center">
                {description}
            </p>
            {children && (
                <div className="mt-2 w-full">
                    {children}
                </div>
            )}
        </div>
    );
};
