import { useRef, type ReactNode } from 'react';
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
}

// 音の流れと声の調整を1本のチェーンにまとめる。各段で状態を見て、その場で操作できる。
// 設定状態と音の到達確認は異なる。値を取得できないときは OFF と推測しない。
export function SoundChain({ model, audioReady, isEngineRunning, inputName, outputName, vst, listenOpen, onListen, onListenClose,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVst, vstPanelOpen = false, vstUnrestored = [] }: Props) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const listenButton = useRef<HTMLButtonElement>(null);
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    // 音楽鑑賞では声向けの処理を操作させず、VST 構成で音を整える。
    const controls = audioReady && !music;
    const q = useVoiceQuick(isEngineRunning, controls);
    const live = controls && q.stats !== null;
    const setting = (value: boolean | undefined) => value === undefined ? t('flow.unknown') : value ? t('flow.enabled') : t('flow.disabled');
    const validVst = stage && stage.vst.every(v => typeof v.id === 'string' && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state));
    const vstStatus = !stage || !validVst || stage.vst.some(v => v.state === 'unavailable') ? t('flow.unknown')
        : stage.globalBypass ? t('flow.vstBypassed') : stage.vst.length === 0 ? t('flow.noVst')
        : stage.vst.some(v => v.state === 'muted') ? t('flow.vstMixed')
        : setting(stage.vst.some(v => v.state === 'active'));
    const builtinDetails = stage ? t('flow.builtinParts', { voice: setting(stage.builtinVoiceEnabled), reverb: setting(stage.builtinReverbEnabled) }) : undefined;
    const partial = Boolean(stage && stage.builtinVoiceEnabled !== stage.builtinReverbEnabled);
    const builtinStatus = partial ? t('flow.partial') : setting(stage?.builtinVoiceEnabled);
    // 状態は色の点と文言で示す。未確認は注意、OFF は中立で、問題とは区別する（DESIGN.md 5.1）。
    const tone = (value: boolean | undefined): StatusTone => value === undefined ? 'warn' : value ? 'ok' : 'off';
    const vstTone: StatusTone = vstStatus === t('flow.enabled') ? 'ok' : vstStatus === t('flow.disabled') || vstStatus === t('flow.noVst') ? 'off' : 'warn';
    const builtinTone: StatusTone = partial ? 'ok' : tone(stage?.builtinVoiceEnabled);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;

    const emptyVst = !music && Boolean(stage && validVst && stage.vst.length === 0);
    // 音の順序は保ち、枠の入れ子と分類タグの反復をなくす。名前・操作・スイッチの列を揃える。
    const row = ({ key, id, on, tag, builtin, name, sub, title, body, action, quiet }: {
        key: string; id?: string; on: boolean; tag: string; builtin?: boolean; name: string; sub?: ReactNode; title?: string;
        body?: ReactNode; action?: ReactNode; quiet?: boolean;
    }) => {
        const Icon = builtin ? key === 'noise' ? MdFilterAlt : MdGraphicEq : MdExtension;
        return <li key={key}>
            <div id={id} tabIndex={id ? -1 : undefined} data-on={on}
                className={cn('sound-chain-row grid items-center gap-x-4 gap-y-3 py-4', quiet && 'py-3')}>
                <div className="flex min-w-0 items-center gap-3" title={title ?? (typeof sub === 'string' ? sub : undefined)}>
                    <Icon aria-hidden="true" className={cn('h-5 w-5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
                    <div className="min-w-0">
                        <span className="sr-only">{tag}</span>
                        <div className="flex items-center gap-1">
                            <h3 className="text-sm font-semibold">{name}</h3>
                            {key === 'builtin' && <InfoPopover label={t('settings.builtinHelp')}><p>{t('settings.AudioSettingsModal.096')}</p>{builtinDetails && <p className="mt-2">{builtinDetails}</p>}</InfoPopover>}
                            {key === 'vst' && quiet && <InfoPopover label={t('chain.vstEmptyName')}>{t('chain.vstEmptyHint')}</InfoPopover>}
                        </div>
                        {sub && <div className={typeof sub === 'string' ? 'sr-only' : 'text-xs text-muted-foreground'}>{sub}</div>}
                    </div>
                </div>
                <div className="sound-chain-controls flex min-w-0 flex-wrap items-center gap-2.5">{body}</div>
                {action && <div className="sound-chain-action justify-self-end">{action}</div>}
            </div>
        </li>;
    };
    const builtinTag = t('chain.tagBuiltin');
    const noiseOn = live ? q.noiseOn : stage?.nr.enabled === true;
    const builtinOn = live ? q.chainOn || partial : stage?.builtinVoiceEnabled === true || partial;
    const vstOn = vstTone === 'ok';
    // 声の処理と残響は別の設定。声ON・残響OFFを異常に見せず、逆の場合だけ「残響のみ」を伝える。
    const builtinBreakdown = builtinDetails && <span className={music && partial ? 'text-xs text-muted-foreground' : 'sr-only'}>{builtinDetails}</span>;
    // パネルを閉じたときはこのボタンへフォーカスを戻す（AppShell）。
    const vstEdit = onOpenVst && <button type="button" id="vst-panel-toggle" onClick={onOpenVst} aria-expanded={vstPanelOpen} aria-controls="vst-panel"
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-primary/60 px-3 py-1.5 text-[13px] font-semibold text-primary hover:bg-primary/10">
        {t(emptyVst ? 'chain.vstAdd' : 'chain.vstEditPanel')}<MdChevronRight aria-hidden="true" className="h-4 w-4" />
    </button>;
    const rows = [
        // 音楽鑑賞では声向けの処理を操作しないので、2段を状態だけの1段に縮める。設定が残っていれば音楽にもかかるため、状態は隠さない。
        ...(music ? [row({ key: 'voice', on: noiseOn || builtinOn, tag: builtinTag, builtin: true, name: t('chain.voiceTools'), body: <>
            <StatusDot tone={tone(stage?.nr.enabled)} className="text-[13px]">{t('settings.AudioSettingsModal.105')} {setting(stage?.nr.enabled)}</StatusDot>
            <StatusDot tone={builtinTone} className="text-[13px]">{t('settings.AudioSettingsModal.095')} {builtinStatus}</StatusDot>
            {builtinBreakdown}
        </> })] : [
            row({ key: 'noise', id: 'home-noise', on: noiseOn, quiet: !noiseOn, tag: builtinTag, builtin: true, name: t('settings.AudioSettingsModal.105'), sub: t('chain.noiseSub'),
                body: live && noiseOn ? <NoiseQuick q={q} /> : <StatusDot tone={live ? 'off' : tone(stage?.nr.enabled)} className="text-[13px] text-muted-foreground">{live ? t('flow.disabled') : setting(stage?.nr.enabled)}</StatusDot>,
                action: live && <NoiseSwitch q={q} /> }),
            row({ key: 'builtin', id: 'home-builtin', on: builtinOn, quiet: !builtinOn, tag: builtinTag, builtin: true, name: t('settings.AudioSettingsModal.095'), sub: t('chain.builtinSub'), title: builtinDetails,
                body: <>
                    {(!live || !builtinOn || (stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled)) && <StatusDot tone={live && !builtinOn ? 'off' : builtinTone} className="text-[13px] text-muted-foreground">{stage?.builtinReverbEnabled && !stage.builtinVoiceEnabled ? t('flow.reverbOnly') : live && !builtinOn ? t('flow.disabled') : setting(stage?.builtinVoiceEnabled)}</StatusDot>}
                    {builtinBreakdown}
                    {live && builtinOn && <BuiltinQuick q={q} />}
                </>,
                action: live && <BuiltinSwitch q={q} /> }),
        ]),
        // 外部 VST を使わない人には、薄い1行で「使っていない」ことと追加の入口だけを示す。
        emptyVst
            ? row({ key: 'vst', on: false, quiet: true, tag: 'VST', name: t('chain.vstEmptyName'), sub: t('chain.vstEmptySub'),
                body: vstUnrestored.length > 0
                    ? <StatusDot tone="warn" className="text-xs">{unrestoredNamesText(t, vstUnrestored)}</StatusDot>
                    : <span className="text-xs text-muted-foreground">{t('flow.noVst')}</span>, action: vstEdit })
            : row({ key: 'vst', on: vstOn, tag: 'VST', name: 'VST', sub: <StatusDot tone={vstTone}>{vstStatus}</StatusDot>, body: vst, action: vstEdit }),
    ];
    return <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} className="sound-chain mb-4 rounded-xl border border-border bg-card gaming:bg-card/70 px-4 py-3 min-[1100px]:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
                <h2 className="text-sm font-bold">{t(music ? 'wizard.musicSound' : 'shell.sound')}</h2>
                <InfoPopover label={t('flow.info')}>
                    <p>{t('flow.scope')}</p>
                    {stage && <p className="mt-2">{t(stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? 'flow.broadcastPath' : 'flow.monitorPath')}</p>}
                </InfoPopover>
            </div>
            <div className="flex flex-wrap gap-2">
                <button type="button" ref={listenButton} onClick={onListen} disabled={!audioReady} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"><MdHearing aria-hidden="true" />{t(music ? 'wizard.musicListen' : 'home.voiceCheck')}</button>
                {/* OBS連携と詳しい調整は毎回は使わないので、見出しに並べず「その他」にまとめる。
                    「詳しく調整」は声の処理の設定を開く。音楽鑑賞では VST 構成で整えるので出さない。 */}
                {!music && (model.context.usage === 'obs' || onOpenSoundSettings) && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button type="button" aria-label={t('chain.more')} title={t('chain.more')} className="inline-flex items-center rounded-md border border-border p-1.5 hover:bg-muted">
                            <MdMoreHoriz aria-hidden="true" className="h-5 w-5" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {model.context.usage === 'obs' && <DropdownMenuItem onSelect={onOpenOBSSettings} className="gap-2"><MdCast aria-hidden="true" className="h-4 w-4" />{t('shell.obs')}</DropdownMenuItem>}
                        {onOpenSoundSettings && <DropdownMenuItem onSelect={onOpenSoundSettings} className="gap-2"><MdTune aria-hidden="true" className="h-4 w-4" />{t('home.moreSound')}</DropdownMenuItem>}
                    </DropdownMenuContent>
                </DropdownMenu>}
            </div>
        </div>
        {!audioReady ? <p className="text-xs text-muted-foreground">{t(inputName && outputName ? 'home.soundAfterStart' : 'home.soundAfterSetup')}</p>
            // 音楽鑑賞では声の段に操作を出さない理由を、常に見える形で示す。
            : music ? <p className="text-xs text-muted-foreground">{t('music.soundHint')}</p>
            : !live && <p role="status" className="text-xs text-muted-foreground">{t('home.voiceUnavailable')}</p>}
        {/* 段の間は細い線でつなぎ、矢印やボックスの入れ子にしない。 */}
        <ol aria-label={t('flow.title')} className="mt-2 divide-y divide-border/60">
            {rows}
        </ol>
        {music && listenOpen && <MusicListeningCheck running={isEngineRunning} input={actualInput} output={actualOutput} onSettings={onOpenSettings} onClose={() => { onListenClose(); listenButton.current?.focus(); }} />}
    </section>;
}
