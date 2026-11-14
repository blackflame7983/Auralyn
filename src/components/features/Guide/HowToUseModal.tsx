import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MdClose } from 'react-icons/md';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { UserDocLink } from '@/components/ui/UserDocLink';
import { glossary, glossaryDocName, type UserDocName } from '@/lib/userDocs';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { shortcutActions, type ShortcutAction } from '@/lib/shortcutActions';
import { formatShortcut } from '@/lib/shortcutLabel';

const sections = ['home', 'setup', 'trouble', 'terms', 'keys'] as const;
type Section = typeof sections[number];
const storageKey = 'auralyn_help_section';
const sectionDocs = { home: 'help.home', setup: 'help.setup', trouble: 'help.troubleshooting', terms: 'help.glossary', keys: 'help.shortcuts' } as const satisfies Record<Section, UserDocName>;
type Binding = { action: ShortcutAction; shortcut: string };

interface Props {
    onClose: () => void;
    onSetup: () => void;
    onTroubleshoot: () => void;
    onOBS: () => void;
    onDiscord: () => void;
    onShortcuts: () => void;
}

export function HowToUseModal({ onClose, onSetup, onTroubleshoot, onOBS, onDiscord, onShortcuts }: Props) {
    const t = useMessages();
    const { locale } = useLocale();
    const heading = useId();
    const [section, setSection] = useState<Section>(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            return sections.find(value => value === saved) ?? 'home';
        } catch { return 'home'; }
    });
    const [bindings, setBindings] = useState<Binding[] | null>(null);
    const read = useRef(false);
    const body = useRef<HTMLDivElement>(null);
    // 読むだけの画面。割り当ての読み取りは、この節を初めて表示したときだけ行う。
    useEffect(() => {
        if (section !== 'keys' || read.current) return;
        read.current = true;
        void invoke<{ bindings: Binding[] }>('get_shortcuts').then(status => {
            if (!Array.isArray(status.bindings)) return;
            // 知らない操作の割り当てが1つ混ざっても、分かる操作の割り当ては表示する。
            setBindings(status.bindings.filter(binding => binding && Object.prototype.hasOwnProperty.call(shortcutActions, binding.action) && typeof binding.shortcut === 'string'));
        }).catch(() => {});
    }, [section]);
    const select = (next: Section) => {
        setSection(next);
        if (body.current) body.current.scrollTop = 0;
        try { localStorage.setItem(storageKey, next); } catch { /* 保存できなくても読む操作は続けられる。 */ }
    };
    const go = (open: () => void) => { onClose(); open(); };
    const labels = {
        compare: t('header.compare'), gain: t('master.outputGain'), mute: t('header.emergency'),
        noise: t('settings.AudioSettingsModal.105'), voice: t('settings.AudioSettingsModal.095'),
        basic: t('sound.section.basic'), modes: t('sound.section.liveModes'), singingSection: t('sound.section.singing'), peak: t('sound.section.peak'),
        peakDetails: t('peak.details'),
        details: t('prep.steps'), setup: t('header.setupOpen'), check: t('prep.title'), measure: t('home.measureNoise'),
        add: t('chain.vstAdd'), openVst: t('sound.openVst'),
        settings: t('rail.settings'), appearance: t('settings.appearance'), gaming: t('header.gaming'),
        choose: t('home.chooseDestination'), singing: t('liveBar.singing'), talk: t('liveBar.talk'), lock: t('liveBar.protect'), current: t('liveBar.custom'),
        input: t('unsetFlow.mic'), output: t('meter.output'), source: t('music.source'),
    };
    return <Modal title={t('help.title')} onClose={onClose}>
        <div className="modal-overlay-base">
            {/* 節を切り替えてもダイアログが上下に跳ばないよう、高さを固定して本文だけをスクロールさせる。 */}
            <div className="modal-surface-base flex h-[min(40rem,100%)] max-h-full w-full max-w-4xl min-w-0 flex-col">
                <div className="modal-header-base modal-header-muted shrink-0 gap-3">
                    <h2 className="min-w-0 text-ui-heading font-bold [overflow-wrap:anywhere]">{t('help.title')}</h2>
                    <Button variant="ghost" size="icon" className="shrink-0" onClick={onClose} aria-label={t('common.close')}><MdClose aria-hidden="true" /></Button>
                </div>
                <div ref={body} className="modal-body-base min-h-0 min-w-0">
                    <div className="grid min-w-0 gap-6 md:grid-cols-[11rem_minmax(0,1fr)]">
                        <nav aria-label={t('help.title')} className="flex min-w-0 flex-wrap content-start gap-1 [overflow-wrap:anywhere] md:flex-col">
                            {sections.map(value => <Button key={value} variant={section === value ? 'secondary' : 'ghost'}
                                className="h-auto min-w-0 max-w-full justify-start whitespace-normal text-left" aria-current={section === value ? 'page' : undefined}
                                onClick={() => select(value)}>{t(`help.section.${value}`)}</Button>)}
                        </nav>
                        <section aria-labelledby={heading} className="min-w-0 space-y-4 text-ui-support leading-relaxed [overflow-wrap:anywhere]">
                            <h2 id={heading} className="text-ui-heading font-semibold">{t(`help.section.${section}`)}</h2>
                            {section === 'home' && (['stage', 'meters', 'sound', 'check', 'footer'] as const).map(item => <div key={item}>
                                <h3 className="font-semibold">{item === 'check' ? t('prep.title') : t(`help.home.${item}.title`)}</h3>
                                <p className="mt-1 text-muted-foreground">{t(`help.home.${item}.body`, labels)}</p>
                            </div>)}
                            {section === 'setup' && <><p>{t('help.setup.body', labels)}</p><Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onSetup)}>{t('header.setupOpen')}</Button></>}
                            {section === 'trouble' && <>
                                <h3 className="font-semibold">{t('help.trouble.silent')}</h3><p>{t('help.trouble.silentBody', labels)}</p><UserDocLink name="troubleshooting.no-sound" compact />
                                <Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onTroubleshoot)}>{t('header.noSound')}</Button>
                                <h3 className="font-semibold">{t('help.trouble.receiver')}</h3><p>{t('help.trouble.receiverBody')}</p><UserDocLink name="troubleshooting.not-received" compact />
                                <div className="flex flex-wrap gap-2"><Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onOBS)}>{t('header.obs')}</Button><Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onDiscord)}>{t('header.discord')}</Button></div>
                                <h3 className="font-semibold">{t('help.trouble.dropouts')}</h3><p>{t('help.trouble.dropoutsBody')}</p><UserDocLink name="troubleshooting.dropouts" compact />
                                <Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onTroubleshoot)}>{t('header.noSound')}</Button>
                            </>}
                            {section === 'terms' && glossary[locale].map(term => <div key={term.anchor}><h3 className="font-semibold">{term.title}</h3><p className="mt-1 text-muted-foreground">{term.summary}</p><UserDocLink name={glossaryDocName(term.anchor)} compact /></div>)}
                            {section === 'keys' && <>
                                <p>{t('help.keys.f1')}</p>
                                {bindings === null ? <p role="status">{t('help.keys.fallback')}</p> : <dl className="space-y-3">{Object.entries(shortcutActions).map(([action, label]) => <div key={action} className="flex flex-wrap justify-between gap-2"><dt className="min-w-0 max-w-full">{t(label)}</dt><dd className="min-w-0 max-w-full font-mono">{formatShortcut(bindings.find(binding => binding.action === action)?.shortcut ?? '') || t('help.keys.unassigned')}</dd></div>)}</dl>}
                                <Button variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal" onClick={() => go(onShortcuts)}>{t('help.keys.settings')}</Button>
                            </>}
                            <UserDocLink name={sectionDocs[section]} />
                        </section>
                    </div>
                </div>
            </div>
        </div>
    </Modal>;
}
