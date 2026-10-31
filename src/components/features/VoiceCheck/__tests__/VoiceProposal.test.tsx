import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { builtinApi, defaultSinging, type BuiltinSnapshot } from '@/api/builtinEffects';
import { audioApi } from '@/api/audio';
import { defaultProposalPreferences, voicePreviewApi, type BuiltinCandidate, type VoicePreviewRequest, type VoiceProposal } from '@/api/voiceCheckPreview';
import { useSingingDraft } from '@/hooks/useSingingDraft';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { useVoiceCheck } from '../useVoiceCheck';
import { VoiceCheckModal } from '../VoiceCheckModal';
import { ProposalMessageView } from '../VoiceProposalPanel';
import { previewSnapshot } from './previewFixture';

const original = { active: false, preset: 'broadcast' as const, amount: .6, singing: null };
const config = { ...original, active: true, preset: 'singing' as const, singing: { ...defaultSinging }, reverb: { enabled: false, mix: .12, decaySeconds: 1.8, damping: .4 } };
const proposal = (): VoiceProposal => ({ id: 'proposal1', epoch: 'builtin1', recordingId: 9, baseRevision: '4', ruleVersion: 'singing-rules-v1', config,
    metrics: { sampleRate: 48000, sourceFrames: 192000, durationSeconds: 4, channelPeak: [.4, .4], channelRmsDb: [-18, -18], windowMs: 20, activityThresholdDb: -45, totalWindows: 200, activeWindows: 150, activeFraction: .75, activeRmsP10Db: -23, activeRmsP50Db: -18, activeRmsP90Db: -12, activeWindowSpreadDb: 11 },
    reasons: [{ code: 'proposal.fixedStartingPoints', args: {}, fallbackJa: 'raw fallback' }], limitations: [{ code: 'proposal.notSpeechOrNoiseDetection', args: {}, fallbackJa: 'raw limit' }] });
