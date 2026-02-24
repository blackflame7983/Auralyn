import React, { useState } from 'react';
import { MdVideocam, MdClose, MdLightbulb, MdSettings, MdCheckCircle, MdArrowForward, MdArrowBack, MdHeadphones, MdMic } from 'react-icons/md';

interface OBSGuideModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings: () => void;
}

export const OBSGuideModal: React.FC<OBSGuideModalProps> = ({ isOpen, onClose, onOpenAudioSettings }) => {
    // step 0: Device Type Selection (Hardware Mixer vs Software)
    // step 1: Driver/Software Setup
    // step 2: Output & Monitoring
    // step 3: OBS Setup
    const [step, setStep] = useState(0);
    const [useHardwareMixer, setUseHardwareMixer] = useState<boolean | null>(null);
    const totalSteps = 4; // 0 to 3

    if (!isOpen) return null;

    const nextStep = () => {
        if (step < totalSteps - 1) setStep(step + 1);
        else onClose();
    };

    const prevStep = () => {
        if (step > 0) setStep(step - 1);
    };

    const handleDeviceSelection = (isHardware: boolean) => {
        setUseHardwareMixer(isHardware);
        nextStep();
    };

    return (
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-2xl flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="modal-header-base modal-header-muted shrink-0">
                    <h2 className="text-2xl font-bold text-foreground flex items-center gap-3">
                        <span className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                            <MdVideocam className="w-5 h-5" />
                        </span>
                        OBS連携セットアップ
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label="OBS連携ガイドを閉じる"
                        className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
                    >
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                {/* Progress Bar (Skipped for Step 0) */}
                {step > 0 && (
                    <div className="px-6 pt-4 shrink-0">
                        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-out shadow-[0_0_10px_rgba(var(--primary),0.5)]"
                                style={{ width: `${(step / (totalSteps - 1)) * 100}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Content Area */}
                <div className="modal-body-base pr-4">
                    {step === 0 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">はじめに: 使用機器の確認</h3>
                            <p className="text-muted-foreground">
                                お使いのオーディオ環境に合わせて、最適なセットアップ手順を案内します。
                            </p>

                            <div className="grid md:grid-cols-2 gap-4 mt-4">
                                <button
                                    onClick={() => handleDeviceSelection(true)}
                                    aria-label="機材を使用している手順を選択"
                                    className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-primary/50 transition-all text-left group"
                                >
                                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                        <MdMic className="w-6 h-6 text-primary" />
                                    </div>
                                    <h4 className="font-bold text-foreground mb-2">機材を使用している</h4>
                                    <p className="text-sm text-muted-foreground">
                                        Yamaha AG03/06, GoXLR, Audientなどのオーディオインターフェース/ミキサーを使用。
                                    </p>
                                    <span className="inline-block mt-4 text-xs font-bold text-primary bg-primary/10 px-2 py-1 rounded">
                                        ループバック機能を利用
                                    </span>
                                </button>

                                <button
                                    onClick={() => handleDeviceSelection(false)}
                                    aria-label="機材を使用していない手順を選択"
                                    className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-primary/50 transition-all text-left group"
                                >
                                    <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                        <MdHeadphones className="w-6 h-6 text-secondary-foreground" />
                                    </div>
                                    <h4 className="font-bold text-foreground mb-2">機材を使用していない</h4>
                                    <p className="text-sm text-muted-foreground">
                                        PCに直接マイク/ヘッドセットを接続している、またはUSBマイク単体を使用。
                                    </p>
                                    <span className="inline-block mt-4 text-xs font-bold text-secondary-foreground bg-secondary/10 px-2 py-1 rounded">
                                        仮想ケーブルを利用
                                    </span>
                                </button>
                            </div>
                        </div>
                    )}

                    {step === 1 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">
                                {useHardwareMixer ? '手順 1: ループバックの確認' : '手順 1: 仮想オーディオデバイスの準備'}
                            </h3>

                            {useHardwareMixer ? (
                                <div className="space-y-4">
                                    <p className="text-muted-foreground">
                                        お使いのオーディオインターフェースの <strong>ループバック機能</strong> をONにしてください。
                                    </p>
                                    <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg">
                                        <h4 className="font-bold text-primary flex items-center gap-2 mb-2">
                                            <MdCheckCircle /> おすすめの設定
                                        </h4>
                                        <p className="text-sm text-muted-foreground">
                                            Auralynの音声をインターフェースに戻し、それをループバック機能でOBS等の配信ソフトに送る形になります。<br />
                                            別途ソフトウェアのインストールは不要です。
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <p className="text-muted-foreground leading-relaxed">
                                        OBSに音声を送るためには、「仮想オーディオケーブル」を使用するのが最も一般的です。<br />
                                        まだインストールしていない場合は、以下のリンクからインストールしてください。
                                    </p>
                                    <div className="bg-muted/30 p-6 rounded-xl border border-border">
                                        <h4 className="font-bold text-foreground mb-2">推奨ソフトウェア</h4>
                                        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                                            <li>
                                                <a href="https://vb-audio.com/Cable/" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                                                    VB-CABLE (無料)
                                                </a>
                                                <span className="text-muted-foreground text-sm ml-2">- シンプルで使いやすい</span>
                                            </li>
                                        </ul>
                                    </div>
                                    <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex gap-3">
                                        <MdLightbulb className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                                        <p className="text-yellow-600 dark:text-yellow-400 text-sm">
                                            <strong>補足:</strong> インストール後はPCの再起動が必要になる場合があります。
                                        </p>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">手順 2: 出力とモニタリング</h3>
                            <p className="text-muted-foreground">
                                Auralynの出力先を設定し、自分の声を聞く方法を確認します。
                            </p>

                            <div className="flex flex-col gap-4 py-4">
                                <div className="bg-card border border-border p-4 rounded-lg flex items-center justify-between">
                                    <div>
                                        <div className="font-bold text-foreground mb-1">出力先</div>
                                        <div className="text-sm text-primary font-mono">
                                            {useHardwareMixer ? 'お使いの機器 (例: AG06/03)' : 'CABLE Input（VB-Audio 仮想ケーブル）'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={onOpenAudioSettings}
                                        aria-label="オーディオ設定を開く"
                                        className="px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg border border-border transition-colors flex items-center gap-2 text-sm"
                                    >
                                        <MdSettings className="w-4 h-4" />
                                        設定を変更
                                    </button>
                                </div>

                                <div className="border-t border-border my-2"></div>

                                <h4 className="font-bold text-foreground flex items-center gap-2">
                                    <MdHeadphones className="w-5 h-5" />
                                    自分の声を聞くには？（モニタリング）
                                </h4>

                                {useHardwareMixer ? (
                                    <div className="space-y-2">
                                        <p className="text-sm text-muted-foreground">
                                            <strong>ハードウェアの機能を使用します（推奨・遅延なし）。</strong>
                                        </p>
                                        <ul className="list-disc list-inside text-sm text-muted-foreground pl-2 bg-muted/30 p-3 rounded">
                                            <li>Yamaha AG03/06: <strong>MONITOR MUTE</strong> をOFFにする（モニター有効）</li>
                                            <li>オーディオインターフェース: <strong>Direct Monitor</strong> またはMixつまみを調整</li>
                                        </ul>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <p className="text-sm text-muted-foreground">
                                            「CABLE Input（VB-Audio 仮想ケーブル）」に出力すると、スピーカーから音が出なくなります。<br />
                                            自分の声を聞く必要がある場合は、以下のいずれかを行ってください。
                                        </p>

                                        <div className="bg-yellow-500/5 border border-yellow-500/20 p-3 rounded text-sm">
                                            <div className="font-bold text-yellow-600 dark:text-yellow-400 mb-1">方法A: OBSで聞く (推奨)</div>
                                            <p className="text-muted-foreground text-xs">
                                                次のステップで追加する音声ソースの「オーディオ詳細プロパティ」で<br />
                                                <strong>「モニターと出力」</strong>を選択すると、OBS経由で聞くことができます。
                                            </p>
                                        </div>

                                        <div className="bg-muted/30 p-3 rounded text-sm relative group">
                                            <div className="font-bold text-foreground mb-1">方法B: Windows機能で聞く (遅延あり)</div>
                                            <p className="text-muted-foreground text-xs leading-relaxed">
                                                Windows設定 {'>'} システム {'>'} サウンド {'>'} 録音 {'>'}<br />
                                                <strong>CABLE Output（VB-Audio 仮想ケーブル）</strong> のプロパティ {'>'} 「聴く」タブ {'>'} <strong>「このデバイスを聴く」</strong>をON<br />
                                                <span className="text-destructive/80 mt-1 block font-bold text-[10px]">※ 遅延が発生するため、歌枠などには不向きです。</span>
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">手順 3: OBS側の設定</h3>
                            <p className="text-muted-foreground leading-relaxed">
                                最後に、OBSでその音声を受け取る設定を行います。
                            </p>

                            <div className="space-y-4">
                                <div className="bg-muted/30 p-4 rounded-lg border border-border">
                                    <h4 className="font-bold text-foreground mb-2">設定手順:</h4>
                                    <ol className="list-decimal list-inside space-y-2 text-muted-foreground text-sm">
                                        <li>OBSの「ソース」欄で右クリック → <strong>[追加]</strong></li>
                                        <li><strong>[音声入力キャプチャ]</strong> を選択</li>
                                        <li>
                                            デバイスとして以下を選択:
                                            <div className="mt-2 ml-4 p-2 bg-background border border-border rounded font-mono text-primary">
                                                {useHardwareMixer ? (
                                                    // Hardware user -> Output of mixer (often depends on driver, usually line/stream)
                                                    "ループバック / 配信用ストリーム / ライン (お使いの機器名)"
                                                ) : (
                                                    // Software user -> Cable Output
                                                    "CABLE Output（VB-Audio 仮想ケーブル）"
                                                )}
                                            </div>
                                        </li>
                                    </ol>
                                </div>

                                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 space-y-2">
                                    <p className="text-primary text-sm font-bold flex items-center gap-2">
                                        <MdCheckCircle className="w-5 h-5" />
                                        セットアップ完了！
                                    </p>
                                    <p className="text-muted-foreground text-xs pl-7">
                                        ・エフェクトは自動保存されます。<br />
                                        ・<strong>Alt + M</strong> でいつでもマイクをミュートできます。
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer / Navigation */}
                <div className="modal-footer-base flex justify-between items-center shrink-0">
                    <button
                        onClick={prevStep}
                        aria-label="前の手順へ戻る"
                        className={`px-4 py-2 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 ${step === 0 ? 'invisible' : ''}`}
                    >
                        <MdArrowBack className="w-4 h-4" /> 戻る
                    </button>

                    <button
                        onClick={nextStep}
                        aria-label={step === (totalSteps - 1) ? 'ガイドを完了する' : '次の手順へ進む'}
                        className="px-6 py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-md shadow-lg transition-all flex items-center gap-2"
                    >
                        {step === (totalSteps - 1) ? '完了' : <>次へ <MdArrowForward className="w-4 h-4" /></>}
                    </button>
                </div>

            </div>
        </div>
    );
};

