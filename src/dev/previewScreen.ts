// 開発プレビュー（?mock=）で、俯瞰用に画面を最初から開く。本番ビルドからは読み込まない。
import { saveVstPanelOpen } from '@/hooks/useVstPanel';
import { openStreamMixPanel } from '@/lib/streamMixPanel';

export const previewScreenNames = [
    'settings-audio',
    'settings-sound',
    'settings-obs',
    'settings-appearance',
    'settings-shortcuts',
    'settings-system',
    'obs-guide',
    'discord-guide',
    'troubleshoot',
    'voice-check',
    'help',
    'plugin-browser',
    'presets',
    'template-wizard',
    'license',
    'stream-mix',
    'vst-panel',
] as const;

export type PreviewScreenName = (typeof previewScreenNames)[number];

export interface PreviewScreenControls {
    setIsSettingsOpen: (open: boolean, tab?: 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system') => void;
    openSoundSettings: () => void;
    openObsSettings: () => void;
    openShortcuts: () => void;
    setIsOBSGuideOpen: (open: boolean) => void;
    setIsDiscordGuideOpen: (open: boolean) => void;
    setIsTroubleshootOpen: (open: boolean) => void;
    setIsVoiceCheckOpen: (open: boolean) => void;
    setIsBrowserOpen: (open: boolean) => void;
    setIsPresetManagerOpen: (open: boolean) => void;
    setIsTemplateWizardOpen: (open: boolean) => void;
    setIsLicenseModalOpen: (open: boolean) => void;
}

// 開けたら true。使い方は Header が同じクエリを見て開く。
export function applyPreviewScreen(screen: string, ui: PreviewScreenControls): boolean {
    switch (screen) {
        case 'settings-audio': ui.setIsSettingsOpen(true); return true;
        case 'settings-sound': ui.openSoundSettings(); return true;
        case 'settings-obs': ui.openObsSettings(); return true;
        case 'settings-appearance': ui.setIsSettingsOpen(true, 'appearance'); return true;
        case 'settings-shortcuts': ui.openShortcuts(); return true;
        case 'settings-system': ui.setIsSettingsOpen(true, 'system'); return true;
        case 'obs-guide': ui.setIsOBSGuideOpen(true); return true;
        case 'discord-guide': ui.setIsDiscordGuideOpen(true); return true;
        case 'troubleshoot': ui.setIsTroubleshootOpen(true); return true;
        case 'voice-check': ui.setIsVoiceCheckOpen(true); return true;
        case 'help': return true;
        case 'plugin-browser': ui.setIsBrowserOpen(true); return true;
        case 'presets': ui.setIsPresetManagerOpen(true); return true;
        case 'template-wizard': ui.setIsTemplateWizardOpen(true); return true;
        case 'license': ui.setIsLicenseModalOpen(true); return true;
        case 'stream-mix': openStreamMixPanel(); return true;
        case 'vst-panel': saveVstPanelOpen(true); return true;
        default: return false;
    }
}
