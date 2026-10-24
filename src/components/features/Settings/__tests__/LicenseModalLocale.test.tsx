import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { LicenseModal } from '../LicenseModal';
import notice from '../../../../../NOTICE.md?raw';
import license from '../../../../../LICENSE?raw';
import cargoSource from '@/assets/licenses-cargo.json';

const fixtures = vi.hoisted(() => ({
    npm: Object.freeze({licenses:Object.freeze({MIT:'LEGAL\r\n exact © NPM body\n', Literal:'License text not found.'}),libraries:Object.freeze([
        {id:'@real/Alpha@1.2.3',name:'@real/Alpha',version:'1.2.3',license:'MIT',repository:'https://example.test/source'},
        {id:'missing@2',name:'Missing text',version:'2',license:null},
        {id:'literal@3',name:'Literal body',version:'3',license:'Literal'},
        {id:'unknown@4',name:'Literal SPDX',version:'4',license:'Unknown'},
    ])}),
}));
vi.mock('@/assets/licenses-npm.json', () => ({default:fixtures.npm}));
afterEach(cleanup);

it('法的原文を保ち、同じdialog/検索/タブ/選択をlocale変更で維持する', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const original = JSON.stringify([fixtures.npm,cargoSource]);
    render(<LocaleProvider store={store}><LicenseModal isOpen onClose={vi.fn()}/></LocaleProvider>);
    const dialog=screen.getByRole('dialog', {name:'ライセンス情報 / OSS Attribution'});
    expect(screen.getByText((_, element) => element?.children.length === 0 && element.textContent === `${notice}\n\n${license}`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'NPM (Frontend)'}));
    const search=screen.getByRole('textbox', {name:'ライブラリを検索'});
    fireEvent.change(search,{target:{value:'Alpha'}});
    fireEvent.click(screen.getByRole('button', {name:/@real\/Alpha/}));
    const legal=screen.getByText((_,element)=>element?.children.length===0 && element.textContent==='LEGAL\r\n exact © NPM body\n');
    await act(async () => {});
    act(()=>{store.setLocale('en');});
    expect(screen.getByRole('dialog',{name:'License information / OSS Attribution'})).toBe(dialog);
    expect(screen.getByRole('textbox',{name:'Search libraries'})).toBe(search);
    expect(search).toHaveValue('Alpha');
    expect(screen.getByRole('button',{name:'NPM (Frontend)'})).toHaveAttribute('aria-pressed','true');
    expect(legal).toBeVisible();
    expect(legal.textContent).toBe('LEGAL\r\n exact © NPM body\n');
    expect(screen.getByRole('link',{name:'Repository'})).toHaveAttribute('href','https://example.test/source');
    fireEvent.change(search,{target:{value:'does-not-exist'}});
    expect(screen.getByText('No matching libraries')).toBeVisible();
    expect(legal).toBeVisible();
    expect(JSON.stringify([fixtures.npm,cargoSource])).toBe(original);
});

it('欠落metadataだけを翻訳し、同じ文の実license本文/SPDXは原文のまま表示する', async () => {
    const store=createLocaleStore(()=> 'ja',()=>true);
    render(<LocaleProvider store={store}><LicenseModal isOpen onClose={vi.fn()}/></LocaleProvider>);
    fireEvent.click(screen.getByRole('button',{name:'NPM (Frontend)'}));
    fireEvent.click(screen.getByRole('button',{name:/Missing text/}));
    expect(screen.getByText('ライセンス本文が見つかりません。')).toBeVisible();
    expect(screen.getAllByText('不明')).toHaveLength(2);
    act(()=>{store.setLocale('en');});
    expect(screen.getByText('License text not found.')).toBeVisible();
    act(()=>{store.setLocale('ja');});
    fireEvent.click(screen.getByRole('button',{name:/Literal body/}));
    expect(screen.getByText('License text not found.')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:/Literal SPDX/}));
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    // 既存dynamic JSON経路を実同梱データで通し、法的本文そのものを照合する。
    const data=cargoSource as unknown as {licenses:Record<string,string>;libraries:{name:string;version:string;license:string}[]};
    const first=data.libraries.find(item=>item.name !== 'vst-host-dummy-end' && !!data.licenses[item.license])!;
    // 全同梱libraryのARIA計算を繰り返さず、既存の検索で対象を絞ってから読む。
    fireEvent.change(screen.getByRole('textbox',{name:'ライブラリを検索'}),{target:{value:first.name}});
    fireEvent.click(screen.getByRole('button',{name:'Cargo (Backend)'}));
    const button=await screen.findByRole('button',{name:name=>name.startsWith(first.name+' ') && name.includes(first.version)});
    fireEvent.click(button);
    const legal=screen.getByText((_,element)=>element?.children.length===0 && element.textContent===data.licenses[first.license]);
    expect(legal).toBeVisible();
    expect(screen.queryByText('vst-host-dummy-end')).not.toBeInTheDocument();
    act(()=>{store.setLocale('en');});
    expect(screen.getByRole('button',{name:'Cargo (Backend)'})).toHaveAttribute('aria-pressed','true');
    expect(legal.textContent).toBe(data.licenses[first.license]);
    expect(screen.getByRole('heading',{name:`${first.name}v${first.version}`})).toBeVisible();
});
