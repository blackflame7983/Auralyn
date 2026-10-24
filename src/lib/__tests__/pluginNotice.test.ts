import { expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { message } from '../../i18n/messages';
import { PluginClientError, pluginNotice, renderPluginNotice } from '../pluginNotice';
import { parsePluginSession, restorePluginSession, SessionRackConflict } from '../restorePluginSession';
vi.mock('sonner', () => ({toast: {warning: vi.fn(), error: vi.fn()}}));
it('client Errorの日本語messageを維持してcodeを付加し、notice metadataを翻訳に依存させない', () => {
    let failure: unknown; try {parsePluginSession({});} catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(PluginClientError); expect(failure).toMatchObject({code: 'sessionShape', message: 'VSTセッションの件数または形式が不正です'});
    const n = pluginNotice('pluginNotices.partial', {failed: 1, skipped: 2}, true);
    expect(n).toMatchObject({includesProtectionExplanation: true});
    expect(renderPluginNotice((key,args) => message('en',key,args), n)).toContain('1 VSTs could not be restored and 2 were excluded');
});
it('競合例外の同一instanceを再throwし、取消は失敗や追加復元へ変換しない', async () => {
    const conflict = new SessionRackConflict('raw conflict'); const restore = vi.fn().mockRejectedValue(conflict); const progress = vi.fn();
    await expect(restorePluginSession([{path:'actual', name:'実名'}], progress, null, () => true, restore)).rejects.toBe(conflict);
    let current = true; const remove = vi.spyOn(audioApi,'removePlugin').mockResolvedValue(undefined);
    const late = vi.fn(async () => {current = false; return {id:'owned',name:'実名',prepared:false};});
    expect(await restorePluginSession([{path:'actual',name:'実名'},{path:'later',name:'Later'}], progress, null, () => current, late, (key,args) => message('en',key,args))).toMatchObject({status:'cancelled',failed:0});
    expect(late).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled(); remove.mockRestore();
});
