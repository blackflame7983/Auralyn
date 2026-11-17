import { useEffect } from 'react';
import type { SingingDraft } from '@/hooks/useSingingDraft';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import { afterFrame } from '@/hooks/internal/schedule';

interface SoundSectionEffects {
    music: boolean;
    shown: string;
    singingModel: SingingDraft;
    liveModel: LiveModesModel;
    measurementNonce: number;
    noiseAdvancedOpen: boolean;
    noiseMeasurementOpen: boolean;
    setNoiseAdvancedOpen: (open: boolean) => void;
    setNoiseMeasurementOpen: (open: boolean) => void;
}

/** 音づくりの取得と、測定の入口から開いたあとの焦点。購読の始め方は変えない。 */
export function useSoundSectionEffects({
    music, shown, singingModel, liveModel, measurementNonce, noiseAdvancedOpen, noiseMeasurementOpen,
    setNoiseAdvancedOpen, setNoiseMeasurementOpen,
}: SoundSectionEffects): void {
    const activateSinging = singingModel.activate;
    const refreshSinging = singingModel.refresh;
    const activateLive = liveModel.activate;
    // 基本の声の値も歌向けの下書きと同じ取得を使う。小区分を開くまで待たない。
    useEffect(() => {
        if (music) return;
        const release = activateSinging();
        void refreshSinging();
        return release;
    }, [activateSinging, music, refreshSinging]);
    // 音量の保護を開いている間だけ、本番保護の状態を読む。購読は既存の activate に任せる。
    useEffect(() => {
        if (shown !== 'peak') return;
        return activateLive();
    }, [activateLive, shown]);
    // 測定の欄は詳細の中にある。入口から開くときは、親の詳細と測定の両方を開いてから焦点を移す。
    useEffect(() => {
        if (!measurementNonce) return;
        setNoiseAdvancedOpen(true);
        setNoiseMeasurementOpen(true);
    }, [measurementNonce, setNoiseAdvancedOpen, setNoiseMeasurementOpen]);
    useEffect(() => {
        if (!measurementNonce || !noiseAdvancedOpen || !noiseMeasurementOpen) return;
        return afterFrame(() => {
            const target = document.querySelector<HTMLElement>('#noise-measurement button');
            document.getElementById('noise-measurement')?.scrollIntoView?.({ block: 'center' });
            target?.focus({ preventScroll: true });
        });
    }, [measurementNonce, noiseAdvancedOpen, noiseMeasurementOpen]);
}
