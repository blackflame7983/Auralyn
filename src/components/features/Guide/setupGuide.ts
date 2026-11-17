import type { Locale } from '@/i18n/locale';
import { message, type MessageKey } from '@/i18n/messages';
import { homeGuideLabels, type HomeGuidePurpose } from './homeGuide';

/** 使い方の最初の節は、まず何をするかを3つの手順で示す（#719）。 */
const voiceSteps = ['help.setup.voice.1', 'help.setup.voice.2', 'help.setup.voice.3'] as const satisfies readonly MessageKey[];
const musicSteps = ['help.setup.music.1', 'help.setup.music.2', 'help.setup.music.3'] as const satisfies readonly MessageKey[];

export function setupStepsFor(purpose: HomeGuidePurpose) {
    return purpose === 'music' ? musicSteps : voiceSteps;
}

export function setupTroubleKey(purpose: HomeGuidePurpose) {
    return purpose === 'music' ? 'help.setup.music.trouble' : 'help.setup.voice.trouble';
}

export function fillSetupGuide(locale: Locale, purpose: HomeGuidePurpose) {
    const labels = homeGuideLabels(locale);
    return {
        steps: setupStepsFor(purpose).map(key => message(locale, key, labels)),
        trouble: message(locale, setupTroubleKey(purpose), labels),
    };
}