const candidate = (): BuiltinCandidate => ({ id: 'candidate1', recordingId: 9, baseRevision: '4', state: 'ready', config, sampleRate: 48000, sourceFrames: 192000, renderedFrames: 192000, algorithmicLatencyFrames: 0, filterPhase: 'minimumPhase', samplePeak: .4, error: null, proposal: proposal() });
const candidateFor = (request: VoicePreviewRequest, id='candidate1') => {
    const value = {...candidate(),id};
    if(request.action==='prepare_proposal' && request.preferences) value.proposal={...proposal(),ruleVersion:'singing-rules-v2',preferences:request.preferences,preferencesRevision:request.preferencesRevision};
    return value;
};
const emit = (event: string) => { for (const [name, callback] of vi.mocked(listen).mock.calls) if (name === event) callback({ event, id: 1, payload: null }); };
let state: BuiltinSnapshot;
let prepared: BuiltinCandidate | null;
beforeEach(() => {
    localStorage.clear(); prepared = null;
    state = { epoch: 'builtin1', revision: '4', appliedRevision: '4', pending: false, undoToken: null, error: null, config: original };
    vi.mocked(listen).mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'stopVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(voicePreviewApi, 'request').mockImplementation(async request => {
        if (request.action === 'prepare_proposal') prepared = candidateFor(request);
        return previewSnapshot(request, { epoch: 'preview1', recordingId: 9, durationMs: 4000, candidate: prepared, devices: [{ id: 'hp', name: '実名ヘッドホン' }], state: request.action === 'start' ? 'playing' : request.action === 'close' ? 'closed' : 'idle', source: 'processed' });
    });
    vi.spyOn(builtinApi, 'request').mockImplementation(async request => {
        if (request.action === 'apply_proposal') state = { ...state, revision: '5', config, pending: true, undoToken: 'undo1' };
        if (request.action === 'undo') state = { ...state, revision: '6', config: original, pending: false, undoToken: null };
        return structuredClone(state);
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('通常経路は明示prepareだけで2種類のepochを送り、candidate A/Bは既存transportを使う', async () => {
    const basis = { epoch: 'builtin1', revision: '4', draftRevision: 0 };
    const { result } = renderHook(() => useVoiceCheck(true, undefined, basis));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('preview1'));
    expect(voicePreviewApi.request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare_proposal' }));
    await act(async () => { await result.current.prepareProposal(basis); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare_proposal', epoch: 'preview1', builtinEpoch: 'builtin1', expectedRevision: '4', recordingId: 9 }));
    expect(result.current.candidate?.proposal?.epoch).toBe('builtin1');
    expect(builtinApi.request).not.toHaveBeenCalled();
    act(() => { result.current.setPreviewDeviceId('hp'); result.current.setSafeOutput(true); });
    await act(async () => { await result.current.refreshPreviewDevices(); });
    act(() => result.current.setSafeOutput(true));
    await act(async () => { await result.current.handleTogglePlayback(); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', epoch: 'preview1', candidateId: 'candidate1', deviceId: 'hp' }));
});

it.each(['close', 'revision', 'epoch', 'draft', 'recording'] as const)('遅い提案結果を%s失効後へ採用しない', async change => {
    const basis = { epoch: 'builtin1', revision: '4', draftRevision: 0 };
    let finish!: (value: ReturnType<typeof previewSnapshot>) => void;
    let pending!: VoicePreviewRequest;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'prepare_proposal') { pending = request; return new Promise(resolve => { finish = resolve; }); }
        return previewSnapshot(request, { epoch: 'preview1', recordingId: 9 });
    });
    const { result, rerender } = renderHook(({ open, basis }) => useVoiceCheck(open, undefined, basis), { initialProps: { open: true, basis } });
    await waitFor(() => expect(result.current.preview?.epoch).toBe('preview1'));
    let preparing!: Promise<void>;
    act(() => { preparing = result.current.prepareProposal(basis); });
    await waitFor(() => expect(pending).toBeDefined());
    if (change === 'close') rerender({ open: false, basis });
    else if (change !== 'recording') rerender({ open: true, basis: { ...basis, ...(change === 'revision' ? { revision: '5' } : change === 'epoch' ? { epoch: 'builtin2' } : { draftRevision: 1 }) } });
    await act(async () => { finish(previewSnapshot(pending, { epoch: 'preview1', recordingId: change === 'recording' ? 10 : 9, candidate: candidate() })); await preparing; });
    expect(result.current.candidate).toBeNull();
    expect(builtinApi.request).not.toHaveBeenCalled();
});

it('提案Applyはmanual draftを保持し、自己条件通知後も成功ACK/pending/Undoを失敗へ変えない', async () => {
    const { result } = renderHook(() => { const model = useSingingDraft(); useEffect(() => model.activate(), [model.activate]); return model; });
    await act(async () => { await result.current.refresh(); });
    act(() => result.current.edit({ lowCutHz: 140, brightnessDb: 2 }));
    const draft = structuredClone(result.current.draft);
    const request = vi.mocked(builtinApi.request).getMockImplementation()!;
    vi.mocked(builtinApi.request).mockImplementation(async value => { if (value.action === 'apply_proposal') emit('audio-conditions-changed'); return request(value); });
    let accepted = false;
    await act(async () => { accepted = await result.current.applyProposal(proposal()); });
    expect(accepted).toBe(true);
    expect(result.current.draft).toEqual(draft);
    expect(result.current.snapshot?.config).toEqual(config);
    expect(result.current.snapshot?.pending).toBe(true);
    expect(result.current.snapshot?.undoToken).toBe('undo1');
    expect(result.current.error).toBe('');
    await act(async () => { await result.current.undo(); });
    expect(builtinApi.request).toHaveBeenCalledWith({ action: 'undo', epoch: 'builtin1', expectedRevision: '5', undoToken: 'undo1' });
    expect(result.current.draft).toEqual(draft);
});

it('Applyの結果不明を再適用せず、古いCAS提案も送らない', async () => {
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); });
    vi.mocked(builtinApi.request).mockRejectedValueOnce(new Error('timeout'));
    await act(async () => { await result.current.applyProposal(proposal()); });
    expect(result.current.error).not.toBe('');
    expect(vi.mocked(builtinApi.request).mock.calls.filter(([r]) => r.action === 'apply_proposal')).toHaveLength(1);
    await act(async () => { await result.current.applyProposal({ ...proposal(), epoch: 'old' }); });
    expect(vi.mocked(builtinApi.request).mock.calls.filter(([r]) => r.action === 'apply_proposal')).toHaveLength(1);
});

