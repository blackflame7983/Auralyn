import type { ObsSetupHistory } from '@/api/obs';
import type { MessageKey } from '@/i18n/messages';

type Translator = (key: MessageKey, args?: Record<string, string | number>) => string;
type Scalar = string | number | boolean;
type Rule = 'string' | 'number' | 'boolean' | readonly string[];
const specifications = {
    "obs.field.inputDevice": {
        "key": "obsTyped.obs.field.inputDevice",
        "args": {}
    },
    "obs.field.muted": {
        "key": "obsTyped.obs.field.muted",
        "args": {}
    },
    "obs.field.monitor": {
        "key": "obsTyped.obs.field.monitor",
        "args": {}
    },
    "obs.field.syncOffset": {
        "key": "obsTyped.obs.field.syncOffset",
        "args": {}
    },
    "obs.field.additionalDelay": {
        "key": "obsTyped.obs.field.additionalDelay",
        "args": {}
    },
    "obs.field.createDisabledSource": {
        "key": "obsTyped.obs.field.createDisabledSource",
        "args": {}
    },
    "obs.field.volume": {
        "key": "obsTyped.obs.field.volume",
        "args": {}
    },
    "obs.field.filterEnabled": {
        "key": "obsTyped.obs.field.filterEnabled",
        "args": {
            "filter": "string"
        }
    },
    "bundle.field.host": {
        "key": "obsTyped.bundle.field.host",
        "args": {}
    },
    "bundle.field.inputDevice": {
        "key": "obsTyped.bundle.field.inputDevice",
        "args": {}
    },
    "bundle.field.outputDevice": {
        "key": "obsTyped.bundle.field.outputDevice",
        "args": {}
    },
    "bundle.field.sampleRate": {
        "key": "obsTyped.bundle.field.sampleRate",
        "args": {}
    },
    "bundle.field.buffer": {
        "key": "obsTyped.bundle.field.buffer",
        "args": {}
    },
    "bundle.field.channels": {
        "key": "obsTyped.bundle.field.channels",
        "args": {}
    },
    "bundle.field.inputGain": {
        "key": "obsTyped.bundle.field.inputGain",
        "args": {}
    },
    "bundle.field.outputGain": {
        "key": "obsTyped.bundle.field.outputGain",
        "args": {}
    },
    "bundle.field.noise": {
        "key": "obsTyped.bundle.field.noise",
        "args": {}
    },
    "bundle.field.builtin": {
        "key": "obsTyped.bundle.field.builtin",
        "args": {}
    },
    "bundle.field.vstOrder": {
        "key": "obsTyped.bundle.field.vstOrder",
        "args": {}
    },
    "bundle.field.vstSettings": {
        "key": "obsTyped.bundle.field.vstSettings",
        "args": {
            "index": "number"
        }
    },
    "bundle.field.vstState": {
        "key": "obsTyped.bundle.field.vstState",
        "args": {
            "index": "number"
        }
    },
    "bundle.field.globalMute": {
        "key": "obsTyped.bundle.field.globalMute",
        "args": {}
    },
    "bundle.field.globalBypass": {
        "key": "obsTyped.bundle.field.globalBypass",
        "args": {}
    },
    "obs.value.device": {
        "key": "obsTyped.obs.value.device",
        "args": {
            "device": "string"
        }
    },
    "obs.value.defaultDevice": {
        "key": "obsTyped.obs.value.defaultDevice",
        "args": {}
    },
    "obs.value.milliseconds": {
        "key": "obsTyped.obs.value.milliseconds",
        "args": {
            "value": "number"
        }
    },
    "obs.value.sourceAbsent": {
        "key": "obsTyped.obs.value.sourceAbsent",
        "args": {}
    },
    "obs.value.disabledSource": {
        "key": "obsTyped.obs.value.disabledSource",
        "args": {
            "scene": "string"
        }
    },
    "obs.value.boolean": {
        "key": "obsTyped.obs.value.boolean",
        "args": {
            "value": "boolean"
        }
    },
    "obs.value.monitor": {
        "key": "obsTyped.obs.value.monitor",
        "args": {
            "mode": [
                "OBS_MONITORING_TYPE_NONE",
                "OBS_MONITORING_TYPE_MONITOR_ONLY",
                "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT"
            ]
        }
    },
    "obs.value.volumeMultiplier": {
        "key": "obsTyped.obs.value.volumeMultiplier",
        "args": {
            "value": "number"
        }
    },
    "bundle.value.raw": {
        "key": "obsTyped.bundle.value.raw",
        "args": {
            "value": "string"
        }
    },
    "bundle.value.defaultDevice": {
        "key": "obsTyped.bundle.value.defaultDevice",
        "args": {}
    },
    "bundle.value.hertz": {
        "key": "obsTyped.bundle.value.hertz",
        "args": {
            "value": "number"
        }
    },
    "bundle.value.frames": {
        "key": "obsTyped.bundle.value.frames",
        "args": {
            "value": "number"
        }
    },
    "bundle.value.zeroBasedChannels": {
        "key": "obsTyped.bundle.value.zeroBasedChannels",
        "args": {
            "channels": "string"
        }
    },
    "bundle.value.percent": {
        "key": "obsTyped.bundle.value.percent",
        "args": {
            "value": "number"
        }
    },
    "bundle.value.boolean": {
        "key": "obsTyped.bundle.value.boolean",
        "args": {
            "value": "boolean"
        }
    },
    "bundle.value.unknown": {
        "key": "obsTyped.bundle.value.unknown",
        "args": {}
    },
    "bundle.value.notChanged": {
        "key": "obsTyped.bundle.value.notChanged",
        "args": {}
    },
    "bundle.value.noVst": {
        "key": "obsTyped.bundle.value.noVst",
        "args": {}
    },
    "bundle.value.vstChain": {
        "key": "obsTyped.bundle.value.vstChain",
        "args": {
            "names": "string"
        }
    },
    "bundle.value.vstSettings": {
        "key": "obsTyped.bundle.value.vstSettings",
        "args": {
            "name": "string",
            "enabled": "boolean",
            "muted": "boolean",
            "gainPercent": "number"
        }
    },
    "bundle.value.vstStateCaptured": {
        "key": "obsTyped.bundle.value.vstStateCaptured",
        "args": {}
    },
    "bundle.value.vstStateChanged": {
        "key": "obsTyped.bundle.value.vstStateChanged",
        "args": {}
    },
    "bundle.value.noiseSummary": {
        "key": "obsTyped.bundle.value.noiseSummary",
        "args": {
            "enabled": "boolean",
            "mode": [
                "low",
                "high",
                "smart",
                "venue"
            ],
            "strength": "number",
            "voiceGuard": "boolean"
        }
    },
    "bundle.value.builtinSummary": {
        "key": "obsTyped.bundle.value.builtinSummary",
        "args": {
            "voiceEnabled": "boolean",
            "preset": [
                "broadcast",
                "warm",
                "bright",
                "singing"
            ],
            "amount": "number",
            "hasSinging": "boolean",
            "hasReverb": "boolean"
        }
    },
    "obs.plan.manualTiming": {
        "key": "obsTyped.obs.plan.manualTiming",
        "args": {}
    },
    "obs.plan.unsupported": {
        "key": "obsTyped.obs.plan.unsupported",
        "args": {}
    },
    "obs.plan.configureCreatedSource": {
        "key": "obsTyped.obs.plan.configureCreatedSource",
        "args": {}
    },
    "obs.plan.selectedExisting": {
        "key": "obsTyped.obs.plan.selectedExisting",
        "args": {}
    },
    "obs.result.notRun": {
        "key": "obsTyped.obs.result.notRun",
        "args": {}
    },
    "obs.result.applied": {
        "key": "obsTyped.obs.result.applied",
        "args": {}
    },
    "obs.result.audioConflict": {
        "key": "obsTyped.obs.result.audioConflict",
        "args": {}
    },
    "obs.result.valueConflict": {
        "key": "obsTyped.obs.result.valueConflict",
        "args": {}
    },
    "obs.result.applyInterrupted": {
        "key": "obsTyped.obs.result.applyInterrupted",
        "args": {}
    },
    "obs.result.applyAudioUnknown": {
        "key": "obsTyped.obs.result.applyAudioUnknown",
        "args": {}
    },
    "obs.result.applyReadbackUnknown": {
        "key": "obsTyped.obs.result.applyReadbackUnknown",
        "args": {}
    },
    "obs.result.applyWriteUnknown": {
        "key": "obsTyped.obs.result.applyWriteUnknown",
        "args": {}
    },
    "obs.result.restoreAudioDeferred": {
        "key": "obsTyped.obs.result.restoreAudioDeferred",
        "args": {}
    },
    "obs.result.restoreCollectionConflict": {
        "key": "obsTyped.obs.result.restoreCollectionConflict",
        "args": {}
    },
    "obs.result.restoreCreationDeferred": {
        "key": "obsTyped.obs.result.restoreCreationDeferred",
        "args": {}
    },
    "obs.result.alreadyOriginal": {
        "key": "obsTyped.obs.result.alreadyOriginal",
        "args": {}
    },
    "obs.result.restoreAudioUnknown": {
        "key": "obsTyped.obs.result.restoreAudioUnknown",
        "args": {}
    },
    "obs.result.restoreReadbackUnknown": {
        "key": "obsTyped.obs.result.restoreReadbackUnknown",
        "args": {}
    },
    "obs.result.restored": {
        "key": "obsTyped.obs.result.restored",
        "args": {}
    },
    "obs.result.restoreWriteFailed": {
        "key": "obsTyped.obs.result.restoreWriteFailed",
        "args": {}
    },
    "obs.result.restoreValueConflict": {
        "key": "obsTyped.obs.result.restoreValueConflict",
        "args": {}
    },
    "obs.result.applyLateUnknown": {
        "key": "obsTyped.obs.result.applyLateUnknown",
        "args": {}
    },
    "obs.result.restoreLateUnknown": {
        "key": "obsTyped.obs.result.restoreLateUnknown",
        "args": {}
    },
    "bundle.apply.initialUnknown": {
        "key": "obsTyped.bundle.apply.initialUnknown",
        "args": {}
    },
    "bundle.apply.partialUnknown": {
        "key": "obsTyped.bundle.apply.partialUnknown",
        "args": {}
    },
    "bundle.apply.incomplete": {
        "key": "obsTyped.bundle.apply.incomplete",
        "args": {}
    },
    "bundle.apply.captureUnknown": {
        "key": "obsTyped.bundle.apply.captureUnknown",
        "args": {}
    },
    "bundle.apply.conditionsChanged": {
        "key": "obsTyped.bundle.apply.conditionsChanged",
        "args": {}
    },
    "bundle.apply.valuesMismatch": {
        "key": "obsTyped.bundle.apply.valuesMismatch",
        "args": {}
    },
    "bundle.apply.confirmed": {
        "key": "obsTyped.bundle.apply.confirmed",
        "args": {}
    },
    "bundle.apply.conditionsChangedAfter": {
        "key": "obsTyped.bundle.apply.conditionsChangedAfter",
        "args": {}
    },
    "bundle.undo.checking": {
        "key": "obsTyped.bundle.undo.checking",
        "args": {}
    },
    "bundle.undo.deferredUnknown": {
        "key": "obsTyped.bundle.undo.deferredUnknown",
        "args": {}
    },
    "bundle.undo.partialUnknown": {
        "key": "obsTyped.bundle.undo.partialUnknown",
        "args": {}
    },
    "bundle.undo.incomplete": {
        "key": "obsTyped.bundle.undo.incomplete",
        "args": {}
    },
    "bundle.undo.valuesUnknown": {
        "key": "obsTyped.bundle.undo.valuesUnknown",
        "args": {}
    },
    "bundle.undo.confirmed": {
        "key": "obsTyped.bundle.undo.confirmed",
        "args": {}
    },
    "bundle.obs.applyUnknown": {
        "key": "obsTyped.bundle.obs.applyUnknown",
        "args": {}
    },
    "bundle.reservation.endUnknown": {
        "key": "obsTyped.bundle.reservation.endUnknown",
        "args": {}
    }
} as const;
export const OBS_UI_CODES = Object.keys(specifications);
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const numeric = (value: number) => String(Number(value.toFixed(3)));
const detailCodes = new Set([
    'obs.plan.unsupported', 'obs.result.audioConflict', 'obs.result.valueConflict',
    'obs.result.applyInterrupted', 'obs.result.applyAudioUnknown', 'obs.result.applyReadbackUnknown',
    'obs.result.applyWriteUnknown', 'obs.result.restoreAudioDeferred', 'obs.result.restoreCollectionConflict',
    'obs.result.restoreCreationDeferred', 'obs.result.restoreAudioUnknown', 'obs.result.restoreReadbackUnknown',
    'obs.result.restoreWriteFailed', 'obs.result.restoreValueConflict', 'obs.result.applyLateUnknown',
    'obs.result.restoreLateUnknown', 'bundle.apply.partialUnknown', 'bundle.apply.incomplete',
    'bundle.apply.captureUnknown', 'bundle.apply.conditionsChanged', 'bundle.apply.valuesMismatch',
    'bundle.apply.conditionsChangedAfter', 'bundle.undo.deferredUnknown', 'bundle.undo.partialUnknown',
    'bundle.undo.incomplete', 'bundle.undo.valuesUnknown', 'bundle.obs.applyUnknown',
    'bundle.reservation.endUnknown',
]);

