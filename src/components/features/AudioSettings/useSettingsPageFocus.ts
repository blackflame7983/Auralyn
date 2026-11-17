import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { afterFrame } from '@/hooks/internal/afterFrame';
import { getBeginnerMode } from '@/hooks/useBeginnerMode';
import type { SoundPlace } from '@/hooks/useUIState';
import type { SettingsSection, SettingsTab } from './useSettingsNavigation';

type BodyRef = RefObject<HTMLDivElement | null>;

/** 本文の送り枠と、保存欄を差し込む場所。付いたときに状態へ移し、保存欄の高さの測定を始められるようにする。 */
export function useSettingsScroller() {
    const settingsBody = useRef<HTMLDivElement>(null);
    const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
    const [saveSlot, setSaveSlot] = useState<HTMLDivElement | null>(null);
    const bindScroller = useCallback((node: HTMLDivElement | null) => {
        settingsBody.current = node;
        setScrollerEl(current => current === node ? current : node);
    }, []);
    const bindSlot = useCallback((node: HTMLDivElement | null) => {
        setSaveSlot(current => current === node ? current : node);
    }, []);
    return { settingsBody, scrollerEl, saveSlot, bindScroller, bindSlot };
}

interface DeviceTargetInput {
    isOpen: boolean;
    initialSection: SettingsSection | undefined;
    loading: boolean;
    hasError: boolean;
    activeTab: SettingsTab;
    tabRequest: number;
    settingsBody: BodyRef;
}

/** 配信ミックスのパネルから来たときは、出力先・入力元の区画を開いて操作できる所へ移す（#299）。 */
export function useDeviceTargetFocus({ isOpen, initialSection, loading, hasError, activeTab, tabRequest, settingsBody }: DeviceTargetInput) {
    const [loadOutput, setLoadOutput] = useState(false);
    const outputFocusPending = useRef(false);
    useEffect(() => {
        if (!loading && outputFocusPending.current) {
            const control = settingsBody.current?.querySelector<HTMLElement>('#live-output-settings select');
            if (control) { outputFocusPending.current = false; control.scrollIntoView?.({ block: 'center' }); control.focus(); }
        }
    }, [loading, loadOutput, settingsBody]);
    const deviceTargetShown = useRef(false);
    useEffect(() => { deviceTargetShown.current = false; }, [tabRequest]);
    useEffect(() => {
        if (!isOpen) { deviceTargetShown.current = false; return; }
        if ((initialSection !== 'liveOutput' && initialSection !== 'primaryInput') || deviceTargetShown.current || loading || hasError || activeTab !== 'audio') return;
        return afterFrame(() => {
            const el = settingsBody.current?.querySelector<HTMLElement>(initialSection === 'liveOutput' ? '#live-output-settings' : '#primary-input-settings');
            if (!el) return;
            // 出力一覧は開いたときに読み込む。読み込み後に出力先の選択へ移る。
            if (el instanceof HTMLDetailsElement) {
                deviceTargetShown.current = true;
                el.open = true;
                const parent = el.parentElement?.closest('details');
                if (parent instanceof HTMLDetailsElement) parent.open = true;
                outputFocusPending.current = true;
                setLoadOutput(true);
            }
            const control = el.querySelector<HTMLElement>('summary, select:not([disabled])');
            if (!control) return;
            deviceTargetShown.current = true;
            el.scrollIntoView?.({ block: 'start' });
            control.focus({ preventScroll: true });
        });
    }, [isOpen, initialSection, loading, hasError, activeTab, tabRequest, settingsBody]);
    return { loadOutput, setLoadOutput };
}

interface TuningSectionInput {
    isOpen: boolean;
    initialSection: SettingsSection | undefined;
    loading: boolean;
    hasError: boolean;
    activeTab: SettingsTab;
    tabRequest: number;
    isBeginnerMode: boolean;
    glitchCount: number | undefined;
}