it('通常VoiceCheckで提案を作りlocaleを替えても候補・device・安全確認・manual入力を保持する', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const save = vi.fn();
    function Screen() { const model = useSingingDraft(); return <><input type="number" aria-label="manual draft" value={model.draft?.singing?.lowCutHz ?? 80} onChange={e => model.edit({ lowCutHz: Number(e.target.value) })} /><VoiceCheckModal isOpen manualCandidate={false} singingModel={model} onClose={vi.fn()} onSaveSingingProfile={save} /></>; }
    render(<LocaleProvider store={store}><Screen /></LocaleProvider>);
    const candidates = (await screen.findByText('歌向け：内蔵ボイスチェーンの候補を試す')).closest('details')!;
    expect(candidates).not.toHaveAttribute('open');
    const play = screen.getByRole('button', { name: '選んだ試聴先で再生' });
    expect(play.compareDocumentPosition(candidates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByText('歌向け：内蔵ボイスチェーンの候補を試す'));
    const create = await screen.findByRole('button', { name: '録音から比較候補を作る' });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '提案に使う現在設定を再取得' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('manual draft'), { target: { value: '140' } });
    fireEvent.click(create);
    await screen.findByText(/低音整理80Hz/);
    fireEvent.click(screen.getByRole('button', { name: '試聴先を取得・更新' }));
    await screen.findByRole('option', { name: '実名ヘッドホン' });
    fireEvent.change(screen.getByRole('combobox', { name: 'ボイスチェックの試聴先' }), { target: { value: 'hp' } });
    const safety = screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ }); fireEvent.click(safety);
    const dialog = screen.getByRole('dialog'); const calls = vi.mocked(voicePreviewApi.request).mock.calls.length;
    const builtinCalls = vi.mocked(builtinApi.request).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('combobox', { name: 'Voice Check listening output' })).toHaveValue('hp');
    expect(screen.getByLabelText('manual draft')).toHaveValue(140);
    expect(screen.getByRole('checkbox', { name: /I checked that OBS/ })).toBeChecked();
    expect(screen.getByText(/fixed starting points, not measured optimal/)).toBeVisible();
    expect(voicePreviewApi.request).toHaveBeenCalledTimes(calls);
    expect(builtinApi.request).toHaveBeenCalledTimes(builtinCalls);
    expect(builtinApi.request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'apply_proposal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply this proposal to your microphone sound' }));
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalledWith({ action: 'apply_proposal', epoch: 'builtin1', expectedRevision: '4', proposalId: 'proposal1', recordingId: 9 }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Undo the last application once' })).toBeDisabled();
    act(() => { state = { ...state, pending: false, appliedRevision: '5' }; });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo the last application once' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Open profile saving for applied settings' })).toBeEnabled();
    await act(async () => { emit('audio-conditions-changed'); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo the last application once' })).toBeEnabled());
    expect(vi.mocked(builtinApi.request).mock.calls.filter(([r]) => r.action === 'apply_proposal')).toHaveLength(1);
});

it('未知codeは明示fallbackで表示し、backend原文やcodeを翻訳用keyへ流用しない', () => {
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><ProposalMessageView value={{ code: 'constructor', args: {}, fallbackJa: '未翻訳の元メッセージ' }} /></LocaleProvider>);
    expect(screen.getByText('Unrecognized proposal message (constructor).')).toBeInTheDocument();
    expect(screen.getByText('Original detail (untranslated)')).toBeInTheDocument();
    expect(screen.getByText('未翻訳の元メッセージ')).toBeInTheDocument();
});

it('serialized小数をJA/ENの表示だけ2桁へ整え、提案原本やIPCを変更しない', () => {
    const value = Object.freeze({ code: 'proposal.dynamicsFromWindowSpread', args: Object.freeze({ spreadDb: 12.000197729971276, dynamics: 0.3499999940395355 }), fallbackJa: 'raw fallback' });
    const original = JSON.stringify(value);
    const store = createLocaleStore(() => 'ja', () => true);
    const view = render(<LocaleProvider store={store}><ProposalMessageView value={value} /></LocaleProvider>);
    expect(view.container).toHaveTextContent('音量差 12.00 dB');
    expect(view.container).toHaveTextContent('量 0.35 の比較候補');
    act(() => { store.setLocale('en'); });
    expect(view.container).toHaveTextContent('(12.00 dB)');
    expect(view.container).toHaveTextContent('setting of 0.35');
    expect(view.container).not.toHaveTextContent('12.000197');
    expect(view.container).not.toHaveTextContent('0.349999');
    expect(view.container).not.toHaveTextContent('35%');
    expect(view.container).not.toHaveTextContent('raw fallback');
    expect(JSON.stringify(value)).toBe(original);
    expect(voicePreviewApi.request).not.toHaveBeenCalled();
    expect(builtinApi.request).not.toHaveBeenCalled();
});

