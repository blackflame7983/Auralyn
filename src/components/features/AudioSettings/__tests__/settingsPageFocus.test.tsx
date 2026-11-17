import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SoundPlace } from '@/hooks/useUIState';
import type { SettingsTab } from '../useSettingsNavigation';
import { useDeviceTargetFocus, useSettingsPageFocus, useSettingsScroller, useTuningSection } from '../useSettingsPageFocus';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const cancelled: number[] = [];

beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    cancelled.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); frames.delete(id); });
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    localStorage.clear();
});

const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() => { pending.forEach(callback => callback(0)); });
};

function page(html: string) {
    const body = document.createElement('div');
    body.innerHTML = html;
    document.body.append(body);
    return { current: body };
}

const deviceInput = {
    isOpen: true, initialSection: 'liveOutput' as 'liveOutput' | 'primaryInput' | undefined, loading: false, hasError: false, activeTab: 'audio' as SettingsTab, tabRequest: 0,
};

it('出力先の指定で来たときは、描画のあとに区画を開いて読込を始め、読み終えたら出力先の選択へ焦点を移す', () => {
    const settingsBody = page('<details id="live-output-settings"><summary>出力</summary><select id="out"></select></details>');
    const { result } = renderHook(() => useDeviceTargetFocus({ ...deviceInput, settingsBody }));
    expect(result.current.loadOutput).toBe(false);
    expect(frames.size).toBe(1);
    flushFrames();
    const details = settingsBody.current.querySelector('details');
    expect(details?.open).toBe(true);
    expect(result.current.loadOutput).toBe(true);
    expect(document.activeElement).toBe(settingsBody.current.querySelector('select'));
});

it('出力先へ移す描画の待ちは、条件が外れたら取り消し、同じ依頼では1回だけ動かす', () => {
    const settingsBody = page('<div id="primary-input-settings" tabindex="-1"><select></select></div>');
    const { rerender } = renderHook(({ hasError }) => useDeviceTargetFocus({ ...deviceInput, initialSection: 'primaryInput', hasError, settingsBody }), { initialProps: { hasError: false } });
    expect(frames.size).toBe(1);
    const [first] = [...frames.keys()];
    rerender({ hasError: true });
    expect(cancelled).toContain(first);
    expect(frames.size).toBe(0);
    rerender({ hasError: false });
    expect(frames.size).toBe(1);
    flushFrames();
    expect(document.activeElement).toBe(settingsBody.current.querySelector('select'));
    rerender({ hasError: false });
    expect(frames.size).toBe(0);
});

it('入口が無いとき・別の区分のときは出力先へ移す待ちを作らない', () => {
    const settingsBody = page('<details id="live-output-settings"><summary>出力</summary></details>');
    renderHook(() => useDeviceTargetFocus({ ...deviceInput, initialSection: undefined, settingsBody }));
    renderHook(() => useDeviceTargetFocus({ ...deviceInput, activeTab: 'sound', settingsBody }));
    renderHook(() => useDeviceTargetFocus({ ...deviceInput, isOpen: false, settingsBody }));
    expect(frames.size).toBe(0);
});

const tuningInput = { isOpen: true, initialSection: undefined as 'audioTuning' | undefined, loading: false, hasError: false, activeTab: 'audio' as SettingsTab, tabRequest: 0, isBeginnerMode: true, glitchCount: 0 as number | undefined };

it('音質調整は、かんたん表示で途切れも指定も無ければ畳んだままで始める', () => {
    const { result } = renderHook(() => useTuningSection(tuningInput));
    expect(result.current.tuningOpen).toBe(false);
});

it.each([
    ['入口の指定', () => ({ ...tuningInput, initialSection: 'audioTuning' as const })],
    ['かんたん表示でない', () => ({ ...tuningInput, isBeginnerMode: false })],
    ['途切れの記録がある', () => ({ ...tuningInput, glitchCount: 2 })],
])('音質調整は、%sときに開く', (_name, makeInput) => {
    const { result } = renderHook(() => useTuningSection(makeInput()));
    expect(result.current.tuningOpen).toBe(true);
});

it('音質調整は、詳しい調整の保存か、かんたん表示でない保存があれば開いて始まり、途切れが後から出ても開く', () => {
    localStorage.setItem('vst_host_settings_advanced', 'true');
    expect(renderHook(() => useTuningSection(tuningInput)).result.current.tuningOpen).toBe(true);
    localStorage.clear();
    localStorage.setItem('vst_host_beginner_mode', 'false');
    expect(renderHook(() => useTuningSection(tuningInput)).result.current.tuningOpen).toBe(true);
    localStorage.clear();
    const { result, rerender } = renderHook(({ glitchCount }) => useTuningSection({ ...tuningInput, glitchCount }), { initialProps: { glitchCount: undefined as number | undefined } });
    expect(result.current.tuningOpen).toBe(false);
    rerender({ glitchCount: 1 });
    expect(result.current.tuningOpen).toBe(true);
});

it('接続方式を選べない理由からの案内は、音質調整を開き、描画のあとに接続方式の選択へ焦点を移す', () => {
    const { result } = renderHook(() => useTuningSection(tuningInput));
    const select = document.createElement('select');
    document.body.append(select);
    act(() => { result.current.hostSelect.current = select; });
    act(() => result.current.chooseConnection());
    expect(result.current.tuningOpen).toBe(true);
    expect(document.activeElement).not.toBe(select);
    flushFrames();
    expect(document.activeElement).toBe(select);
});