// 原文は既存の人向け文字列・scalarだけ。settingsやopaque stateのobjectを展開しない。
export function originalObsText(t: Translator, value: unknown): string {
    const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? numeric(value) : typeof value === 'boolean' ? t(value ? 'obsTyped.on' : 'obsTyped.off') : t('obsTyped.unavailable');
    return t('obsTyped.original', { value: text });
}
function valid(value: unknown, rule: Rule) {
    return Array.isArray(rule) ? typeof value === 'string' && rule.includes(value) : rule === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === rule;
}
export function formatObsText(t: Translator, text: unknown, legacy?: unknown): string {
    const fallback = record(text) && typeof text.fallbackJa === 'string' ? text.fallbackJa : legacy;
    if (!record(text) || typeof text.code !== 'string' || !own(specifications, text.code) || !record(text.args) || typeof text.fallbackJa !== 'string') return originalObsText(t, fallback);
    const spec = specifications[text.code as keyof typeof specifications];
    const rules: Record<string, Rule> = { ...spec.args };
    const args = text.args;
    if (text.code === 'bundle.value.builtinSummary') {
        if (args.hasSinging === true) Object.assign(rules, { lowCutHz: 'number', dynamics: 'number', brightnessDb: 'number' });
        if (args.hasReverb === true) Object.assign(rules, { reverbEnabled: 'boolean', mix: 'number', decaySeconds: 'number', damping: 'number' });
    }
    if (Object.keys(args).length !== Object.keys(rules).length || Object.entries(rules).some(([key, rule]) => !own(args, key) || !valid(args[key], rule))) return originalObsText(t, fallback);
    const display: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(args) as [string, Scalar][]) display[key] = typeof value === 'boolean' ? t(value ? 'obsTyped.on' : 'obsTyped.off') : typeof value === 'number' ? numeric(value) : value;
    if (text.code === 'obs.value.monitor') display.mode = t(({ OBS_MONITORING_TYPE_NONE: 'obsTyped.monitor.none', OBS_MONITORING_TYPE_MONITOR_ONLY: 'obsTyped.monitor.only', OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT: 'obsTyped.monitor.output' } as const)[args.mode as 'OBS_MONITORING_TYPE_NONE']);
    if (text.code === 'bundle.value.noiseSummary') display.mode = t(('obsTyped.noise.' + args.mode) as MessageKey);
    if (text.code === 'bundle.value.builtinSummary') {
        display.preset = t(('obsTyped.preset.' + args.preset) as MessageKey);
        display.singingDetails = args.hasSinging ? t('obsTyped.singingDetails', display) : '';
        display.reverbDetails = args.hasReverb ? t('obsTyped.reverbDetails', display) : '';
    }
    const rendered = t(spec.key, display);
    // 既知codeの要約とは別に、個別の失敗理由は推測翻訳せず原文として残す。
    return detailCodes.has(text.code) ? rendered + ' — ' + originalObsText(t, fallback) : rendered;
}
export function obsHistoryResults(t: Translator, history: ObsSetupHistory): string[] {
    const entries = history.resultEntries;
    return history.results.map((legacy, index) => {
        const entry = Array.isArray(entries) && entries.length === history.results.length ? entries[index] : null;
        return formatObsText(t, entry && outcomes.includes(entry.outcome) ? entry.text : null, legacy);
    });
}
const outcomes = ['notRun', 'applied', 'conflict', 'applyUnknown', 'restoreDeferred', 'restoreUnknown', 'restored', 'alreadyOriginal', 'restoreFailed'];
export function canAdoptObsHistory(history: ObsSetupHistory): boolean {
    const entries = history.resultEntries;
    return history.restorable === true && Array.isArray(history.changes) && history.changes.length > 0 && Array.isArray(history.results) && history.results.length === history.changes.length && Array.isArray(entries) && entries.length === history.changes.length && Array.from(entries).every(entry => record(entry) && typeof entry.outcome === 'string' && outcomes.includes(entry.outcome) && entry.outcome === 'applied');
}
