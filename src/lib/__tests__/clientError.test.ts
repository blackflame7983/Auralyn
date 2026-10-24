import { expect, it } from 'vitest';
import { FixedClientError, clientErrorNotice, renderClientError } from '../clientError';
import { PluginClientError } from '../pluginNotice';
import { message } from '@/i18n/messages';
const cases = [
  [
    "migration.flushTimeout",
    "clientErrors.flushTimeout",
    "VST状態を保存できませんでした。読み込み完了後に再試行してください。",
    "Could not save VST state. Try again after loading finishes."
  ],
  [
    "migration.invalidLocale",
    "clientErrors.invalidLocale",
    "表示言語の設定が不正です",
    "The display language setting is invalid."
  ],
  [
    "gain.settingsChanged",
    "clientErrors.gainSettingsChanged",
    "音声設定が変わりました。現在の音量を確認してください。",
    "Audio settings changed. Check the current gain."
  ],
  [
    "gain.unconfirmed",
    "clientErrors.gainUnconfirmed",
    "音量の反映を確認できません。状態を再取得してください。",
    "Could not confirm the gain change. Refresh the status."
  ],
  [
    "gain.range",
    "clientErrors.gainRange",
    "出力音量は0〜200%で指定してください。",
    "Set output gain between 0 and 200%."
  ],
  [
    "gain.audioUnverified",
    "clientErrors.audioUnverified",
    "音声状態を確認できません。再試行してください。",
    "Could not verify the audio state. Try again."
  ],
  [
    "gain.audioChanged",
    "clientErrors.audioChanged",
    "音声状態が変わりました。現在の音量を確認してください。",
    "Audio state changed. Check the current gain."
  ],
  [
    "preview.closed",
    "clientErrors.previewClosed",
    "試聴画面を再準備してください。",
    "Prepare the preview again."
  ],
  [
    "preview.invalidSnapshot",
    "clientErrors.previewInvalidSnapshot",
    "試聴の状態を確認できません。画面を再準備してください。",
    "Could not verify the preview state. Prepare the preview again."
  ]
] as const;
it.each(cases)('%s はcanonical日本語/identityを保ち表示だけ翻訳する', (code,key,ja,en) => {
    const error=new FixedClientError(code);
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe(ja);
    expect(error.toString()).toBe('Error: '+ja); expect(error.code).toBe(code);
    expect(clientErrorNotice(error)).toEqual({key});
    expect(renderClientError((k,a)=>message('en',k,a),error)).toBe(en);
    expect(error.message).toBe(ja);
    // 同じ自由文はcodeの根拠にしない。
    expect(clientErrorNotice(new Error(ja)).key).toBe('clientErrors.rawDetail');
});
it.each(['sessionShape','sessionItem','saveProtected','saveBusy','saveChanged'] as const)('PluginClientError %s の既存keyを再利用し原本を保つ', code=>{
    const error=new PluginClientError(code); const original=error.message;
    expect(clientErrorNotice(error)).toEqual({key:error.messageKey});
    expect(renderClientError((k,a)=>message('en',k,a),error)).toBe(message('en',error.messageKey));
    expect(error.message).toBe(original); expect(error).toBeInstanceOf(PluginClientError);
});
it.each(['cancel','cancelled','Stream Error','Plugin not found',new Error('SDK detail')])('未知token %s は原文を保持し推測翻訳しない', error=>{
    expect(renderClientError((k,a)=>message('en',k,a),error)).toBe('Original detail (untranslated): '+String(error));
});
