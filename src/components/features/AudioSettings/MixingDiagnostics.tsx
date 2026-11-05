import { useEffect, useState } from 'react';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { postMixApi, type PostMixSnapshot } from '@/api/postMix';
import { useMessages } from '@/i18n/LocaleProvider';
import { MixingError } from './mixingUi';
export function MixingDiagnostics({ open }: { open: boolean }) {
    const t = useMessages(), [mix, setMix] = useState<MixSnapshot | null>(null), [post, setPost] = useState<PostMixSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!open) return;
        let active = true, reading = false;
        const read = async () => { if (reading || document.hidden) return; reading = true;
            try { const [m, p] = await Promise.all([mixingApi.request({ action: 'snapshot' }), postMixApi.request({ action: 'snapshot' })]); if (active) { setMix(m); setPost(p); setError(null); } }
            catch (e) { if (active) setError(String(e)); } finally { reading = false; }
        };
        void read(); const timer = setInterval(() => void read(), 1000); return () => { active = false; clearInterval(timer); };
    }, [open]);
    const unknown = t('mixing.unknown'), status = (v: boolean | null | undefined) => v == null ? unknown : v ? 'ON' : 'OFF';
    const rows = [
        [t('mixingDiagnostics.capture'), mix?.accompaniment ? `${mix.accompaniment.capturedFrames} / ${mix.accompaniment.nonzeroFrames}` : unknown],
        [t('mixingDiagnostics.queue'), mix?.accompaniment?.queuedFrames], [t('mixingDiagnostics.correction'), mix?.accompaniment?.correctionPpm],
        [t('mixingDiagnostics.discontinuities'), mix?.accompaniment?.discontinuities], [t('mixingDiagnostics.timestamps'), mix?.accompaniment?.timestampErrors],
        [t('mixingDiagnostics.nonfinite'), mix?.accompaniment?.nonfiniteSamples], [t('mixingDiagnostics.discarded'), mix?.accompaniment?.waitingDiscardedFrames],
        [t('mixingDiagnostics.primaryQueue'), mix?.primaryClock?.queuedFrames], [t('mixingDiagnostics.primaryCorrection'), mix?.primaryClock?.correctionPpm],
        [t('mixingDiagnostics.underruns'), mix?.primaryClock?.underruns], [t('mixingDiagnostics.voiceFrames'), mix?.knownVoiceProcessingFrames],
        [t('mixingDiagnostics.attached'), status(post?.attached)], [t('mixingDiagnostics.ready'), status(post?.ready)], [t('mixingDiagnostics.failed'), status(post?.failed)],
        [t('mixingDiagnostics.packets'), post?.processedPackets], [t('mixingDiagnostics.rate'), post?.sampleRate], [t('mixingDiagnostics.transport'), post?.transportLatencyFrames], [t('mixingDiagnostics.declared'), post?.declaredPluginLatencyFrames],
    ];
    return <section className="space-y-2"><table className="w-full table-fixed text-ui-support"><caption>{t('mixingDiagnostics.title')}</caption><tbody>{rows.map(([name, value]) => <tr key={name}><th scope="row" className="border-t py-2 text-left font-medium">{name}</th><td className="border-t py-2 text-right tabular-nums">{value ?? unknown}</td></tr>)}</tbody></table><MixingError error={error ? { operation: 'mixingUi.read', raw: error } : null} /></section>;
}