/** 畳まれた音質調整。かんたん表示でなくなったとき・途切れがあったとき・入口から指定されたときは開く。 */
export function useTuningSection({ isOpen, initialSection, loading, hasError, activeTab, tabRequest, isBeginnerMode, glitchCount }: TuningSectionInput) {
    const tuningDetails = useRef<HTMLDetailsElement>(null);
    const hostSelect = useRef<HTMLSelectElement>(null);
    const [tuningOpen, setTuningOpen] = useState(() => initialSection === 'audioTuning' || !getBeginnerMode()
        || localStorage.getItem('vst_host_settings_advanced') === 'true');
    // 「アプリの音声」を選べない理由から、畳まれた音質調整を開いて接続方式の選択へ移す（#290）。
    const chooseConnection = () => {
        setTuningOpen(true);
        afterFrame(() => {
            hostSelect.current?.scrollIntoView?.({ block: 'center' });
            hostSelect.current?.focus({ preventScroll: true });
        });
    };
    useEffect(() => {
        if (!isBeginnerMode || (glitchCount ?? 0) > 0 || initialSection === 'audioTuning') setTuningOpen(true);
    }, [isBeginnerMode, glitchCount, initialSection]);
    useEffect(() => {
        if (!isOpen || initialSection !== 'audioTuning' || loading || hasError || activeTab !== 'audio') return;
        setTuningOpen(true);
        return afterFrame(() => {
            tuningDetails.current?.scrollIntoView?.({ block: 'start' });
            tuningDetails.current?.querySelector<HTMLElement>('[data-tuning-control] [tabindex="0"]')?.focus({ preventScroll: true });
        });
    }, [isOpen, initialSection, loading, hasError, activeTab, tabRequest]);
    return { tuningOpen, setTuningOpen, tuningDetails, hostSelect, chooseConnection };
}

interface PageFocusInput {
    isOpen: boolean;
    initialSection: SettingsSection | undefined;
    activeTab: SettingsTab;
    tabRequest: number;
    soundPlace: SoundPlace;
    focusNonce: number;
    settingsBody: BodyRef;
}

/** ページを開いたときの先頭への送りと焦点。ページ内の操作からは焦点を奪わない。 */
export function useSettingsPageFocus({ isOpen, initialSection, activeTab, tabRequest, soundPlace, focusNonce, settingsBody }: PageFocusInput) {
    const pageHeading = useRef<HTMLHeadingElement>(null);
    const [headingNode, setHeadingNode] = useState<HTMLHeadingElement | null>(null);
    // 中央へ差し込むまでは見出しが無い。付いたときだけ焦点を移す。
    const headingRef = useCallback((node: HTMLHeadingElement | null) => {
        pageHeading.current = node;
        setHeadingNode(current => current === node ? current : node);
    }, []);
    useEffect(() => { settingsBody.current?.scrollTo?.({ top: 0 }); }, [activeTab, tabRequest, soundPlace, settingsBody]);
    // 場所の指定が無いときは、開いたページの見出しへ移す。
    // 確認を閉じた直後は、入口のボタンへ焦点が戻るのが見出しより後になるので、そのときだけ取り直す。
    useLayoutEffect(() => {
        if (!isOpen || initialSection) return;
        const focusHeading = () => {
            const heading = pageHeading.current;
            if (!heading) return;
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || active === document.body || heading.contains(active)) {
                if (document.activeElement !== heading) heading.focus({ preventScroll: true });
                return;
            }
            if (settingsBody.current?.contains(active) || active.closest('[data-settings-page]')) return;
            heading.focus({ preventScroll: true });
        };
        focusHeading();
        return afterFrame(focusHeading);
    }, [isOpen, activeTab, tabRequest, initialSection, headingNode, settingsBody]);
    useEffect(() => {
        if (!isOpen || activeTab !== 'sound' || !focusNonce) return;
        return afterFrame(() => {
            // タブ名と同じ見出しはページの外へ出したので、説明の一文は本文の外にある。
            document.getElementById('sound-section-heading')?.focus({ preventScroll: true });
        });
        // 番号が進んだときだけ移す。小区分の変更を依存に入れると、タブに残すべき焦点が見出しへ移る。
    }, [isOpen, activeTab, focusNonce]);
    return headingRef;
}