it('音質調整の指定で来たときは、描画のあとに操作できる所へ焦点を移し、閉じる・外れるときは待ちを取り消す', () => {
    const details = document.createElement('details');
    details.innerHTML = '<div data-tuning-control><span tabindex="0">調整</span></div>';
    document.body.append(details);
    const { result, rerender, unmount } = renderHook(({ loading }) => useTuningSection({ ...tuningInput, initialSection: 'audioTuning', loading }), { initialProps: { loading: true } });
    act(() => { result.current.tuningDetails.current = details; });
    expect(frames.size).toBe(0);
    rerender({ loading: false });
    expect(frames.size).toBe(1);
    flushFrames();
    expect(document.activeElement).toBe(details.querySelector('span'));
    rerender({ loading: true });
    rerender({ loading: false });
    const [pending] = [...frames.keys()];
    unmount();
    expect(cancelled).toContain(pending);
    expect(frames.size).toBe(0);
});

const focusInput = { isOpen: true, initialSection: undefined as 'liveOutput' | undefined, activeTab: 'audio' as SettingsTab, tabRequest: 0, soundPlace: 'basic' as SoundPlace, focusNonce: 0 };

function withHeading(options: Partial<typeof focusInput> = {}) {
    const hook = renderHook(props => {
        const scroller = useSettingsScroller();
        const headingRef = useSettingsPageFocus({ ...props, settingsBody: scroller.settingsBody });
        return { ...scroller, headingRef };
    }, { initialProps: { ...focusInput, ...options } });
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.append(heading);
    return { ...hook, heading };
}

it('場所の指定が無いときは、見出しが付いた時点で焦点を見出しへ移す', () => {
    const { result, heading } = withHeading();
    act(() => result.current.headingRef(heading));
    expect(document.activeElement).toBe(heading);
});

it('場所の指定があるときは、見出しへ焦点を移さない', () => {
    const { result, heading } = withHeading({ initialSection: 'liveOutput' });
    act(() => result.current.headingRef(heading));
    flushFrames();
    expect(document.activeElement).not.toBe(heading);
});

it('ページ内の操作に焦点があるときは見出しへ戻さず、ページの外に焦点があるときだけ戻す', () => {
    const { result, rerender, heading } = withHeading();
    const body = document.createElement('div');
    const button = document.createElement('button');
    body.append(button);
    document.body.append(body);
    act(() => result.current.bindScroller(body));
    act(() => result.current.headingRef(heading));
    act(() => button.focus());
    rerender({ ...focusInput, tabRequest: 1 });
    flushFrames();
    expect(document.activeElement).toBe(button);
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    rerender({ ...focusInput, tabRequest: 2 });
    expect(document.activeElement).toBe(heading);
});
it('見出しへ焦点を取り直す待ちは、ページを閉じたら取り消す', () => {
    const { result, heading, unmount } = withHeading();
    act(() => result.current.headingRef(heading));
    const pending = [...frames.keys()];
    expect(pending.length).toBeGreaterThan(0);
    unmount();
    pending.forEach(id => expect(cancelled).toContain(id));
});

it('本文は、区分・依頼・小区分が変わるたびに先頭へ戻す', () => {
    const scrollTo = vi.fn();
    const { result, rerender } = withHeading();
    const body = document.createElement('div');
    Object.assign(body, { scrollTo });
    act(() => result.current.bindScroller(body));
    scrollTo.mockClear();
    rerender({ ...focusInput, activeTab: 'sound' });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    scrollTo.mockClear();
    rerender({ ...focusInput, activeTab: 'sound', tabRequest: 1 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    rerender({ ...focusInput, activeTab: 'sound', tabRequest: 1 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
});

it('音づくりの見出しへの焦点は、番号が進んだときだけ移し、小区分の変更では移さない', () => {
    const heading = document.createElement('p');
    heading.id = 'sound-section-heading';
    heading.tabIndex = -1;
    document.body.append(heading);
    const { rerender } = renderHook(props => {
        const scroller = useSettingsScroller();
        useSettingsPageFocus({ ...props, settingsBody: scroller.settingsBody });
    }, { initialProps: { ...focusInput, activeTab: 'sound' as SettingsTab, initialSection: 'liveOutput' as 'liveOutput' | undefined } });
    flushFrames();
    expect(document.activeElement).not.toBe(heading);
    rerender({ ...focusInput, activeTab: 'sound', initialSection: 'liveOutput', soundPlace: 'singing' });
    expect(frames.size).toBe(0);
    rerender({ ...focusInput, activeTab: 'sound', initialSection: 'liveOutput', focusNonce: 1 });
    expect(frames.size).toBe(1);
    flushFrames();
    expect(document.activeElement).toBe(heading);
});

it('音づくりの見出しへの待ちは、区分が変わったら取り消す', () => {
    const { rerender } = renderHook(props => {
        const scroller = useSettingsScroller();
        useSettingsPageFocus({ ...props, settingsBody: scroller.settingsBody });
    }, { initialProps: { ...focusInput, activeTab: 'sound' as SettingsTab, initialSection: 'liveOutput' as 'liveOutput' | undefined, focusNonce: 1 } });
    const [pending] = [...frames.keys()];
    rerender({ ...focusInput, activeTab: 'audio', initialSection: 'liveOutput', focusNonce: 1 });
    expect(cancelled).toContain(pending);
});
