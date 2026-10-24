import { StrictMode, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocaleStore, LOCALE_KEY, normalizeLocale } from '../locale';
import { LocaleProvider, useLocale } from '../LocaleProvider';
import { message } from '../messages';

afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.lang = 'ja'; });

it('未設定・不正値は日本語、明示enのみ英語として扱う', () => {
    for (const value of [null, undefined, '', 'EN', 'fr', '{}', 1]) expect(normalizeLocale(value)).toBe('ja');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('ja')).toBe('ja');
});

it('他設定へ触れず明示言語だけ保存し、同じ言語では通知しない', () => {
    localStorage.setItem('vst_host_audio_config', 'original');
    const store = createLocaleStore();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    expect(store.setLocale('en')).toBe(true);
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
    expect(localStorage.getItem('vst_host_audio_config')).toBe('original');
    expect(changed).toHaveBeenCalledTimes(1);
    store.setLocale('en');
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setLocale('ja');
    expect(changed).toHaveBeenCalledTimes(1);
});

it('保存不能でも当回の表示言語を変更し、失敗をcallerへ返す', () => {
    const store = createLocaleStore(() => null, () => false);
    expect(store.setLocale('en')).toBe(false);
    expect(store.getSnapshot()).toBe('en');
});

it('起動時の移行後や別windowの設定をrefreshで反映する', () => {
    let preference: unknown = 'ja';
    const store = createLocaleStore(() => preference, () => true);
    preference = 'en';
    store.refresh();
    expect(store.getSnapshot()).toBe('en');
    preference = 'invalid';
    store.refresh();
    expect(store.getSnapshot()).toBe('ja');
});

it('言語変更で子を再mountせず入力・操作callback・購読を保持する', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const setup = vi.fn(); const dispose = vi.fn();
    function Child() {
        const { locale, setLocale } = useLocale();
        const [draft, setDraft] = useState('');
        useEffect(() => { setup(); return dispose; }, []);
        return <><input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} /><button onClick={() => setLocale('en')}>{message(locale, 'common.settings')}</button></>;
    }
    render(<StrictMode><LocaleProvider store={store}><Child /></LocaleProvider></StrictMode>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep draft' } });
    const before = [setup.mock.calls.length, dispose.mock.calls.length];
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('keep draft');
    expect(document.documentElement.lang).toBe('en');
    expect([setup.mock.calls.length, dispose.mock.calls.length]).toEqual(before);
});

it('storage通知は言語keyとclearだけを扱い、音声設定の通知では再読込しない', () => {
    let preference: unknown = 'ja';
    const store = createLocaleStore(() => preference, () => true);
    render(<LocaleProvider store={store}><span>content</span></LocaleProvider>);
    preference = 'en';
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_audio_config' })));
    expect(store.getSnapshot()).toBe('ja');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_KEY })));
    expect(store.getSnapshot()).toBe('en');
    preference = null;
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(store.getSnapshot()).toBe('ja');
});