it('候補終了は遅いstatusを拒否し、録音/device/安全確認を保持して通常加工後へ明示復帰する', async () => {
    const basis = { epoch: 'builtin1', revision: '4', draftRevision: 0 };
    const { result } = renderHook(() => useVoiceCheck(true, undefined, basis));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('preview1'));
    await act(async () => { await result.current.prepareProposal(basis); await result.current.refreshPreviewDevices(); });
    act(() => { result.current.setPreviewDeviceId('hp'); result.current.setSafeOutput(true); });
    let finish!: (value: ReturnType<typeof previewSnapshot>) => void;
    let held!: VoicePreviewRequest;
    const originalRequest = vi.mocked(voicePreviewApi.request).getMockImplementation()!;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'status') { held = request; return new Promise(resolve => { finish = resolve; }); }
        return originalRequest(request);
    });
    await waitFor(() => expect(held).toBeDefined());
    await act(async () => { await result.current.returnToRecording(); });
    await act(async () => { finish(previewSnapshot(held, { epoch: 'preview1', recordingId: 9, candidate: candidate() })); });
    expect(result.current.candidateMode).toBe('normal'); expect(result.current.candidate).toBeNull();
    expect(result.current.previewDeviceId).toBe('hp'); expect(result.current.safeOutput).toBe(true);
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_candidate', candidateId: 'candidate1' }));
    await act(async () => { await result.current.handleTogglePlayback(); });
    const start = [...vi.mocked(voicePreviewApi.request).mock.calls].reverse().find(([request]) => request.action === 'start')![0];
    expect(start).not.toHaveProperty('candidateId'); expect(start).toEqual(expect.objectContaining({ recordingId: 9 }));
});

it('手動Aと録音提案Bを混同せず、手動再準備後のA/BにはAのcandidate IDを送る', async () => {
    state = { ...state, config: { ...config, singing: { ...defaultSinging, lowCutHz: 120 } } };
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'prepare_proposal') prepared = candidateFor(request);
        if (request.action === 'prepare_candidate') prepared = { ...candidate(), id: 'manual140', config: request.config, proposal: null };
        return previewSnapshot(request, { epoch: 'preview1', recordingId: 9, durationMs: 4000, candidate: prepared, devices: [{ id: 'hp', name: 'Headphones' }], state: request.action === 'start' ? 'playing' : request.action === 'close' ? 'closed' : 'idle' });
    });
    function Screen() { const model = useSingingDraft(); return <><input type="number" aria-label="manual" value={model.draft?.singing?.lowCutHz ?? 80} onChange={e => model.edit({ lowCutHz: Number(e.target.value) })} /><VoiceCheckModal isOpen singingModel={model} onClose={vi.fn()} /></>; }
    render(<Screen />);
    const manual = await screen.findByRole('button', { name: 'この録音から内蔵ボイスチェーンの候補を作成' });
    await waitFor(() => expect(manual).toBeEnabled());
    fireEvent.change(screen.getByLabelText('manual'), { target: { value: '140' } });
    fireEvent.click(screen.getByRole('button', { name: '録音から比較候補を作る' }));
    await screen.findByText(/低音整理80Hz/);
    expect(screen.queryByText('候補の準備ができました。試聴先を確認して再生してください。')).not.toBeInTheDocument();
    expect(screen.getByText('A/B対象：原音と録音由来の提案（内蔵ボイスチェーンのみ）')).toBeVisible();
    expect(screen.getByRole('button', { name: 'この音をマイクへ適用' })).toBeDisabled();
    fireEvent.click(manual);
    await screen.findByText('候補の準備ができました。試聴先を確認して再生してください。');
    expect(screen.getByText('A/B対象：原音と手動下書きの候補（内蔵ボイスチェーンのみ）')).toBeVisible();
    expect(prepared?.config.singing?.lowCutHz).toBe(140);
    fireEvent.click(screen.getByRole('button', { name: '試聴先を取得・更新' }));
    await screen.findByRole('option', { name: 'Headphones' });
    fireEvent.change(screen.getByRole('combobox', { name: 'ボイスチェックの試聴先' }), { target: { value: 'hp' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ }));
    fireEvent.click(screen.getByRole('button', { name: '選んだ試聴先で再生' }));
    await waitFor(() => expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', candidateId: 'manual140' })));
});



