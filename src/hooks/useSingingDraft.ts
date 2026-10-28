import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { builtinApi, defaultSinging, defaultReverb, type BuiltinConfig, type BuiltinSnapshot, type SingingParams, type ReverbParams } from '@/api/builtinEffects';
import type { VoiceProposal } from '@/api/voiceCheckPreview';

// 親で下書きだけを保持する。画面が取得を依頼するまでEngineへ要求しない。
export function useSingingDraft() {
    const t = useMessages();
    const [users, setUsers] = useState(0);
    const activate = useCallback(() => { setUsers(value => value + 1); return () => setUsers(value => Math.max(0, value - 1)); }, []);
    const [snapshot, setSnapshot] = useState<BuiltinSnapshot | null>(null);
    const [draft, setDraft] = useState<BuiltinConfig | null>(null);
    const [draftRevision, setDraftRevision] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<SettingsNotice>('');
    const [conflict, setConflict] = useState(false);
    const state = useRef({ snapshot, draft }); state.current = { snapshot, draft };
    const operation = useRef(false);
    const mounted = useRef(true);
    const sequence = useRef(0);
    const needsRefresh = useRef(false);
    const undoInvalidated = useRef(false);
    const refresh = useCallback(async () => {
        if (operation.current) { needsRefresh.current = true; return; }
        operation.current = true;
        const version = ++sequence.current;
        if (mounted.current) setBusy(true);
        try {
            const received = await builtinApi.request({ action: 'snapshot' });
            const next = undoInvalidated.current ? { ...received, undoToken: null, redoToken: null } : received;
            if (!mounted.current || version !== sequence.current) return;
            const old = state.current.snapshot;
            const dirty = state.current.draft && old && JSON.stringify(state.current.draft) !== JSON.stringify(old.config);
            if (old && (next.epoch !== old.epoch || next.revision !== old.revision)) {
                setDraftRevision(value => value + 1);
                if (dirty) setConflict(true);
            }
            if (old && next.epoch === old.epoch && next.revision === old.revision) setConflict(false);
            state.current = { snapshot: next, draft: dirty ? state.current.draft : next.config };
            setSnapshot(next);
            if (!dirty) setDraft(next.config);
            setError('');
            return next;
        } catch {
            if (mounted.current && version === sequence.current) setError(notice('voice.copy.131'));
        } finally {
            operation.current = false;
            if (mounted.current) setBusy(false);
            if (needsRefresh.current && mounted.current) { needsRefresh.current = false; void refresh(); }
        }
    }, []);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; sequence.current += 1; };
    }, []);
    useEffect(() => {
        if (!snapshot || users === 0) return;
        const subscriptions = ['profile-fx-applied', 'audio-conditions-changed', 'audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'];
        const invalidate = () => {
            setDraftRevision(value => value + 1);
            setSnapshot(current => current ? { ...current, undoToken: null, redoToken: null } : null);
            if (!document.hidden) void refresh();
        };
        window.addEventListener('profile-fx-applied', invalidate);
        const native = subscriptions.filter(event => event !== 'profile-fx-applied').map(event => listen(event, invalidate));
        void Promise.all(native).catch(() => setError(notice('voice.copy.132')));
        return () => { window.removeEventListener('profile-fx-applied', invalidate); native.forEach(item => void item.then(stop => stop()).catch(() => {})); };
    }, [Boolean(snapshot), users > 0, refresh]);
    const transact = async (kind: 'apply' | 'undo' | 'redo' | 'proposal', config?: BuiltinConfig, proposal?: VoiceProposal) => {
        const current = state.current.snapshot;
        if (!current || operation.current) return false;
        const beforeDraft = state.current.draft;
        const preserveDraft = Boolean(beforeDraft && (kind === 'proposal' || ((config || kind === 'undo') && JSON.stringify(beforeDraft) !== JSON.stringify(current.config))));
        operation.current = true; sequence.current += 1; setBusy(true); setError('');
        let accepted = false;
        try {
            if (kind === 'undo' && !current.undoToken) return false;
            if (kind === 'redo' && !current.redoToken) return false;
            if (kind === 'proposal' && (!proposal || proposal.epoch !== current.epoch || proposal.baseRevision !== current.revision)) {
                setConflict(true); return false;
            }
            const next = await builtinApi.request(kind === 'proposal'
                ? { action: 'apply_proposal', epoch: proposal!.epoch, expectedRevision: proposal!.baseRevision, proposalId: proposal!.id, recordingId: proposal!.recordingId }
                : kind === 'apply'
                ? { action: 'apply', epoch: current.epoch, expectedRevision: current.revision, config: config ?? state.current.draft! }
                : kind === 'redo' ? {action: 'redo', epoch: current.epoch, expectedRevision: current.revision, redoToken: current.redoToken!}
                : { action: 'undo', epoch: current.epoch, expectedRevision: current.revision, undoToken: current.undoToken! });
            if (!mounted.current) return false;
            undoInvalidated.current = false;
            const nextDraft = preserveDraft ? beforeDraft : next.config;
            state.current = { snapshot: next, draft: nextDraft };
            setSnapshot(next); setDraft(nextDraft); setConflict(false); setDraftRevision(value => value + 1); accepted = true;
        } catch {
            if (mounted.current) { setConflict(true); setSnapshot(value => value ? { ...value, undoToken: null, redoToken: null } : value); setError(notice('voice.copy.133')); }
        } finally {
            operation.current = false; if (mounted.current) setBusy(false);
            if (needsRefresh.current) { needsRefresh.current = false; void refresh(); }
        }
        return accepted;
    };
    const edit = (patch: Partial<SingingParams>) => {
        if (operation.current || !state.current.draft) return;
        undoInvalidated.current = true;
        setDraft(current => current ? { ...current, active: true, preset: 'singing', singing: { ...defaultSinging, ...current.singing, ...patch } } : current);
        setDraftRevision(value => value + 1);
        setSnapshot(current => current ? { ...current, undoToken: null, redoToken: null } : current);
    };
    return { activate, snapshot, draft, draftRevision, busy, error: renderNotice(t, error), conflict, refresh,
        editReverb: (patch: Partial<ReverbParams>) => {
            if (operation.current || !state.current.draft) return;
            undoInvalidated.current = true;
            setDraft(current => current ? { ...current, reverb: { ...defaultReverb, ...current.reverb, ...patch } } : current);
            setDraftRevision(value => value + 1);
            setSnapshot(current => current ? { ...current, undoToken: null, redoToken: null } : current);
        },
        selectSinging: () => edit({ ...defaultSinging }), edit,
        resetDraft: () => { if (snapshot && !busy) { setDraft(snapshot.config); setConflict(false); setDraftRevision(value => value + 1); } },
        apply: () => transact('apply'), undo: () => transact('undo'), redo: () => transact('redo'),
        applyProposal: (proposal: VoiceProposal) => transact('proposal', undefined, proposal),
        setAppliedActive: (active: boolean) => state.current.snapshot ? transact('apply', { ...state.current.snapshot.config, active }) : Promise.resolve(false),
    };
}
export type SingingDraft = ReturnType<typeof useSingingDraft>;
