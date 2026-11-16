import type { Locale } from '@/i18n/locale';
import { message, type MessageKey } from '@/i18n/messages';

/** ホームの見方は、開いている用途の文だけを出す（#630）。 */
export type HomeGuidePurpose = 'voice' | 'music';
export const homeGuideGroups = ['stage', 'meters', 'sound', 'check', 'footer'] as const;
export type HomeGuideGroup = typeof homeGuideGroups[number];

const voicePoints = {
    stage: ['help.home.stage.1', 'help.home.stage.3', 'help.home.stage.modes', 'help.home.stage.4', 'help.home.stage.5'],
    meters: ['help.home.meters.1', 'help.home.meters.2', 'help.home.meters.3', 'help.home.meters.4', 'help.home.meters.5'],
    sound: ['help.home.sound.1', 'help.home.sound.2', 'help.home.sound.3', 'help.home.sound.4', 'help.home.sound.5', 'help.home.sound.6', 'help.home.sound.7', 'help.home.sound.8', 'help.home.sound.9'],
    check: ['help.home.check.1', 'help.home.check.2', 'help.home.check.3'],
    footer: ['help.home.footer.1', 'help.home.footer.2'],
} as const satisfies Record<HomeGuideGroup, readonly MessageKey[]>;

const musicPoints = {
    stage: ['help.home.stage.2', 'help.home.stage.3', 'help.home.stage.lockMusic', 'help.home.stage.flowMusic', 'help.home.stage.6', 'help.home.stage.7'],
    meters: ['help.home.meters.music', 'help.home.meters.listen', 'help.home.meters.3', 'help.home.meters.incomingMusic'],
    sound: ['help.home.sound.5', 'help.home.sound.7', 'help.home.sound.8', 'help.home.sound.9'],
    check: ['help.home.check.music', 'help.home.check.2'],
    footer: ['help.home.footer.music', 'help.home.footer.3', 'help.home.compareMusic'],
} as const satisfies Record<HomeGuideGroup, readonly MessageKey[]>;

export function homeGuideFor(purpose: HomeGuidePurpose) {
    return purpose === 'music' ? musicPoints : voicePoints;
}

export function homeGuideLabels(locale: Locale) {
    const t = (key: MessageKey) => message(locale, key);
    return {
        compare: t('header.compare'), gain: t('master.outputGain'), mute: t('header.emergency'),
        noise: t('settings.AudioSettingsModal.105'), voice: t('settings.AudioSettingsModal.095'),
        basic: t('sound.section.basic'), modes: t('sound.section.liveModes'), singingSection: t('sound.section.singing'), peak: t('sound.section.peak'),
        peakDetails: t('peak.details'),
        details: t('prep.steps'), setup: t('header.setupOpen'), music: t('wizard.musicGoal'), connect: t('rail.connect'), check: t('prep.title'), measure: t('home.measureNoise'),
        tierLink: t('home.tierFallback'),
        add: t('chain.vstAdd'), openVst: t('sound.openVst'),
        settings: t('rail.settings'), appearance: t('settings.appearance'), gaming: t('header.gaming'),
        choose: t('home.chooseDestination'), singing: t('liveBar.singing'), talk: t('liveBar.talk'), lock: t('liveBar.protect'), current: t('liveBar.custom'),
        mode: t('home.modeMark'), send: t('home.sendLevel'), listen: t('home.listenLevel'),
        musicPlayback: t('music.playback'), musicPreset: t('music.presetLabel'), musicCompare: t('header.compare'),
        musicSound: t('wizard.musicSound'), flow: t('home.flowMusic'),
        input: t('unsetFlow.mic'), output: t('meter.output'), source: t('music.source'),
        usage: t('purpose.section'), layout: t('purpose.label'),
    };
}

export function fillHomeGuide(locale: Locale, purpose: HomeGuidePurpose) {
    const labels = homeGuideLabels(locale);
    const points = homeGuideFor(purpose);
    return Object.fromEntries(homeGuideGroups.map(group => [group, points[group].map(key => message(locale, key, labels))])) as Record<HomeGuideGroup, string[]>;
}
