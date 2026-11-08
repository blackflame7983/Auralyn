import { Button } from '@/components/ui/button';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MdChevronRight, MdHearing, MdTune, MdMoreHoriz, MdCast, MdFilterAlt, MdGraphicEq, MdExtension } from 'react-icons/md';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { MusicListeningCheck } from './MusicListeningCheck';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';
import { BuiltinQuick, BuiltinSwitch, NoiseQuick, NoiseSwitch, useVoiceQuick } from './VoiceQuickControls';

interface Props {
    onExpandedChange?: (open: boolean) => void;
    stopped?: boolean;
    model: PreparationModel;
    audioReady: boolean;
    isEngineRunning: boolean;
    inputName?: string;
    outputName?: string;
    /** VST 段の中身（App が VST 構成から作る）。 */
    vst?: ReactNode;
    /** 保存済み構成から読み込めていないVST。空の段を「未追加」と見せない。 */
    vstUnrestored?: string[];
    listenOpen: boolean;
    onListen: () => void;
    onListenClose: () => void;
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    onOpenVst?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    /** 右パネルを開いているか。開閉ボタンの aria-expanded に使う。 */
    vstPanelOpen?: boolean;
    /** 音声が未設定。段の名前だけを淡く出し、状態・操作・「読み取れません」を出さない（#297）。 */
    unconfigured?: boolean;
}