it('unsealed/renderFailedだけを既知表示にし、失敗の原文と未知codeをlocaleでも保持する',()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);
    const view=render(<LocaleProvider store={store}><div><ProposalMessageView value={{code:'proposal.unsealed',args:{},fallbackJa:'録音の確定を待ってください。'}}/><ProposalMessageView value={{code:'proposal.renderFailed',args:{},fallbackJa:'SDK exact render detail'}}/><ProposalMessageView value={{code:'proposal.future',args:{},fallbackJa:'future exact detail'}}/></div></LocaleProvider>);
    expect(view.container).toHaveTextContent('録音の確定を待ってください。');
    act(()=>{store.setLocale('en');});
    expect(view.container).toHaveTextContent('Wait until the recording is ready.');
    expect(view.container).toHaveTextContent('Could not create the candidate. Review the original details.');
    expect(screen.getByText('SDK exact render detail')).toBeInTheDocument();expect(screen.getByText('future exact detail')).toBeInTheDocument();
    expect(voicePreviewApi.request).not.toHaveBeenCalled();expect(builtinApi.request).not.toHaveBeenCalled();
});

it.each(['v1','revision','preferences'] as const)('v2要求へ不一致%s応答を返すbackendを希望反映済みにせず、旧候補だけ取消す',async mismatch=>{
    vi.mocked(voicePreviewApi.request).mockImplementation(async request=>{const value=candidateFor(request);if(mismatch==='v1')value.proposal=proposal();else if(value.proposal){if(mismatch==='revision')value.proposal.preferencesRevision=999;else value.proposal.preferences={...defaultProposalPreferences,brightness:'softer'};}return previewSnapshot(request,{epoch:'preview1',recordingId:9,candidate:request.action==='prepare_proposal'?value:null});});
    const basis={epoch:'builtin1',revision:'4',draftRevision:0};
    const {result}=renderHook(()=>useVoiceCheck(true,undefined,basis));
    await waitFor(()=>expect(result.current.preview?.epoch).toBe('preview1'));
    await act(async()=>{await result.current.prepareProposal(basis,{preferences:{...defaultProposalPreferences},preferencesRevision:1});});
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({action:'prepare_proposal',ruleVersion:'singing-rules-v2',preferencesRevision:1}));
    expect(result.current.candidate).toBeNull();expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({action:'cancel_candidate',candidateId:'candidate1'}));expect(builtinApi.request).not.toHaveBeenCalled();
});
it('希望変更後のlate ACKは古いIDだけ取消し、新しいv2候補を保持する',async()=>{
    let finish!:(v:ReturnType<typeof previewSnapshot>)=>void;let held!:VoicePreviewRequest;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request=>{
        if(request.action==='prepare_proposal'&&request.preferencesRevision===1){held=request;return new Promise(resolve=>{finish=resolve;});}
        return previewSnapshot(request,{epoch:'preview1',recordingId:9,candidate:request.action==='prepare_proposal'?candidateFor(request,'new'):null});
    });
    const basis={epoch:'builtin1',revision:'4',draftRevision:0};const {result}=renderHook(()=>useVoiceCheck(true,undefined,basis));
    await waitFor(()=>expect(result.current.preview?.epoch).toBe('preview1'));
    let old!:Promise<void>;act(()=>{old=result.current.prepareProposal(basis,{preferences:{...defaultProposalPreferences},preferencesRevision:1});});
    await waitFor(()=>expect(held).toBeDefined());act(()=>result.current.invalidateProposalPreferences());
    await act(async()=>{await result.current.prepareProposal(basis,{preferences:{...defaultProposalPreferences,brightness:'softer'},preferencesRevision:2});});
    expect(result.current.candidate?.id).toBe('new');
    await act(async()=>{finish(previewSnapshot(held,{epoch:'preview1',recordingId:9,candidate:candidateFor(held,'old')}));await old;});
    expect(result.current.candidate?.id).toBe('new');
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({action:'cancel_candidate',candidateId:'old'}));
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([r])=>r.action==='cancel_candidate'&&r.candidateId==='new')).toBe(false);
});
it('希望変更はApplyを即失効し、locale変更は希望DOMとdraftを保持し自動prepareしない',async()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);
    function Screen(){const model=useSingingDraft();return <VoiceCheckModal isOpen manualCandidate={false} singingModel={model} onClose={vi.fn()}/>;}
    render(<LocaleProvider store={store}><Screen/></LocaleProvider>);
    const create=await screen.findByRole('button',{name:'録音から比較候補を作る'});await waitFor(()=>expect(create).toBeEnabled());
    fireEvent.click(create);await waitFor(()=>expect(screen.getByRole('button',{name:'この提案をマイクの音へ適用'})).toBeEnabled());
    const select=screen.getByLabelText('明るさの希望');fireEvent.change(select,{target:{value:'softer'}});
    expect(screen.queryByRole('button',{name:'この提案をマイクの音へ適用'})).not.toBeInTheDocument();
    const count=vi.mocked(voicePreviewApi.request).mock.calls.filter(([r])=>r.action==='prepare_proposal').length;
    act(()=>store.setLocale('en'));
    expect(screen.getByLabelText('Brightness preference')).toBe(select);expect(select).toHaveValue('softer');
    expect(vi.mocked(voicePreviewApi.request).mock.calls.filter(([r])=>r.action==='prepare_proposal')).toHaveLength(count);
    expect(builtinApi.request).not.toHaveBeenCalledWith(expect.objectContaining({action:'apply_proposal'}));
});


