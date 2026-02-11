import { createContext, useContext, useReducer, useCallback, ReactNode } from 'react';

// モーダルの種別
type ModalType =
    | 'settings'
    | 'browser'
    | 'obsGuide'
    | 'discordGuide'
    | 'wizard'
    | 'templateWizard'
    | 'licenseModal'
    | 'recoveryModal'
    | 'presetManager'
    | 'largeMeter';

// UIの状態型
interface UIState {
    modals: Record<ModalType, boolean>;
    crashError: string | null;
}

// アクション定義
type UIAction =
    | { type: 'OPEN_MODAL'; modal: ModalType }
    | { type: 'CLOSE_MODAL'; modal: ModalType }
    | { type: 'TOGGLE_MODAL'; modal: ModalType }
    | { type: 'SET_CRASH_ERROR'; error: string | null };

// 初期状態
const initialState: UIState = {
    modals: {
        settings: false,
        browser: false,
        obsGuide: false,
        discordGuide: false,
        wizard: false,
        templateWizard: false,
        licenseModal: false,
        recoveryModal: false,
        presetManager: false,
        largeMeter: false,
    },
    crashError: null,
};

// リデューサー
function uiReducer(state: UIState, action: UIAction): UIState {
    switch (action.type) {
        case 'OPEN_MODAL':
            return { ...state, modals: { ...state.modals, [action.modal]: true } };
        case 'CLOSE_MODAL':
            return { ...state, modals: { ...state.modals, [action.modal]: false } };
        case 'TOGGLE_MODAL':
            return { ...state, modals: { ...state.modals, [action.modal]: !state.modals[action.modal] } };
        case 'SET_CRASH_ERROR':
            return { ...state, crashError: action.error };
        default:
            return state;
    }
}

// 後方互換のため既存のインターフェースを維持
interface UIContextType {
    isSettingsOpen: boolean;
    setIsSettingsOpen: (open: boolean) => void;
    isBrowserOpen: boolean;
    setIsBrowserOpen: (open: boolean) => void;
    isOBSGuideOpen: boolean;
    setIsOBSGuideOpen: (open: boolean) => void;
    isDiscordGuideOpen: boolean;
    setIsDiscordGuideOpen: (open: boolean) => void;
    isWizardOpen: boolean;
    setIsWizardOpen: (open: boolean) => void;
    isTemplateWizardOpen: boolean;
    setIsTemplateWizardOpen: (open: boolean) => void;
    isLicenseModalOpen: boolean;
    setIsLicenseModalOpen: (open: boolean) => void;
    isRecoveryModalOpen: boolean;
    setIsRecoveryModalOpen: (open: boolean) => void;
    crashError: string | null;
    setCrashError: (error: string | null) => void;
    isPresetManagerOpen: boolean;
    setIsPresetManagerOpen: (open: boolean) => void;
    isLargeMeterOpen: boolean;
    setIsLargeMeterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

// モーダルの setter を生成するヘルパー
function useModalSetter(dispatch: React.Dispatch<UIAction>, modal: ModalType) {
    return useCallback((open: boolean | ((prev: boolean) => boolean)) => {
        // コールバック関数が渡された場合はトグルとして扱う
        if (typeof open === 'function') {
            dispatch({ type: 'TOGGLE_MODAL', modal });
        } else {
            dispatch({ type: open ? 'OPEN_MODAL' : 'CLOSE_MODAL', modal });
        }
    }, [dispatch, modal]);
}

export const UIProvider = ({ children }: { children: ReactNode }) => {
    const [state, dispatch] = useReducer(uiReducer, initialState);

    // 各モーダルのsetterを生成（後方互換）
    const setIsSettingsOpen = useModalSetter(dispatch, 'settings');
    const setIsBrowserOpen = useModalSetter(dispatch, 'browser');
    const setIsOBSGuideOpen = useModalSetter(dispatch, 'obsGuide');
    const setIsDiscordGuideOpen = useModalSetter(dispatch, 'discordGuide');
    const setIsWizardOpen = useModalSetter(dispatch, 'wizard');
    const setIsTemplateWizardOpen = useModalSetter(dispatch, 'templateWizard');
    const setIsLicenseModalOpen = useModalSetter(dispatch, 'licenseModal');
    const setIsRecoveryModalOpen = useModalSetter(dispatch, 'recoveryModal');
    const setIsPresetManagerOpen = useModalSetter(dispatch, 'presetManager');
    const setIsLargeMeterOpen = useModalSetter(dispatch, 'largeMeter');

    const setCrashError = useCallback((error: string | null) => {
        dispatch({ type: 'SET_CRASH_ERROR', error });
    }, [dispatch]);

    const value: UIContextType = {
        isSettingsOpen: state.modals.settings,
        setIsSettingsOpen,
        isBrowserOpen: state.modals.browser,
        setIsBrowserOpen,
        isOBSGuideOpen: state.modals.obsGuide,
        setIsOBSGuideOpen,
        isDiscordGuideOpen: state.modals.discordGuide,
        setIsDiscordGuideOpen,
        isWizardOpen: state.modals.wizard,
        setIsWizardOpen,
        isTemplateWizardOpen: state.modals.templateWizard,
        setIsTemplateWizardOpen,
        isLicenseModalOpen: state.modals.licenseModal,
        setIsLicenseModalOpen,
        isRecoveryModalOpen: state.modals.recoveryModal,
        setIsRecoveryModalOpen,
        crashError: state.crashError,
        setCrashError,
        isPresetManagerOpen: state.modals.presetManager,
        setIsPresetManagerOpen,
        isLargeMeterOpen: state.modals.largeMeter,
        setIsLargeMeterOpen,
    };

    return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
};

export const useUIState = () => {
    const context = useContext(UIContext);
    if (context === undefined) {
        throw new Error('useUIState must be used within a UIProvider');
    }
    return context;
};
