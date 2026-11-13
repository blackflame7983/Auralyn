import { Button } from '@/components/ui/button';
import { type ReactNode } from 'react';
import { MdTune, MdMoreHoriz, MdCast, MdFilterAlt, MdGraphicEq, MdExtension, MdChevronRight } from 'react-icons/md';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';
import { BuiltinAmount, BuiltinPresets, BuiltinSwitch, NoiseQuick, NoiseSwitch, ToneGuide, useVoiceQuick } from './VoiceQuickControls';

interface Props {
    onExpandedChange?: (open: boolean) => void;
    stopped?: boolean;
    model: PreparationModel;
    audioReady: boolean;
    isEngineRunning: boolean;
    inputName?: string;
    outputName?: string;
    /** VST の ON/OFF。 */
    vst?: ReactNode;
    /** 各 VST の画面を開く。2段目に置く。 */
    vstEditors?: ReactNode;
    vstUnrestored?: string[];
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    /** 追加から開くときは true。ページの「VSTを追加」へ焦点を移す。 */
    onOpenVst?: (focusAdd: boolean) => void;
    unconfigured?: boolean;
}

// 音調整は開閉しない3枚のカード。2段目は data-home-tier で分け、窓が低いときに隠すのは後の段階。
export function SoundChain({ model, audioReady, isEngineRunning, inputName, outputName, vst, vstEditors,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVst, stopped = false, vstUnrestored = [], unconfigured = false }: Props) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    const controls = audioReady && !music && !stopped;
    const q = useVoiceQuick(isEngineRunning, controls);
    const live = controls && q.stats !== null;
    const setting = (value: boolean | undefined) => value === undefined ? t('flow.unknown') : value ? t('flow.enabled') : t('flow.disabled');
    const validVst = stage && stage.vst.every(v => typeof v.id === 'string' && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state));
    const vstStatus = !stage || !validVst || stage.vst.some(v => v.state === 'unavailable') ? t('flow.unknown')
        : stage.globalBypass ? t('flow.vstBypassed') : stage.vst.length === 0 ? t('flow.noVst')
        : stage.vst.some(v => v.state === 'muted') ? t('flow.vstMixed')
        : setting(stage.vst.some(v => v.state === 'active'));
    const builtinDetails = stage ? t('flow.builtinParts', { voice: setting(stage.builtinVoiceEnabled), reverb: setting(stage.builtinReverbEnabled) }) : undefined;
    const voiceEnabled = stage?.builtinVoiceEnabled === true;
    const reverbEnabled = stage?.builtinReverbEnabled === true;
    const deesserEnabled = Boolean(stage && stats?.builtInDeesser);
    const deesserOnly = deesserEnabled && !voiceEnabled && !reverbEnabled;
    const partial = Boolean(stage && voiceEnabled !== reverbEnabled);
    const tone = (value: boolean | undefined): StatusTone => value === undefined ? 'warn' : value ? 'ok' : 'off';
    const vstTone: StatusTone = vstStatus === t('flow.enabled') ? 'ok' : vstStatus === t('flow.disabled') || vstStatus === t('flow.noVst') ? 'off' : 'warn';
    const builtinTone: StatusTone = deesserOnly || partial ? 'ok' : tone(stage?.builtinVoiceEnabled);
    const checkUnavailable = audioReady && !stopped && (!stage || !validVst || stage.vst.some(item => item.state === 'unavailable') || !music && !live);
    const voiceUnavailable = audioReady && !stopped && !music && !live;
    const emptyVst = !music && Boolean(stage && validVst && stage.vst.length === 0);
    const noiseOn = live ? q.noiseOn : stage?.nr.enabled === true;
    const builtinOn = (live ? q.chainOn || partial : voiceEnabled || partial) || deesserOnly;
    const vstOn = vstTone === 'ok';
    const builtinBreakdown = builtinDetails && <span className={music && partial ? 'text-ui-support text-muted-foreground' : 'sr-only'}>{builtinDetails}</span>;
    const vstEdit = onOpenVst && <Button variant="outline" size="default" type="button" id="home-vst-open" onClick={() => onOpenVst(emptyVst)}
        className="home-action gap-1">
        {t(emptyVst ? 'chain.vstAdd' : 'chain.vstEditPanel')}<MdChevronRight aria-hidden="true" className="h-4 w-4" />
    </Button>;

    const noiseSummary = stopped ? '—' : live
        ? noiseOn ? t(q.noiseMode === 'high' ? 'master.nrHigh' : q.noiseMode === 'smart' ? 'master.nrLearn' : q.noiseMode === 'venue' ? 'master.nrVenue' : 'master.nrLow') : t('flow.disabled')
        : setting(stage?.nr.enabled);
    const builtinSummary = stopped ? '—' : deesserOnly ? t('flow.deesserOnly')
        : stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled ? t('flow.reverbOnly')
        : live ? builtinOn ? t(q.preset === 'singing' ? 'chain.singingShort' : q.preset === 'warm' ? 'settings.AudioSettingsModal.099' : q.preset === 'bright' ? 'settings.AudioSettingsModal.100' : 'settings.AudioSettingsModal.098') : t('flow.disabled')
        : setting(stage?.builtinVoiceEnabled);
    const vstSummary = stopped ? '—' : vstUnrestored.length ? (unrestoredNamesText(t, vstUnrestored) ?? undefined) : vstStatus === t('flow.enabled') ? t('chain.vstCount', { count: stage?.vst.length ?? 0 }) : vstStatus;

    const card = ({ key, on, name, summary, statusTone, action, info, body, tier2 }: {
        key: string; on: boolean; name: string; summary?: string; statusTone: StatusTone;
        action?: ReactNode; info?: ReactNode; body?: ReactNode; tier2?: ReactNode;
    }) => {
        const Icon = key === 'noise' ? MdFilterAlt : key === 'builtin' ? MdGraphicEq : MdExtension;
        const showBody = !unconfigured && !stopped ? body : key === 'vst' && stopped ? vst : null;
        const showAction = !unconfigured && (!stopped || key === 'vst') && action;
        return <li key={key} id={key === 'noise' ? 'home-noise' : key === 'builtin' ? 'home-builtin' : undefined} data-on={unconfigured || stopped ? false : on} className="sound-module-item sound-module-card min-w-0 flex flex-col gap-3">
            {/* 見出しはアイコン・名前・説明だけ。スイッチと追加・編集は状態の行の右端（収まらなければその下）に置く。 */}
            <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-1.5">
                    <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <h3 id={key === 'vst' ? 'vst-tool-toggle' : undefined} tabIndex={key === 'vst' ? -1 : undefined} className="home-card-name min-w-0 whitespace-nowrap">{name}</h3>
                    {!unconfigured && info}
                </div>
                {!unconfigured && <div className="sound-card-status">
                    <StatusDot tone={stopped ? 'off' : statusTone} className="text-ui-support text-muted-foreground">{summary}</StatusDot>
                    {showAction && <div className="sound-card-action">{action}</div>}
                </div>}
            </div>
            {showBody && <div className="flex min-w-0 flex-col gap-2">{showBody}</div>}
            {!unconfigured && !stopped && tier2 && <div data-home-tier="2" className="border-t border-border pt-3">{tier2}</div>}
            {(key === 'vst' ? checkUnavailable : voiceUnavailable && !unconfigured) && !stopped && <p className="text-ui-support text-muted-foreground" role="status">
                <span>{t('home.checkUnavailable')}</span>
                {music && <Button variant="outline" size="default" type="button" onClick={onOpenSoundSettings ?? onOpenSettings} className="home-action ml-2">{t('home.moreSound')}</Button>}
            </p>}
        </li>;
    };

    const noiseInfo = <InfoPopover docName="home.noise-reduction" label={t('info.noise')}>{t('home.noiseScope')}</InfoPopover>;
    const builtinInfo = <InfoPopover docName="home.voice-shaping" label={t('settings.builtinHelp')}><p>{t('settings.AudioSettingsModal.096')}</p>{builtinDetails && <p>{builtinDetails}</p>}</InfoPopover>;
    const rows = [
        ...(music ? [] : [
            card({ key: 'noise', on: noiseOn, name: t('settings.AudioSettingsModal.105'), summary: noiseSummary,
                statusTone: tone(live ? noiseOn : stage?.nr.enabled), info: noiseInfo,
                action: live ? <NoiseSwitch q={q} /> : undefined,
                body: live ? <NoiseQuick q={q} /> : undefined }),
            card({ key: 'builtin', on: builtinOn, name: t('settings.AudioSettingsModal.095'), summary: builtinSummary,
                statusTone: live && !(stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled) ? tone(builtinOn) : builtinTone,
                info: builtinInfo, action: live ? <BuiltinSwitch q={q} /> : undefined,
                body: <>
                    {builtinBreakdown}
                    {live && q.preset !== 'singing' && <ToneGuide amount={q.shownAmount} on={q.chainOn} />}
                    {live && <BuiltinAmount q={q} />}
                    {stats?.builtInDeesser && <span className="text-ui-support text-muted-foreground">{t('flow.deesserLine', { amount: Math.round(stats.builtInDeesser.amount * 100) })}</span>}
                </>,
                tier2: live ? <BuiltinPresets q={q} /> : undefined }),
        ]),
        emptyVst
            ? card({ key: 'vst', on: false, name: t('chain.vstEmptyName'), summary: (vstUnrestored.length ? unrestoredNamesText(t, vstUnrestored) : t('chain.vstEmptySub')) ?? undefined,
                statusTone: vstUnrestored.length ? 'warn' : 'off', action: vstEdit,
                info: <InfoPopover docName="home.vst" label={t('chain.vstEmptyName')}>{t('chain.vstEmptyHint')}</InfoPopover>,
                body: vstUnrestored.length > 0 ? <StatusDot tone="warn" className="text-ui-support">{unrestoredNamesText(t, vstUnrestored) ?? ''}</StatusDot> : undefined })
            : card({ key: 'vst', on: vstOn, name: 'VST', summary: vstSummary, statusTone: vstTone, action: vstEdit,
                body: vst, tier2: vstEditors }),
    ];

    return <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} inert={unconfigured} aria-disabled={unconfigured || undefined}
        className={cn('sound-chain mb-4 rounded-card bg-card px-5 py-4 gaming:bg-card/70 min-[1100px]:px-6', unconfigured && 'text-muted-foreground')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
                <h2 className="home-title">{t(music ? 'wizard.musicSound' : 'shell.sound')}</h2>
                <InfoPopover label={t('flow.info')}>
                    <p>{t('flow.scope')}</p>
                    {stage && <p className="mt-2">{t(stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? 'flow.broadcastPath' : 'flow.monitorPath')}</p>}
                </InfoPopover>
            </div>
            {!unconfigured && !music && <div className="flex flex-wrap gap-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" type="button" aria-label={t('chain.more')} title={t('chain.more')} className="home-action home-action-icon">
                            <MdMoreHoriz aria-hidden="true" className="h-5 w-5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {model.context.usage === 'obs' && <DropdownMenuItem onSelect={onOpenOBSSettings} className="gap-2"><MdCast aria-hidden="true" className="h-4 w-4" />{t('shell.obs')}</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={onOpenSoundSettings ?? onOpenSettings} className="gap-2"><MdTune aria-hidden="true" className="h-4 w-4" />{t('home.moreSound')}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>}
        </div>
        {!audioReady && !stopped ? <p className="text-ui-support text-muted-foreground">{t(inputName && outputName ? 'home.soundAfterStart' : 'home.soundAfterSetup')}</p>
            : music ? (noiseOn || builtinOn) && <div className="flex flex-wrap items-center gap-2 text-ui-support text-warning"><span>{t('flow.voiceStillOn')}</span><Button variant="outline" size="default" type="button" onClick={onOpenSoundSettings ?? onOpenSettings} className="home-action">{t('home.moreSound')}</Button><InfoPopover label={t('chain.voiceTools')}><p>{builtinDetails}</p><p>{t('settings.AudioSettingsModal.105')}: {setting(stage?.nr.enabled)}</p></InfoPopover></div>
            : null}
        <ol aria-label={t('flow.title')} className="sound-tool-list mt-3 grid grid-cols-3 gap-3">
            {rows}
        </ol>
    </section>;
}