it.each(['newCandidate', 'reopen'] as const)('旧取消の遅い失敗は%s後の正常なflowを無効化しない', async boundary => {
    let rejectCancel!: (reason: Error) => void;
    let preparedCount = 0;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'cancel_candidate' && request.candidateId === 'old') {
            return new Promise((_, reject) => { rejectCancel = reject; });
        }
        if (request.action === 'prepare_proposal') prepared = candidateFor(request, ++preparedCount === 1 ? 'old' : 'new');
        return previewSnapshot(request, { epoch: 'preview1', recordingId: 9, candidate: prepared, state: request.action === 'close' ? 'closed' : 'idle' });
    });
    const basis = { epoch: 'builtin1', revision: '4', draftRevision: 0 };
    const preferences = { preferences: { ...defaultProposalPreferences }, preferencesRevision: 1 };
    const { result } = renderHook(() => useVoiceCheck(true, undefined, basis));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('preview1'));
    await act(async () => { await result.current.prepareProposal(basis, preferences); });
    expect(result.current.candidate?.id).toBe('old');
    const oldSession = result.current.preview?.sessionId;
    act(() => result.current.invalidateProposalPreferences());
    await waitFor(() => expect(rejectCancel).toBeDefined());
    if (boundary === 'reopen') {
        await act(async () => { await result.current.preparePreview(); });
        expect(result.current.preview?.sessionId).not.toBe(oldSession);
    }
    // 希望revisionが同じ再準備も、別のflowとして隔離する。
    await act(async () => { await result.current.prepareProposal(basis, preferences); });
    expect(result.current.candidate?.id).toBe('new');
    await act(async () => { rejectCancel(new Error('old cancellation')); });
    expect(result.current.stopUnconfirmed).toBe(false);
    expect(result.current.previewError).toBe('');
    expect(result.current.candidate?.id).toBe('new');
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_candidate', candidateId: 'old' }));
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([request]) => request.action === 'cancel_candidate' && request.candidateId === 'new')).toBe(false);
});

it('現在flowの取消失敗は停止未確認の警告を保持する', async () => {
    let rejectCancel!: (reason: Error) => void;
    const originalRequest = vi.mocked(voicePreviewApi.request).getMockImplementation()!;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'cancel_candidate') return new Promise((_, reject) => { rejectCancel = reject; });
        return originalRequest(request);
    });
    const basis = { epoch: 'builtin1', revision: '4', draftRevision: 0 };
    const { result } = renderHook(() => useVoiceCheck(true, undefined, basis));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('preview1'));
    await act(async () => { await result.current.prepareProposal(basis); });
    act(() => result.current.invalidateProposalPreferences());
    await waitFor(() => expect(rejectCancel).toBeDefined());
    await act(async () => { rejectCancel(new Error('current cancellation')); });
    expect(result.current.stopUnconfirmed).toBe(true);
    expect(result.current.previewError).not.toBe('');
});
