import React, { useState } from 'react';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { MdClose, MdArrowForward, MdArrowBack, MdCheckCircle, MdWarning, MdSettings, MdMic, MdGraphicEq, MdHeadphones } from 'react-icons/md';

interface DiscordGuideModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings: () => void;
}

export const DiscordGuideModal: React.FC<DiscordGuideModalProps> = ({ isOpen, onClose, onOpenAudioSettings }) => {
    // step 0: Device Type Selection
    // step 1: Output & Echo Warning
    // step 2: Input Setup
    // step 3: Processing Setting
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
            <div className="modal-surface-base w-full max-w-3xl flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="modal-header-base modal-header-muted shrink-0">
                    <h2 className="text-xl font-bold flex items-center gap-2 text-foreground">
                        <span className="w-8 h-8 rounded-lg bg-[#5865F2] flex items-center justify-center text-white">
                            <DiscordIcon className="w-5 h-5" />
                        </span>
                        Discord連携ガイド
                    </h2>
                    <button onClick={onClose} aria-label="Discord連携ガイドを閉じる" className="text-muted-foreground hover:text-foreground transition-colors">
                        <MdClose className="w-6 h-6" />
                    </button>
                </div>

                {/* Content */}
                <div className="modal-body-base p-8">

                    {/* Progress Bar (Skipped for Step 0) */}
                    {step > 0 && (
                        <div className="flex items-center gap-2 mb-8 justify-center shrink-0">
                            {[1, 2, 3].map(i => {
                                const activeStep = step; // 1, 2, 3
                                return (
                                    <div key={i} className={`flex items-center ${i < 3 ? 'flex-1' : ''}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors
                                            ${activeStep === i ? 'border-[#5865F2] text-[#5865F2] bg-[#5865F2]/10' :
                                                activeStep > i ? 'border-[#5865F2] bg-[#5865F2] text-white' :
                                                    'border-muted text-muted-foreground'}`}>
                                            {activeStep > i ? <MdCheckCircle className="w-5 h-5" /> : i}
                                        </div>
                                        {i < 3 && (
                                            <div className={`h-1 flex-1 mx-2 rounded-full ${activeStep > i ? 'bg-[#5865F2]' : 'bg-muted'}`} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className="space-y-6">
                        {step === 0 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">使用機器の確認</h3>
                                    <p className="text-muted-foreground">
                                        使用している機材によって設定方法と注意点が異なります。
                                    </p>
                                </div>

                                <div className="grid md:grid-cols-2 gap-6 mt-8">
                                    <button
                                        onClick={() => handleDeviceSelection(true)}
                                        aria-label="機材を使用している手順を選択"
                                        className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-[#5865F2]/50 transition-all text-left flex flex-col items-center text-center group"
                                    >
                                        <div className="w-16 h-16 rounded-full bg-[#5865F2]/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdMic className="w-8 h-8 text-[#5865F2]" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-lg mb-2">機材を使用している</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            AG03/AG06等のミキサー機能付きインターフェースを使用
                                        </p>
                                        <div className="flex items-center gap-2 text-xs font-bold text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30 dark:text-yellow-400 px-3 py-1 rounded-full">
                                            <MdWarning /> エコー注意（ループバック）
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => handleDeviceSelection(false)}
                                        aria-label="機材を使用していない手順を選択"
                                        className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-[#5865F2]/50 transition-all text-left flex flex-col items-center text-center group"
                                    >
                                        <div className="w-16 h-16 rounded-full bg-secondary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdHeadphones className="w-8 h-8 text-secondary-foreground" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-lg mb-2">機材を使用していない</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            PC直結またはUSBマイク単体を使用
                                        </p>
                                        <div className="flex items-center gap-2 text-xs font-bold text-secondary-foreground bg-secondary/10 px-3 py-1 rounded-full">
                                            <MdCheckCircle /> おすすめ
                                        </div>
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 1 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">1. 出力先とリスク確認</h3>
                                    <p className="text-muted-foreground">
                                        Auralynの出力先を設定します。
                                    </p>
                                </div>

                                <div className="bg-[#5865F2]/5 p-6 rounded-xl border border-[#5865F2]/20 flex flex-col items-center text-center space-y-4">
                                    <div className="w-12 h-12 bg-[#5865F2]/10 rounded-full flex items-center justify-center">
                                        <MdSettings className="w-6 h-6 text-[#5865F2]" />
                                    </div>
                                    <div>
                                        <h4 className="font-bold mb-1">出力先</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            以下のように設定してください
                                        </p>
                                        <button
                                            onClick={onOpenAudioSettings}
                                            aria-label="オーディオ設定を開く"
                                            className="px-4 py-2 bg-[#5865F2] hover:bg-[#5865F2]/90 text-white font-bold rounded-lg text-sm transition-all"
                                        >
                                            オーディオ設定を開く
                                        </button>
                                    </div>
                                        <div className="text-xs text-left bg-background p-3 rounded border border-border w-full mt-2 font-mono text-center">
                                        {useHardwareMixer
                                            ? "お使いの機器の入力 (AG06/AG03 等)"
                                            : "CABLE Input（VB-Audio 仮想ケーブル）"}
                                    </div>
                                </div>

                                {useHardwareMixer ? (
                                    <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg flex gap-4 text-left">
                                        <MdWarning className="w-8 h-8 text-destructive shrink-0" />
                                        <div className="space-y-1">
                                            <h4 className="font-bold text-destructive">通話相手の声がループする危険性</h4>
                                            <p className="text-sm text-foreground">
                                                ハードウェアのループバック機能を使ってDiscord通話をすると、<strong>「相手の声」が自分のマイク音声に乗って相手に跳ね返る（エコー）</strong>リスクが高いです。
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-2">
                                                対策: Discordの「出力デバイス」をループバックに含まれない経路（例: PCのヘッドホン端子など）にするか、ミキサー側で調整が必要です。<br />
                                                設定が難しい場合は、あえて「機材を使用していない」手順（VB-CABLE）を使うことをお勧めします。
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col space-y-2 text-sm text-muted-foreground">
                                        <div className="flex items-start gap-3 p-3 bg-card border border-border rounded">
                                            <MdHeadphones className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                                            <div>
                                                <p className="font-bold text-foreground">自分の声を聞くには？</p>
                                                <p>CABLE Input（VB-Audio 仮想ケーブル）を使うと自分の声が消えます。「PCのサウンド設定」で「このデバイスを聴く」をONにすることもできますが、遅延が発生するため推奨しません。</p>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {step === 2 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">2. Discordの設定 (入力デバイス)</h3>
                                    <p className="text-muted-foreground">
                                        Discordのマイクとして、加工後の音声を選びます。
                                    </p>
                                </div>

                                <div className="bg-[#1e1f22] p-6 rounded-xl border border-border shadow-inner max-w-xl mx-auto space-y-4">
                                    <div className="flex items-center gap-2 text-gray-400 text-xs uppercase font-bold tracking-wider mb-2">
                                        <MdSettings /> 音声設定
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-gray-300 text-xs font-bold uppercase">入力デバイス</label>
                                        <div className="bg-[#111214] p-3 rounded border border-gray-700 flex justify-between items-center text-white cursor-pointer hover:bg-[#2b2d31] transition-colors">
                                            <span className="flex items-center gap-2">
                                                <MdMic className="text-green-500" />
                                                {useHardwareMixer ? "ループバック / 配信用ストリーム (お使いの機器)" : "CABLE Output（VB-Audio 仮想ケーブル）"}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="space-y-2 opacity-50 pointer-events-none">
                                        <label className="text-gray-300 text-xs font-bold uppercase">出力デバイス</label>
                                        <div className="bg-[#111214] p-3 rounded border border-gray-700 text-white">
                                            <span>既定 / ヘッドホン</span>
                                        </div>
                                    </div>

                                    {useHardwareMixer && (
                                        <p className="text-xs text-red-400 mt-2">
                                            ※ 重要: ここで設定した「入力デバイス」と同じ機材を「出力デバイス」に選ぶと、エコーが発生しやすくなります。
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">3. 音声処理をOFFにする (重要)</h3>
                                    <p className="text-muted-foreground">
                                        Discordの高機能なノイズ除去が、VSTで整えた音質を劣化させる原因になります。
                                    </p>
                                </div>

                                <div className="grid gap-4 max-w-2xl mx-auto">
                                    <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg flex items-start gap-4">
                                        <MdWarning className="w-8 h-8 text-destructive shrink-0" />
                                        <div>
                                            <h4 className="font-bold text-destructive mb-1">まずはOFF推奨（音質が崩れる原因になりやすい）</h4>
                                            <ul className="list-disc list-inside text-sm space-y-1 text-foreground">
                                                <li><strong>ノイズ抑制 (Krisp / Standard)</strong> → <span className="text-destructive font-bold">無効化</span></li>
                                                <li><strong>エコー除去</strong> → <span className="text-destructive font-bold">OFF</span></li>
                                                <li><strong>音量調節の自動化</strong> → <span className="text-destructive font-bold">OFF</span></li>
                                            </ul>
                                            <p className="text-xs text-muted-foreground mt-2">
                                                これらがONだと、EQで調整した低音やクリアな高音が「ノイズ」と判定されて消されてしまいます。
                                            </p>
                                        </div>
                                    </div>

                                    <div className="bg-muted/30 p-4 rounded-lg flex items-center gap-4">
                                        <MdGraphicEq className="w-6 h-6 text-primary shrink-0" />
                                        <div className="text-sm">
                                            <p className="font-bold">入力感度</p>
                                            <p className="text-muted-foreground">
                                                「自動検出」をOFFにし、バーを左端（最低値）近くに設定することをお勧めします。
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="modal-footer-base flex justify-between items-center shrink-0">
                    <button
                        onClick={prevStep}
                        aria-label="前の手順へ戻る"
                        disabled={step === 0}
                        className="px-6 py-2 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground transition-colors font-medium flex items-center gap-1"
                    >
                        <MdArrowBack /> 戻る
                    </button>
                    <div className="flex gap-2">
                        {step < (totalSteps - 1) ? (
                            <button
                                onClick={nextStep}
                                aria-label="次の手順へ進む"
                                className="px-8 py-2 bg-[#5865F2] hover:bg-[#5865F2]/90 text-white font-bold rounded-full shadow-lg transition-all flex items-center gap-2"
                            >
                                次へ
                                <MdArrowForward />
                            </button>
                        ) : (
                            <button
                                onClick={onClose}
                                aria-label="ガイドを完了する"
                                className="px-8 py-2 bg-green-600 hover:bg-green-500 text-white font-bold rounded-full shadow-lg transition-all flex items-center gap-2"
                            >
                                <MdCheckCircle />
                                完了
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
