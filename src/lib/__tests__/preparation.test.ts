import { beforeEach, expect, it } from 'vitest';
import { buildPreparationObservation, confirmationState, emptyObservation, expireConfirmations, nextPreparationStage, readPreparationContext, savePreparationContext, type Confirmations } from '../preparation';

import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
const observe = (stats = runtime(), ctx = context, live = liveStatus) => buildPreparationObservation(audioState, stats, live, ctx);
const confirmations = (): Confirmations => Object.fromEntries(Object.entries(observe().keys!).map(([stage, key]) => [stage, { key, at: 1, target: 'Mic', expired: false }]));
beforeEach(() => localStorage.clear());

it('保存するのは条件だけで、起動時の確認記録や不正な用途を復元しない', () => {
    savePreparationContext(context);
    expect(readPreparationContext()).toEqual(context);
    localStorage.setItem('vst_host_setup_goal', 'invalid');
    expect(readPreparationContext().usage).toBe('');
    localStorage.setItem('auralyn_preparation_context', '{');
    expect(readPreparationContext()).toEqual({ location: 'home', usage: '', signal: 'unknown', receiver: '' });
});
it('旧local用途を試聴へ読み替え、用途が一致しない送り先は引き継がない', () => {
    savePreparationContext(context);
    localStorage.setItem('vst_host_setup_goal', 'local');
    expect(readPreparationContext()).toMatchObject({ usage: 'listening', receiver: '' });
});
it('用途を未選択へ戻したときは共用キーも消し、再起動で以前の用途を復活させない', () => {
    savePreparationContext({ ...context, usage: 'obs' });
    savePreparationContext({ ...context, usage: '', receiver: '' });
    expect(localStorage.getItem('vst_host_setup_goal')).toBeNull();
    expect(readPreparationContext().usage).toBe('');
});
it('稼働とメーターだけでは利用者の確認済みにしない', () => {
    expect(observe().availability).toBe('ready');
    expect(nextPreparationStage(observe(), {}, context)).toBe('sound');
    expect(nextPreparationStage(observe(), {}, { ...context, usage: '' })).toBe('purpose');
    expect(nextPreparationStage(observe(), confirmations(), context)).toBe('done');
});
it.each(['inputGain', 'processingRevision', 'nrBackend', 'nrModel', 'engineEpoch'] as const)('%s変更は音作りから再確認し、A→B→Aで復活させない', field => {
    const stats = runtime();
    Object.assign(stats.preparation!, { [field]: field === 'inputGain' ? 1.1 : 'changed' });
    const expired = expireConfirmations(confirmations(), observe(stats));
    for (const stage of ['sound', 'listen', 'receiver'] as const) expect(confirmationState(expired, stage)).toBe('stale');
    expect(confirmationState(expireConfirmations(expired, observe()), 'sound')).toBe('stale');
});
it.each(['outputGain', 'routingRevision', 'outputRevision', 'muted'] as const)('出力の%s変更では音作り確認を保持し試聴以降だけ失効する', field => {
    const stats = runtime();
    Object.assign(stats.preparation!, { [field]: field === 'muted' ? true : field === 'outputGain' ? .8 : 'changed', controlsPending: true });
    const expired = expireConfirmations(confirmations(), observe(stats));
    expect(confirmationState(expired, 'sound')).toBe('confirmed');
    expect(confirmationState(expired, 'listen')).toBe('stale');
    expect(confirmationState(expired, 'receiver')).toBe('stale');
    expect(observe(stats).availability).toBe('pending');
});
it.each([{ usage: 'obs' }, { receiver: 'Other input' }] as const)('用途・受け側変更では受け側だけ再確認する: %o', patch => {
    const expired = expireConfirmations(confirmations(), observe(runtime(), { ...context, ...patch }));
    expect(confirmationState(expired, 'sound')).toBe('confirmed');
    expect(confirmationState(expired, 'listen')).toBe('confirmed');
    expect(confirmationState(expired, 'receiver')).toBe('stale');
});
it('場内の経路変更・ストリーム再開・出力障害は成功表示を保持しない', () => {
    expect(confirmationState(expireConfirmations(confirmations(), observe(runtime(), { ...context, location: 'venue' })), 'sound')).toBe('stale');
    const stats = runtime(); stats.latencyMetadata!.streamEpoch = '2';
    expect(confirmationState(expireConfirmations(confirmations(), observe(stats)), 'sound')).toBe('stale');
    expect(observe(runtime(), context, { ...liveStatus, error: 'lost' }).availability).toBe('failed');
    expect(observe(runtime(), context, { ...liveStatus, config: { ...liveStatus.config, splitProcessing: true } }).availability).toBe('failed');
    expect(confirmationState(expireConfirmations(confirmations(), emptyObservation()), 'sound')).toBe('stale');
});
it.each([{ host: 'ASIO' }, { input: 'Other mic' }, { sample_rate: 44100 }, { buffer_size: 512 }])('入力条件変更は全段階を再確認する: %o', config => {
    const observation = buildPreparationObservation({ ...audioState, config: { ...audioState.config!, ...config } }, runtime(), liveStatus, context);
    const expired = expireConfirmations(confirmations(), observation);
    for (const stage of ['sound', 'listen', 'receiver'] as const) expect(confirmationState(expired, stage)).toBe('stale');
});
it('同じ入力の出力先変更と分離設定は試聴以降だけを失効し、ASIO入力ch変更は全段階を失効する', () => {
    const output = buildPreparationObservation({ ...audioState, config: { ...audioState.config!, output: 'Headphones' } }, runtime(), liveStatus, context);
    expect(confirmationState(expireConfirmations(confirmations(), output), 'sound')).toBe('confirmed');
    expect(confirmationState(expireConfirmations(confirmations(), output), 'listen')).toBe('stale');
    const split = observe(runtime(), context, { ...liveStatus, config: { ...liveStatus.config, monitorMuted: true } });
    expect(confirmationState(expireConfirmations(confirmations(), split), 'sound')).toBe('confirmed');
    expect(confirmationState(expireConfirmations(confirmations(), split), 'listen')).toBe('stale');
    const channels = runtime(); channels.preparation!.inputChannels = [2, 3];
    expect(confirmationState(expireConfirmations(confirmations(), observe(channels)), 'sound')).toBe('stale');
});
it('旧エンジン・不正snapshotは不明、ミュートは確認操作を許可しない', () => {
    const stats = runtime(); delete stats.preparation;
    expect(observe(stats).availability).toBe('unknown');
    stats.preparation = { ...runtime().preparation!, inputGain: NaN };
    expect(observe(stats).keys).toBeNull();
    stats.preparation = { ...runtime().preparation!, muted: true };
    expect(nextPreparationStage(observe(stats), confirmations(), context)).toBe('connect');
});

it('music は準備用途では listening として扱い、場所更新で元の目的を失わない', () => {
    localStorage.setItem('vst_host_setup_goal', 'music');
    const music = readPreparationContext();
    expect(music.usage).toBe('listening');
    savePreparationContext({ ...music, location: 'venue' });
    expect(localStorage.getItem('vst_host_setup_goal')).toBe('music');
});
