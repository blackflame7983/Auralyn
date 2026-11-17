import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { MdTune, MdMoreHoriz, MdCast, MdFilterAlt, MdGraphicEq, MdExtension, MdChevronRight } from 'react-icons/md';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useHiddenTierFocus } from '@/hooks/useHiddenTierFocus';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';
import { noiseModeLabelKey } from '@/lib/noiseMode';
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
    /** 画面側の VST 一覧の件数。未取得は null。 */
    vstCount?: number | null;
    /** 周囲の音を測る。音づくりの基本を開き、測定の欄へ焦点を移す。状態は読まない。 */
    onMeasureNoise?: () => void;
    unconfigured?: boolean;
}

// 音調整は開閉しない3枚のカード。2段目は data-home-tier で分け、窓の高さで CSS が出す。
export function SoundChain({ model, audioReady, isEngineRunning, inputName, outputName, vst, vstEditors,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVst, onMeasureNoise, stopped = false, vstUnrestored = [], unconfigured = false, vstCount = null }: Props) {
    const t = useMessages();
    useHiddenTierFocus();
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
    // 0個と分かっているときだけ「追加」。個数が分からない、または1個以上のときは「VSTを開く」。
    const vstKnownEmpty = vstCount === 0;
    const noiseOn = live ? q.noiseOn : stage?.nr.enabled === true;
    const builtinOn = (live ? q.chainOn || partial : voiceEnabled || partial) || deesserOnly;
    const vstOn = vstTone === 'ok';
    const builtinBreakdown = builtinDetails && <span className={music && partial ? 'text-ui-support text-muted-foreground' : 'sr-only'}>{builtinDetails}</span>;
    const vstEdit = onOpenVst && <Button variant="outline" size="default" type="button" id="home-vst-open" onClick={() => onOpenVst(vstKnownEmpty)}
        className="home-action gap-1">
        {t(vstKnownEmpty ? 'chain.vstAdd' : 'sound.openVst')}<MdChevronRight aria-hidden="true" className="h-4 w-4" />
    </Button>;

    // 停止中の一文はカードごとではなく、並びの上に1回だけ出す（#602）。
    // 対象はノイズ低減と声を整える。外部VSTの追加と「その他の操作」は停止中も使える（#665）。
    const stoppedHint = t('chain.stoppedHint');
    const noiseSummary = stopped ? undefined : live
        ? noiseOn ? t(noiseModeLabelKey(q.noiseMode)) : t('flow.disabled')
        : setting(stage?.nr.enabled);
    // 種類の id（broadcast など）は保存のまま。画面の名前だけを出す（#656）。
    const presetName = q.preset === 'singing' ? t('chain.singingShort')
        : q.preset === 'warm' ? t('settings.AudioSettingsModal.099')
        : q.preset === 'bright' ? t('settings.AudioSettingsModal.100')
        : t('settings.AudioSettingsModal.098');
    const builtinSummary = stopped ? undefined : deesserOnly ? t('flow.deesserOnly')
        : stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled ? t('flow.reverbOnly')
        : live ? builtinOn ? t('chain.voiceOn', { name: presetName }) : t('flow.disabled')
        : setting(stage?.builtinVoiceEnabled);
    const vstSummary = stopped ? undefined : vstUnrestored.length ? (unrestoredNamesText(t, vstUnrestored) ?? undefined) : vstStatus === t('flow.enabled') ? t('chain.vstCount', { count: stage?.vst.length ?? 0 }) : vstStatus;
    // 音楽鑑賞の見出しはこれまで「VST」。配信は空のときの「外部VST」。用途ごとに1つにし、実行中と停止中で変えない。
    const vstCardName = t(music ? 'chain.vstName' : 'chain.vstEmptyName');

    const card = ({ key, on, name, summary, statusTone, action, info, body, tier2 }: {
        key: string; on: boolean; name: string; summary?: string; statusTone: StatusTone;
        action?: ReactNode; info?: ReactNode; body?: ReactNode; tier2?: ReactNode;
    }) => {
        const Icon = key === 'noise' ? MdFilterAlt : key === 'builtin' ? MdGraphicEq : MdExtension;
        const showBody = !unconfigured && !stopped ? body : null;
        const showAction = !unconfigured && (!stopped || key === 'vst') && action;
        return <li key={key} id={key === 'noise' ? 'home-noise' : key === 'builtin' ? 'home-builtin' : undefined} data-on={unconfigured || stopped ? false : on} className="sound-module-item sound-module-card min-w-0 flex flex-col gap-3">
            {/* 見出しはアイコン・名前・説明だけ。スイッチと追加・編集は状態の行の右端（収まらなければその下）に置く。
                停止中は名前の行だけにし、追加は名前を縮めずに、幅が足りなければ次の行へ送る（#621）。 */}
            <div className="flex min-w-0 flex-col gap-1">
                <div className={cn('flex min-w-0 items-center gap-x-1.5 gap-y-1', stopped && showAction && 'flex-wrap')}>
                    <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <h3 id={key === 'vst' ? 'vst-tool-toggle' : undefined} tabIndex={-1} className={cn('home-card-name whitespace-nowrap outline-hidden focus-visible:ring-2 focus-visible:ring-ring', !(stopped && showAction) && 'min-w-0')}>{name}</h3>
                    {!unconfigured && info}
                    {stopped && showAction && <div className="ml-auto shrink-0">{action}</div>}
                </div>
                {!unconfigured && !stopped && <div className="sound-card-status">
                    <StatusDot tone={statusTone} className="text-ui-support text-muted-foreground">{summary}</StatusDot>
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
                body: live ? <>
                    {!q.noiseOn && <p className="text-ui-support text-muted-foreground">{t('home.appliesWhenOn')}</p>}
                    <NoiseQuick q={q} />
                </> : undefined,
                tier2: onMeasureNoise ? <Button variant="outline" size="default" type="button" onClick={onMeasureNoise} className="home-action">{t('home.measureNoise')}</Button> : undefined }),
            card({ key: 'builtin', on: builtinOn, name: t('settings.AudioSettingsModal.095'), summary: builtinSummary,
                statusTone: live && !(stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled) ? tone(builtinOn) : builtinTone,
                info: builtinInfo, action: live ? <BuiltinSwitch q={q} /> : undefined,
                body: <>
                    {builtinBreakdown}
                    {live && !q.chainOn && <p className="text-ui-support text-muted-foreground">{t('home.appliesWhenOn')}</p>}
                    {live && q.preset !== 'singing' && <ToneGuide amount={q.shownAmount} on={q.chainOn} />}
                    {live && <BuiltinAmount q={q} />}
                    {stats?.builtInDeesser && <span className="text-ui-support text-muted-foreground">{t('flow.deesserLine', { amount: Math.round(stats.builtInDeesser.amount * 100) })}</span>}
                </>,
                tier2: live ? <BuiltinPresets q={q} /> : undefined }),
        ]),
        emptyVst
            ? card({ key: 'vst', on: false, name: vstCardName, summary: (vstUnrestored.length ? unrestoredNamesText(t, vstUnrestored) : t('chain.vstEmptySub')) ?? undefined,
                statusTone: vstUnrestored.length ? 'warn' : 'off', action: vstEdit,
                info: <InfoPopover docName="home.vst" label={vstCardName}>{t('chain.vstEmptyHint')}</InfoPopover>,
                body: vstUnrestored.length > 0 ? <StatusDot tone="warn" className="text-ui-support">{unrestoredNamesText(t, vstUnrestored) ?? ''}</StatusDot> : undefined })
            : card({ key: 'vst', on: vstOn, name: vstCardName, summary: vstSummary, statusTone: vstTone, action: vstEdit,
                body: vst, tier2: vstEditors }),
    ];

    return <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} data-purpose={music ? 'music' : 'voice'} inert={unconfigured} aria-disabled={unconfigured || undefined}
        className={cn('sound-chain mb-4 rounded-card bg-card px-5 py-4 min-[1100px]:px-6', unconfigured && 'text-muted-foreground')}>
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
                        <Button variant="outline" size="default" type="button" aria-label={t('chain.more')} title={t('chain.more')} className="home-action gap-1">
                            <MdMoreHoriz aria-hidden="true" className="h-5 w-5" />
                            {t('chain.moreVisible')}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {model.context.usage === 'obs' && <DropdownMenuItem onSelect={onOpenOBSSettings} className="gap-2"><MdCast aria-hidden="true" className="h-4 w-4" />{t('shell.obs')}</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={onOpenSoundSettings ?? onOpenSettings} className="gap-2"><MdTune aria-hidden="true" className="h-4 w-4" />{t('home.moreSound')}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>}
        </div>
        {/* 音楽鑑賞のカードはVSTだけで、停止中も追加が使える。この一文は出さない（#663）。 */}
        {stopped && !unconfigured && !music && <p className="mt-2 text-ui-support text-muted-foreground">{stoppedHint}</p>}
        {!audioReady && !stopped ? <p className="text-ui-support text-muted-foreground">{t(inputName && outputName ? 'home.soundAfterStart' : 'home.soundAfterSetup')}</p>
            : music ? (noiseOn || builtinOn) && <div className="flex flex-wrap items-center gap-2 text-ui-support text-warning"><span>{t('flow.voiceStillOn')}</span><Button variant="outline" size="default" type="button" onClick={onOpenSoundSettings ?? onOpenSettings} className="home-action">{t('home.moreSound')}</Button><InfoPopover label={t('chain.voiceTools')}><p>{builtinDetails}</p><p>{t('settings.AudioSettingsModal.105')}: {setting(stage?.nr.enabled)}</p></InfoPopover></div>
            : null}
        {/* 停止中は名前の行だけなので、隣のカードの高さへ伸ばさない（#673）。 */}
        <ol aria-label={t('flow.title')} className={cn('sound-tool-list mt-3 grid gap-3', music ? 'grid-cols-1' : 'grid-cols-3', stopped && 'items-start')}>
            {rows}
        </ol>
        {/* 窓が低くて2段目を出さないときだけ。音楽鑑賞の2段目はVSTの画面で、音づくりには無い（#672）。 */}
        {!music && !unconfigured && <p className="home-tier-fallback mt-2">
            <Button type="button" variant="link" className="link-button h-auto whitespace-normal px-0 text-ui-support" onClick={onOpenSoundSettings ?? onOpenSettings}>{t('home.tierFallback')}</Button>
        </p>}
    </section>;
}
