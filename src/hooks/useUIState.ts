import { openStreamMixPanel } from '@/lib/streamMixPanel';
import { useCallback, useState } from 'react';
import type { AudioEngineExit } from '@/lib/audioEngineExit';
import { consumeLeaveSkip, requestLeave } from '@/components/layout/pageLeave';

export type AppPage = 'home' | 'sound' | 'vst' | 'connect' | 'settings';
export type SettingsPane = 'appearance' | 'shortcuts' | 'obs' | 'system';
export type SettingsTab = 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system';
export type SettingsAnchor = 'liveModes' | 'singing' | 'audioTuning' | 'liveOutput' | 'primaryInput';
export type SoundPlace = 'basic' | 'liveModes' | 'singing' | 'peak';

type Navigation = { page: AppPage; pane?: SettingsPane; section?: SettingsAnchor; retry?: boolean; soundPlace?: SoundPlace; soundFocus?: boolean; vstFocusAdd?: boolean };

function soundPlaceFrom(section?: SettingsAnchor): SoundPlace {
    if (section === 'liveModes') return 'liveModes';
    if (section === 'singing') return 'singing';
    return 'basic';
}

const settingsPanes: SettingsPane[] = ['appearance', 'shortcuts', 'obs', 'system'];

function pageOf(tab: SettingsTab): AppPage {
    if (tab === 'audio') return 'connect';
    if (tab === 'sound') return 'sound';
    return 'settings';
}

function paneOf(tab: SettingsTab): SettingsPane {
    return settingsPanes.includes(tab as SettingsPane) ? tab as SettingsPane : 'appearance';
}

