import { Button } from '@/components/ui/button';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useMessages } from '@/i18n/LocaleProvider';
import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react';
import { MdAdd } from 'react-icons/md';
import { PagePortal } from '@/components/layout/pageSlot';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';
import { PluginList } from './PluginList';
import type { Plugin } from './PluginCard';

interface VstPageProps {
    plugins: Plugin[];
    audioReady: boolean;
    /** 開くたびに進む。見出しか「VSTを追加」へ焦点を移す。 */
    focusNonce: number;
    focusAdd: boolean;
    onAdd: () => void;
    onToggle: (id: string, enabled: boolean) => void;
    onMute: (id: string, muted: boolean) => void;
    onGainChange: (id: string, gain: number) => void;
    onRemove: (id: string) => void;
    onEdit: (id: string) => void;
    onReorder: (plugins: Plugin[]) => void;
    onOpenPresets: () => void;
    onOpenTemplates: () => void;
    /** セッション復元で読み込めなかった名前。見出しの下に置く。 */
    unrestored?: string[];
    tutorial?: ReactNode;
}

// 音が通る順。操作は置かず、OFF の VST は文字と印で示す。
function SignalOrder({ music, plugins }: { music: boolean; plugins: Plugin[] }) {
    const t = useMessages();
    const steps: { key: string; label: string; off?: boolean }[] = [
        { key: 'in', label: t(music ? 'vst.order.source' : 'vst.order.input') },
        ...(music ? [] : [
            { key: 'nr', label: t('settings.AudioSettingsModal.105') },
            { key: 'voice', label: t('settings.AudioSettingsModal.095') },
        ]),
        ...plugins.map(plugin => ({ key: plugin.id, label: plugin.name, off: !plugin.enabled })),
        { key: 'out', label: t('vst.order.output') },
    ];
    return <ol aria-label={t('vst.order')} className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-ui-support">
        {steps.map((step, index) => <li key={step.key} data-off={step.off || undefined} className="inline-flex items-center gap-1">
            {index > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
            <span className="min-w-0 break-words">{step.label}</span>
            {step.off && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-control border border-border px-1">
                <span aria-hidden="true">×</span>{t('vst.off')}
            </span>}
        </li>)}
    </ol>;
}

/** 中央の VST ページ。並べ替え・追加・保存は、これまでのラックの中身を1列で出す。 */
export function VstPage({
    plugins, audioReady, focusNonce, focusAdd, onAdd, onToggle, onMute, onGainChange, onRemove, onEdit, onReorder,
    onOpenPresets, onOpenTemplates, unrestored = [], tutorial,
}: VstPageProps) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
    const [addButton, setAddButton] = useState<HTMLButtonElement | null>(null);
    const headingRef = useCallback((node: HTMLHeadingElement | null) => setHeading(current => current === node ? current : node), []);
    const addRef = useCallback((node: HTMLButtonElement | null) => setAddButton(current => current === node ? current : node), []);
    // 差し込み先ができるまでは見出しが無い。付いてから、頼まれた先へ移す。
    // キーボードで開くと、入口が外れたあとに焦点が戻るので、描画の次でもう一度取る。
    useLayoutEffect(() => {
        if (!focusNonce) return;
        const target = focusAdd ? addButton : heading;
        if (!target) return;
        const move = () => { if (target.isConnected) target.focus({ preventScroll: true }); };
        move();
        const frame = requestAnimationFrame(move);
        return () => cancelAnimationFrame(frame);
    }, [focusNonce, focusAdd, heading, addButton]);
    const missing = unrestoredNamesText(t, unrestored);
    return <PagePortal>
        <div data-vst-page className="flex h-full min-h-0 flex-col overflow-hidden">
            <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 pb-2">
                <div className="min-w-0">
                    <h1 ref={headingRef} tabIndex={-1} className="text-ui-heading font-semibold text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{t('rail.vst')}</h1>
                    <p className="mt-1 break-words text-ui-support text-muted-foreground">{t('vst.lead')}</p>
                </div>
                <Button ref={addRef} id="add-effect-btn" type="button" variant="default" onClick={onAdd} className="h-auto min-h-10 shrink-0 gap-2 whitespace-normal">
                    <MdAdd aria-hidden="true" className="h-5 w-5" />{t('rack.addEffects')}
                </Button>
            </header>
            {missing && <p role="status" className="mb-2 break-words text-ui-support">{missing}</p>}
            <div className="min-h-0 flex-1 overflow-y-auto pb-4 scrollbar-thin scrollbar-thumb-muted-foreground scrollbar-track-transparent">
                <SignalOrder music={purpose === 'music'} plugins={plugins} />
                <PluginList
                    embedded
                    plugins={plugins}
                    audioReady={audioReady}
                    onAddClick={onAdd}
                    onToggle={onToggle}
                    onMute={onMute}
                    onGainChange={onGainChange}
                    onRemove={onRemove}
                    onEdit={onEdit}
                    onReorder={onReorder}
                    onOpenPresets={onOpenPresets}
                    onOpenTemplates={onOpenTemplates}
                />
                {tutorial}
            </div>
        </div>
    </PagePortal>;
}