// 音の流れと声の調整を1本のチェーンにまとめる。各段で状態を見て、その場で操作できる。
// 設定状態と音の到達確認は異なる。値を取得できないときは OFF と推測しない。
export function SoundChain({ model, audioReady, isEngineRunning, inputName, outputName, vst, listenOpen, onListen, onListenClose,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVst, stopped = false, vstPanelOpen = false, vstUnrestored = [], unconfigured = false, onExpandedChange }: Props) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const [expanded, setExpanded] = useState<string | null>(music && vstPanelOpen ? 'vst' : null);
    const panelId = useId();
    const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
    useEffect(() => { onExpandedChange?.(expanded !== null); }, [expanded, onExpandedChange]);
    const listenButton = useRef<HTMLButtonElement>(null);
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    // 音楽鑑賞では声向けの処理を操作させず、VST 構成で音を整える。
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
    // 声の active はそのまま。段の ON は残響と歯擦音も含む。歯擦音だけのときは要約を分ける。
    const deesserEnabled = Boolean(stage && stats?.builtInDeesser);
    const deesserOnly = deesserEnabled && !voiceEnabled && !reverbEnabled;
    const partial = Boolean(stage && voiceEnabled !== reverbEnabled);
    // 状態は色の点と文言で示す。未確認は注意、OFF は中立で、問題とは区別する（DESIGN.md 5.1）。
    const tone = (value: boolean | undefined): StatusTone => value === undefined ? 'warn' : value ? 'ok' : 'off';
    const vstTone: StatusTone = vstStatus === t('flow.enabled') ? 'ok' : vstStatus === t('flow.disabled') || vstStatus === t('flow.noVst') ? 'off' : 'warn';
    const builtinTone: StatusTone = deesserOnly || partial ? 'ok' : tone(stage?.builtinVoiceEnabled);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;

    const checkUnavailable = audioReady && !stopped && (!stage || !validVst || stage.vst.some(item => item.state === 'unavailable') || !music && !live);
    // 声の処理（ノイズ低減・声を整える）の値が取れないときは、その項目を開いたときにも理由を示す。
    const voiceUnavailable = audioReady && !stopped && !music && !live;
    const emptyVst = !music && Boolean(stage && validVst && stage.vst.length === 0);
    // 項目列の下に既存操作を1つだけ開く。閉じた操作は高さの補間中もフォーカスさせない。
    const row = ({ key, id, on, tag, builtin, name, sub, title, body, action, quiet }: {
        key: string; id?: string; on: boolean; tag: string; builtin?: boolean; name: string; sub?: ReactNode; title?: string;
        body?: ReactNode; action?: ReactNode; quiet?: boolean;
    }) => {
        // 未設定では状態を推測で並べない。段の並びだけで、設定後に何ができるかを伝える。
        if (unconfigured) { body = null; action = null; on = false; if (typeof sub !== 'string') sub = undefined; }
        if (stopped) { on = false; body = key === 'vst' ? vst : null; sub = undefined; }
        const Icon = builtin ? key === 'noise' ? MdFilterAlt : MdGraphicEq : MdExtension;
        const open = expanded === key;
        const summary = stopped ? t('shell.stopped') : key === 'noise'
            ? live ? noiseOn ? t(q.noiseMode === 'high' ? 'master.nrHigh' : q.noiseMode === 'smart' ? 'master.nrLearn' : q.noiseMode === 'venue' ? 'master.nrVenue' : 'master.nrLow') : t('flow.disabled') : setting(stage?.nr.enabled)
            : key === 'builtin' ? deesserOnly ? t('flow.deesserOnly')
                : stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled ? t('flow.reverbOnly')
                : live ? builtinOn ? t(q.preset === 'singing' ? 'chain.singingShort' : q.preset === 'warm' ? 'settings.AudioSettingsModal.099' : q.preset === 'bright' ? 'settings.AudioSettingsModal.100' : 'settings.AudioSettingsModal.098') : t('flow.disabled') : setting(stage?.builtinVoiceEnabled)
            : vstUnrestored.length ? unrestoredNamesText(t, vstUnrestored) : vstStatus === t('flow.enabled') ? t('chain.vstCount', { count: stage?.vst.length ?? 0 }) : vstStatus;
        return <li key={key} className="contents">
            <div data-on={on} className="min-w-0">
                <Button variant="ghost" size="default" type="button" id={key === 'vst' ? 'vst-tool-toggle' : undefined} ref={node => { triggers.current[key] = node; }}
                    aria-label={unconfigured ? name : `${name} ${summary}`} aria-expanded={open} aria-controls={`${panelId}-${key}`} onClick={() => setExpanded(open ? null : key)} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); setExpanded(null); } }}
                    className={cn('h-auto w-full justify-start gap-2 whitespace-normal text-left', open && 'bg-muted')}>
                    <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-words">
                        <span className="sr-only">{tag}</span>
                        <span className="block text-ui-control font-semibold">{name}</span>
                        {/* 点の色は、隣の文字と同じ情報源から決める。本番の値が分かっているときは観測の未確認で注意色にしない。 */}
                        {!unconfigured && <StatusDot tone={stopped ? 'off' : key === 'noise' ? tone(live ? noiseOn : stage?.nr.enabled) : key === 'builtin' ? (live && !(stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled) ? tone(builtinOn) : builtinTone) : vstTone} className="text-ui-support text-muted-foreground">{summary}</StatusDot>}
                    </span>
                </Button>
            </div>
            <div id={`${panelId}-${key}`} className="disclosure-panel col-span-full order-last" data-open={open} aria-hidden={!open} inert={!open}
                onKeyDown={event => {
                    if (event.key === 'Escape' && !event.defaultPrevented) {
                        event.preventDefault(); event.stopPropagation(); setExpanded(null); triggers.current[key]?.focus();
                    }
                }}>
                <div className="min-h-0 overflow-hidden">
                    <div id={id} tabIndex={id ? -1 : undefined} data-on={on} className="disclosure-content flex flex-wrap items-center gap-3 border-t border-border py-3" title={title}>
                        <div className="inline-flex items-center gap-1">
                            <h3 className="text-ui-control font-semibold">{name}</h3>
                            {key === 'noise' && <InfoPopover docName="home.noise-reduction" label={t('info.noise')}>{t('home.noiseScope')}</InfoPopover>}
                            {key === 'builtin' && <InfoPopover docName="home.voice-shaping" label={t('settings.builtinHelp')}><p>{t('settings.AudioSettingsModal.096')}</p>{builtinDetails && <p>{builtinDetails}</p>}</InfoPopover>}
                            {key === 'vst' && quiet && <InfoPopover docName="home.vst" label={t('chain.vstEmptyName')}>{t('chain.vstEmptyHint')}</InfoPopover>}
                        </div>
                        {sub && <div className="sr-only">{sub}</div>}
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">{body}</div>
                        {action}
                        {(key === 'vst' ? checkUnavailable : voiceUnavailable && !unconfigured) && <div className="basis-full text-ui-support text-muted-foreground" role="status">
                            <span>{t('home.checkUnavailable')}</span>
                            {music && <Button variant="outline" size="default" type="button" onClick={onOpenSoundSettings ?? onOpenSettings} className="ml-2">{t('home.moreSound')}</Button>}
                        </div>}
                    </div>
                </div>
            </div>
        </li>;
    };
    const builtinTag = t('chain.tagBuiltin');
    const noiseOn = live ? q.noiseOn : stage?.nr.enabled === true;
    const builtinOn = (live ? q.chainOn || partial : voiceEnabled || partial) || deesserOnly;
    const vstOn = vstTone === 'ok';
    // 声の処理と残響は別の設定。声ON・残響OFFを異常に見せず、逆の場合だけ「残響のみ」を伝える。
    const builtinBreakdown = builtinDetails && <span className={music && partial ? 'text-ui-support text-muted-foreground' : 'sr-only'}>{builtinDetails}</span>;
    // パネルを閉じたときはこのボタンへフォーカスを戻す（AppShell）。
    const vstEdit = onOpenVst && !(emptyVst && vstPanelOpen) && <Button variant="outline" size="default" type="button" id="vst-panel-toggle" onClick={onOpenVst} aria-expanded={vstPanelOpen} aria-controls="vst-panel"
        className="gap-1">
        {t(emptyVst ? 'chain.vstAdd' : 'chain.vstEditPanel')}<MdChevronRight aria-hidden="true" className="h-4 w-4" />
    </Button>;
    const rows = [
        // 表示用途を変えても音は変えない。音楽鑑賞の声向け処理は下の注意と情報ボタンから確認する。
        ...(music ? [] : [
            row({ key: 'noise', id: 'home-noise', on: noiseOn, quiet: !noiseOn, tag: builtinTag, builtin: true, name: t('settings.AudioSettingsModal.105'), sub: t('chain.noiseSub'),
                body: live ? <NoiseQuick q={q} /> : <StatusDot tone={live ? 'off' : tone(stage?.nr.enabled)} className="text-ui-support text-muted-foreground">{live ? t('flow.disabled') : setting(stage?.nr.enabled)}</StatusDot>,
                action: live && <NoiseSwitch q={q} /> }),
            row({ key: 'builtin', id: 'home-builtin', on: builtinOn, quiet: !builtinOn, tag: builtinTag, builtin: true, name: t('settings.AudioSettingsModal.095'), sub: t('chain.builtinSub'), title: builtinDetails,
                body: <>
                    {(!live || !builtinOn || (stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled)) && <StatusDot tone={live && !builtinOn ? 'off' : builtinTone} className="text-ui-support text-muted-foreground">{deesserOnly ? t('flow.deesserOnly') : stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled ? t('flow.reverbOnly') : live && !builtinOn ? t('flow.disabled') : setting(stage?.builtinVoiceEnabled)}</StatusDot>}
                    {builtinBreakdown}
                    {live && builtinOn && <BuiltinQuick q={q} />}
                    {stats?.builtInDeesser && <span className="basis-full text-ui-support text-muted-foreground">{t('flow.deesserLine', { amount: Math.round(stats.builtInDeesser.amount * 100) })}</span>}
                </>,
                action: live && <BuiltinSwitch q={q} /> }),
        ]),
        // 外部 VST を使わない人には、薄い1行で「使っていない」ことと追加の入口だけを示す。
        emptyVst
            ? row({ key: 'vst', on: false, quiet: true, tag: 'VST', name: t('chain.vstEmptyName'), sub: t('chain.vstEmptySub'),
                body: vstUnrestored.length > 0
                    ? <StatusDot tone="warn" className="text-ui-support">{unrestoredNamesText(t, vstUnrestored)}</StatusDot>
                    : <span className="text-ui-support text-muted-foreground">{t('flow.noVst')}</span>, action: vstEdit })
            : row({ key: 'vst', on: vstOn, tag: 'VST', name: 'VST', sub: <StatusDot tone={vstTone}>{vstStatus}</StatusDot>, body: vst, action: vstEdit }),
    ];
    return <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} inert={unconfigured} aria-disabled={unconfigured || undefined}
        className={cn('sound-chain mb-4 rounded-card bg-card gaming:bg-card/70 px-5 py-4 min-[1100px]:px-6', unconfigured && 'text-muted-foreground')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
                <h2 className="text-ui-heading font-semibold">{t(music ? 'wizard.musicSound' : 'shell.sound')}</h2>
                <InfoPopover label={t('flow.info')}>
                    <p>{t('flow.scope')}</p>
                    {stage && <p className="mt-2">{t(stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? 'flow.broadcastPath' : 'flow.monitorPath')}</p>}
                </InfoPopover>
            </div>
            {!unconfigured && <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="default" type="button" ref={listenButton} onClick={onListen} disabled={!audioReady} className="gap-1.5"><MdHearing aria-hidden="true" />{t(music ? 'wizard.musicListen' : 'home.voiceCheck')}</Button>
                {/* OBS連携と詳しい調整は毎回は使わないので、見出しに並べず「その他」にまとめる。
                    「詳しく調整」は声の処理の設定を開く。音楽鑑賞では VST 構成で整えるので出さない。 */}
                {!music && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" type="button" aria-label={t('chain.more')} title={t('chain.more')}>
                            <MdMoreHoriz aria-hidden="true" className="h-5 w-5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {model.context.usage === 'obs' && <DropdownMenuItem onSelect={onOpenOBSSettings} className="gap-2"><MdCast aria-hidden="true" className="h-4 w-4" />{t('shell.obs')}</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={onOpenSoundSettings ?? onOpenSettings} className="gap-2"><MdTune aria-hidden="true" className="h-4 w-4" />{t('home.moreSound')}</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>}
            </div>}
        </div>
        {!audioReady && !stopped ? <p className="text-ui-support text-muted-foreground">{t(inputName && outputName ? 'home.soundAfterStart' : 'home.soundAfterSetup')}</p>
            : music ? (noiseOn || builtinOn) && <div className="flex flex-wrap items-center gap-2 text-ui-support text-warning"><span>{t('flow.voiceStillOn')}</span><Button variant="outline" size="default" type="button" onClick={onOpenSoundSettings ?? onOpenSettings}>{t('home.moreSound')}</Button><InfoPopover label={t('chain.voiceTools')}><p>{builtinDetails}</p><p>{t('settings.AudioSettingsModal.105')}: {setting(stage?.nr.enabled)}</p></InfoPopover></div>
            : null}
        {/* 狭い作業幅では項目を折り返し、文字は省略しない。 */}
        <ol aria-label={t('flow.title')} className="sound-tool-list mt-2 grid grid-cols-3">
            {rows}
        </ol>

        {music && listenOpen && <MusicListeningCheck running={isEngineRunning} input={actualInput} output={actualOutput} onSettings={onOpenSettings} onClose={() => { onListenClose(); listenButton.current?.focus(); }} />}
    </section>;
}