export const useUIState = () => {
    const [page, setPage] = useState<AppPage>('home');
    const [settingsPane, setSettingsPane] = useState<SettingsPane>('appearance');
    // 同じ場所への移動を続けて頼まれても切り替わるよう、頼むたびに番号を進める。
    const [settingsTabRequest, setSettingsTabRequest] = useState(0);
    const [settingsSection, setSettingsSection] = useState<SettingsAnchor>();
    const [soundPlace, setSoundPlace] = useState<SoundPlace>('basic');
    // 入口から小区分を指定して開いたときだけ、見出しへ焦点を移す。
    const [soundFocusNonce, setSoundFocusNonce] = useState(0);
    // VST のページを開くたびに進める。追加から開いたときだけ、追加ボタンへ焦点を移す。
    const [vstFocusAdd, setVstFocusAdd] = useState(false);
    const [vstOpenNonce, setVstOpenNonce] = useState(0);
    const [settingsNeedsRetry, setSettingsNeedsRetry] = useState(false);
    // ホームと接続は、以前の音声タブと同じ入口として扱う。
    const settingsTab: SettingsTab = page === 'sound' ? 'sound' : page === 'settings' ? settingsPane : 'audio';
    // VST は設定のページではない。未保存の確認は、移動のときに pageLeave が行う。
    const isSettingsOpen = page === 'sound' || page === 'connect' || page === 'settings';

    const commit = useCallback((next: Navigation) => {
        if (next.pane) setSettingsPane(next.pane);
        setSettingsSection(next.section);
        if (next.page === 'sound') {
            setSoundPlace(next.soundPlace ?? soundPlaceFrom(next.section));
            if (next.soundFocus) setSoundFocusNonce(n => n + 1);
        }
        if (next.page === 'vst') {
            setVstFocusAdd(Boolean(next.vstFocusAdd));
            setVstOpenNonce(n => n + 1);
        }
        setSettingsNeedsRetry(next.retry ?? false);
        setSettingsTabRequest(n => n + 1);
        setPage(next.page);
    }, []);

    const samePlace = (next: Navigation) => page === next.page && (next.page !== 'settings' || !next.pane || next.pane === settingsPane);

    const go = (next: Navigation) => {
        // システムの再起動は、接続ページの未保存の変更を適用する。ここで捨てると、再起動の条件が変わる（6.3）。
        const restartKeepsConnection = page === 'connect' && next.page === 'settings' && next.pane === 'system';
        const nextSound = next.page === 'sound' ? (next.soundPlace ?? soundPlaceFrom(next.section)) : null;
        // 同じ音づくりページでも、小区分が替わるときは未適用の保護値を確認する。
        const soundMove = nextSound !== null && nextSound !== soundPlace;
        // 保存成功の一度だけは、同じ場所でも処理中の停止を消費する。
        if (restartKeepsConnection || consumeLeaveSkip() || (samePlace(next) && !soundMove)) { commit(next); return; }
        requestLeave(() => commit(next));
    };

    const applyNavigation = commit;
    const leave = useCallback((action: () => void) => requestLeave(action), []);

    // 開く画面と区分を一度に指定し、既定の場所への初期化で移動先を失わないようにする。
    const setIsSettingsOpen = (open: boolean, tab: SettingsTab = 'audio') => {
        if (!open) { go({ page: 'home' }); return; }
        const destination = pageOf(tab);
        go({ page: destination, pane: destination === 'settings' ? paneOf(tab) : undefined });
    };
    const openShortcuts = () => go({ page: 'settings', pane: 'shortcuts' });
    const openObsSettings = () => go({ page: 'settings', pane: 'obs' });
    const openAudioTuning = () => go({ page: 'connect', section: 'audioTuning' });
    // 配信ミックスは設定ではなくホームのパネルで扱う（#299）。
    const openMixingSettings = () => openStreamMixPanel();
    // 配信ミックスのパネルから、出力先・入力元の区画を開いて案内する。
    const openDeviceSettings = (target: 'output' | 'input') => go({ page: 'connect', section: target === 'output' ? 'liveOutput' : 'primaryInput' });
    const openSoundSettings = (section?: 'liveModes' | 'singing') => {
        // イベントハンドラーとして渡された場合も、選択イベントを移動先へ持ち込まない。
        const anchor = section === 'liveModes' || section === 'singing' ? section : undefined;
        go({ page: 'sound', section: anchor, soundFocus: anchor !== undefined });
    };
    const openLiveModeSettings = () => go({ page: 'sound', section: 'liveModes', soundFocus: true });
    // ページ内の小区分。focus は入口のボタンだけ。タブのクリックでは見出しへ移さない。
    const moveSoundPlace = (place: SoundPlace, focus = false) => go({
        page: 'sound',
        soundPlace: place,
        section: place === 'liveModes' || place === 'singing' ? place : undefined,
        soundFocus: focus,
    });
    const openAudioSettingsRetry = () => go({ page: 'connect', retry: true });
    // 追加から開いたときだけ、ページの「VSTを追加」へ焦点を移す。
    const openVst = (focusAdd = false) => go({ page: 'vst', vstFocusAdd: focusAdd });
    const [isBrowserOpen, setIsBrowserOpen] = useState(false);
    const [isOBSGuideOpen, setIsOBSGuideOpen] = useState(false);
    const [isDiscordGuideOpen, setIsDiscordGuideOpen] = useState(false);
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [isTemplateWizardOpen, setIsTemplateWizardOpen] = useState(false);
    const [isLicenseModalOpen, setIsLicenseModalOpen] = useState(false);
    const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
    const [crashError, setCrashError] = useState<string | null>(null);
    const [crashExit, setCrashExit] = useState<AudioEngineExit>();
    const [isPresetManagerOpen, setIsPresetManagerOpen] = useState(false);
    const [isTroubleshootOpen, setIsTroubleshootOpen] = useState(false);
    const [isVoiceCheckOpen, setIsVoiceCheckOpen] = useState(false);

    return {
        page,
        settingsPane,
        isSettingsOpen,
        setIsSettingsOpen,
        settingsTab,
        settingsTabRequest,
        settingsSection,
        soundPlace,
        soundFocusNonce,
        vstFocusAdd,
        vstOpenNonce,
        openVst,
        moveSoundPlace,
        settingsNeedsRetry,
        openAudioSettingsRetry,
        openLiveModeSettings,
        openObsSettings,
        openShortcuts,
        openAudioTuning,
        openMixingSettings,
        openDeviceSettings,
        openSoundSettings,
        leave,
        applyNavigation,
        isBrowserOpen,
        setIsBrowserOpen,
        isOBSGuideOpen,
        setIsOBSGuideOpen,
        isDiscordGuideOpen,
        setIsDiscordGuideOpen,
        isWizardOpen,
        setIsWizardOpen,
        isTemplateWizardOpen,
        setIsTemplateWizardOpen,
        isRecoveryModalOpen,
        setIsRecoveryModalOpen,
        crashError,
        setCrashError,
        crashExit,
        setCrashExit,
        isPresetManagerOpen,
        setIsPresetManagerOpen,
        isLicenseModalOpen,
        setIsLicenseModalOpen,
        isTroubleshootOpen,
        setIsTroubleshootOpen,
        isVoiceCheckOpen,
        setIsVoiceCheckOpen,
    };
};
