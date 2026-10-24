import { expect, it } from 'vitest';
import { message } from '@/i18n/messages';
import type { ObsSetupHistory, ObsUiText } from '@/api/obs';
import { OBS_UI_CODES, canAdoptObsHistory, formatObsText, obsHistoryResults } from '../obsUiText';
const fixtures: ObsUiText[] = [
  {
    "code": "obs.field.inputDevice",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.muted",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.monitor",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.syncOffset",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.additionalDelay",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.createDisabledSource",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.volume",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.field.filterEnabled",
    "args": {
      "filter": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.host",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.inputDevice",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.outputDevice",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.sampleRate",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.buffer",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.channels",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.inputGain",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.outputGain",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.noise",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.builtin",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.vstOrder",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.vstSettings",
    "args": {
      "index": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.vstState",
    "args": {
      "index": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.globalMute",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.field.globalBypass",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.device",
    "args": {
      "device": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.defaultDevice",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.milliseconds",
    "args": {
      "value": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.sourceAbsent",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.disabledSource",
    "args": {
      "scene": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.boolean",
    "args": {
      "value": false
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.monitor",
    "args": {
      "mode": "OBS_MONITORING_TYPE_NONE"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.value.volumeMultiplier",
    "args": {
      "value": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.raw",
    "args": {
      "value": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.defaultDevice",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.hertz",
    "args": {
      "value": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.frames",
    "args": {
      "value": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.zeroBasedChannels",
    "args": {
      "channels": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.percent",
    "args": {
      "value": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.boolean",
    "args": {
      "value": false
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.unknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.notChanged",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.noVst",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.vstChain",
    "args": {
      "names": "Exact source / Filter"
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.vstSettings",
    "args": {
      "name": "Exact source / Filter",
      "enabled": false,
      "muted": false,
      "gainPercent": 12.000197729971276
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.vstStateCaptured",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.vstStateChanged",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.noiseSummary",
    "args": {
      "enabled": false,
      "mode": "low",
      "strength": 12.000197729971276,
      "voiceGuard": false
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.value.builtinSummary",
    "args": {
      "voiceEnabled": false,
      "preset": "broadcast",
      "amount": 12.000197729971276,
      "hasSinging": false,
      "hasReverb": false
    },
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.plan.manualTiming",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.plan.unsupported",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.plan.configureCreatedSource",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.plan.selectedExisting",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.notRun",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applied",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.audioConflict",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.valueConflict",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applyInterrupted",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applyAudioUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applyReadbackUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applyWriteUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreAudioDeferred",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreCollectionConflict",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreCreationDeferred",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.alreadyOriginal",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreAudioUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreReadbackUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restored",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreWriteFailed",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreValueConflict",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.applyLateUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "obs.result.restoreLateUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.initialUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.partialUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.incomplete",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.captureUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.conditionsChanged",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.valuesMismatch",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.confirmed",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.apply.conditionsChangedAfter",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.checking",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.deferredUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.partialUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.incomplete",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.valuesUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.undo.confirmed",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.obs.applyUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  },
  {
    "code": "bundle.reservation.endUnknown",
    "args": {},
    "fallbackJa": "ORIGINAL_SENTINEL"
  }
];
const t = (locale: 'ja'|'en') => (key: Parameters<typeof message>[1], args?: Record<string,string|number>) => message(locale,key,args);
it('86個の固定codeがbackend由来scalar fixtureと一対一で対応する', () => {
    expect(fixtures).toHaveLength(86); expect(new Set(fixtures.map(f=>f.code))).toEqual(new Set(OBS_UI_CODES));
});
it.each(fixtures)('$code を日英で型検証して表示し、原本を変更しない', fixture => {
    const before = JSON.stringify(fixture);
    for(const locale of ['ja','en'] as const) {
        const rendered = formatObsText(t(locale),fixture);
        expect(rendered).not.toMatch(/\{\w+\}/);
        expect(rendered).not.toMatch(/^(Original detail|原文の詳細)/);
        expect(rendered).not.toMatch(/12\.000197/);
    }
    expect(JSON.stringify(fixture)).toBe(before);
});
it.each([
    null, undefined, {code:'future',args:{},fallbackJa:'旧原文'},
    {code:'obs.value.boolean',args:{value:'true'},fallbackJa:'旧原文'},
    {code:'obs.value.boolean',args:{},fallbackJa:'旧原文'},
    {code:'obs.value.boolean',args:{value:false,extra:true},fallbackJa:'旧原文'},
    {code:'obs.value.monitor',args:{mode:'future'},fallbackJa:'旧原文'},
    ...[NaN,Infinity,-Infinity,null,{},[]].map(value=>({code:'obs.value.milliseconds',args:{value},fallbackJa:'旧原文'})),
    {code:'obs.result.applied',args:null,fallbackJa:'旧原文'},
    {code:'obs.result.applied',args:{},fallbackJa:42},
])('unknown/legacy/malformed %j は翻訳で成功へ推測しない', value => {
    expect(formatObsText(t('en'),value,'LEGACY')).toMatch(/^Original detail \(untranslated\): /);
    expect(formatObsText(t('en'),value,'LEGACY')).not.toContain('[object Object]');
});
it('boolean/enum/単位を明示し、実名とratioを別の意味へ変えない', () => {
    expect(formatObsText(t('en'),{code:'obs.value.boolean',args:{value:false},fallbackJa:''})).toBe('OFF');
    expect(formatObsText(t('en'),{code:'obs.value.monitor',args:{mode:'OBS_MONITORING_TYPE_MONITOR_ONLY'},fallbackJa:''})).toBe('Monitor only');
    expect(formatObsText(t('en'),{code:'obs.value.volumeMultiplier',args:{value:0.35},fallbackJa:''})).toBe('0.35×');
    expect(formatObsText(t('en'),{code:'bundle.value.raw',args:{value:' Auralyn マイク '},fallbackJa:''})).toBe(' Auralyn マイク ');
    const full = {code:'bundle.value.builtinSummary',args:{voiceEnabled:false,preset:'singing',amount:.35,hasSinging:true,hasReverb:true,lowCutHz:80,dynamics:.349999994,brightnessDb:0,reverbEnabled:true,mix:.08,decaySeconds:1.2,damping:.5},fallbackJa:'OLD'};
    expect(formatObsText(t('en'),full)).toContain('dynamics 0.35');
    expect(formatObsText(t('en'),full)).toContain('reverb ON, mix 0.08');
    expect(formatObsText(t('en'),{...full,args:{...full.args,hasSinging:false}})).toContain('Original detail');
});
const history: ObsSetupHistory = {id:1,restorable:true,changes:[{source:'voice',label:'sync',before:0,after:10}],results:['自由文'],resultEntries:[{outcome:'applied',text:{code:'obs.result.applied',args:{},fallbackJa:'任意原文'}}]};
it('採用は表示文言でなくrestorable/非空/全件outcomeと件数を照合する', () => {
    expect(canAdoptObsHistory(history)).toBe(true);
    expect(canAdoptObsHistory({...history,resultEntries:[{outcome:'applied',text:{code:'future',args:{},fallbackJa:'未知表示'}}]})).toBe(true);
    for(const bad of [{restorable:undefined},{restorable:false},{restorable:null},{changes:[]},{results:[]},{resultEntries:undefined},{resultEntries:null},{resultEntries:[]},{resultEntries:[null]},{resultEntries:[{outcome:'future'}]},...['notRun','conflict','applyUnknown','restoreDeferred','restoreUnknown','restored','alreadyOriginal','restoreFailed'].map(outcome=>({resultEntries:[{outcome,text:history.resultEntries![0].text}]}))]) expect(canAdoptObsHistory({...history,...bad} as ObsSetupHistory)).toBe(false);
    expect(obsHistoryResults(t('en'),{...history,results:['適用済み'],resultEntries:null})).toEqual(['Original detail (untranslated): 適用済み']);
});
