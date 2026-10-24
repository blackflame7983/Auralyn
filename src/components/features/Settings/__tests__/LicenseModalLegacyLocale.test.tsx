import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { LicenseModal } from '../LicenseModal';

vi.mock('@/assets/licenses-npm.json',()=>({default:{
    '@real/legacy@1.2.3':{licenses:['MIT','Apache-2.0'],licenseText:'Legacy exact\nLicense text not included.'},
    'unprovided@4.5.6':{},
}}));
afterEach(cleanup);

it('旧format/未指定dataでもID・version・本文を保ち、欠落だけ翻訳する',()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);
    render(<LocaleProvider store={store}><LicenseModal isOpen onClose={vi.fn()}/></LocaleProvider>);
    fireEvent.click(screen.getByRole('button',{name:'NPM (Frontend)'}));
    fireEvent.click(screen.getByRole('button',{name:/@real\/legacy/}));
    expect(screen.getByRole('heading',{name:/@real\/legacy.*v1.2.3/})).toBeVisible();
    expect(screen.getByText((_,element)=>element?.children.length===0 && element.textContent==='Legacy exact\nLicense text not included.')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:/unprovided/}));
    expect(screen.getByText('ライセンス本文は同梱されていません。')).toBeVisible();
    act(()=>{store.setLocale('en');});
    expect(screen.getByText('License text not included.')).toBeVisible();
    expect(screen.getByRole('heading',{name:/unprovided.*v4.5.6/})).toBeVisible();
});
