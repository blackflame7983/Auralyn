import { afterEach, expect, it } from 'vitest';
import { readObsEndpoint, obsConnectionFailure, obsConnectionFailureNotice } from '../obsConnectionPreferences';
import { message } from '@/i18n/messages';

afterEach(() => localStorage.clear());
it('非標準の接続先だけを読み、パスワードは返さない', () => {
    localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: 'studio-pc', port: 5544, password: 'secret' }));
    expect(readObsEndpoint()).toEqual({ host: 'studio-pc', port: 5544 });
});
it.each(['{broken', 'null', '{"host":12,"port":70000}'])('壊れた保存値を既定値に戻す: %s', saved => {
    localStorage.setItem('vst_host_obs_config', saved);
    expect(readObsEndpoint()).toEqual({ host: 'localhost', port: 4455 });
});
it.each(['other secret', 'connection refused secret', 'timed out secret'])('失敗時に試行ポートを示し、秘密を転記しない: %s', error => {
    const hint = obsConnectionFailure(error, 5544);
    expect(hint).toContain('5544');
    expect(hint).not.toContain('4455');
    expect(hint).not.toContain('secret');
});
it('認証失敗はパスワードの確認だけを案内する', () => {
    expect(obsConnectionFailure('auth secret', 5544)).toContain('認証に失敗');
    expect(obsConnectionFailure('auth secret', 5544)).not.toContain('secret');
});

it.each([
    ['auth', 'authentication', '認証に失敗しました。OBSのWebSocketパスワードと、この画面のパスワードが一致しているか確認してください。', 'Authentication failed. Check that the OBS WebSocket password matches the password on this screen.'],
    ['timeout', 'timeout', '接続が時間切れになりました。選択したホスト名とポート 5544、通信を許可する設定を確認してください。', 'The connection timed out. Check the selected host, port 5544, and settings that allow communication.'],
    ['connection refused', 'refused', '接続が拒否されました。OBSの起動、WebSocketサーバーの有効化と選択したポート 5544 を確認してください。', 'The connection was refused. Check that OBS is running, its WebSocket server is enabled, and port 5544 is selected.'],
    ['other', 'other', 'OBSの「ツール → WebSocketサーバー設定」でサーバーの有効化と、この画面で選択したホスト名・ポート 5544・パスワードを確認してください。', 'In OBS, open Tools → WebSocket Server Settings. Check that the server is enabled and that the host, port 5544 and password match this screen.'],
])('%s分類はJA互換と英語表示を保ち、raw秘密をmetadataへ返さない', (prefix,code,ja,en) => {
    const error=new Error(prefix+' OBS_SECRET_CANARY password=do-not-copy');
    localStorage.setItem('vst_host_locale','en');
    const value=obsConnectionFailureNotice(error,5544);
    expect(value.code).toBe(code);
    expect(value.args).toEqual(code==='authentication'?undefined:{port:5544});
    expect(obsConnectionFailure(error,5544)).toBe(ja);
    expect(message('ja',value.key,value.args)).toBe(ja);
    expect(message('en',value.key,value.args)).toBe(en);
    expect(JSON.stringify(value)).not.toContain('OBS_SECRET_CANARY');
    expect(JSON.stringify(value)).not.toContain('do-not-copy');
});

it.each([['401 timeout','authentication'],['AUTH connection refused','authentication'],['timed out','timeout'],['failed to connect','refused']])('既存prefix順序を変えず%sを分類する', (error,code)=>{
    expect(obsConnectionFailureNotice(error,1234).code).toBe(code);
});
