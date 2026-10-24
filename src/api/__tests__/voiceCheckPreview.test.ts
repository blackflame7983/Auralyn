import { FixedClientError } from '@/lib/clientError';
import { afterEach, expect, it, vi } from 'vitest';
import { createVoicePreviewSession, voicePreviewApi } from '../voiceCheckPreview';
import { previewSnapshot } from '../../components/features/VoiceCheck/__tests__/previewFixture';
afterEach(() => vi.restoreAllMocks());
it('clientIdは同一runtimeで共有し、sessionは進め、readonly要求で操作IDを進めない', async () => {
    const request = vi.spyOn(voicePreviewApi, 'request').mockImplementation(async value => previewSnapshot(value));
    const first = createVoicePreviewSession();
    await first.send({ action: 'open' });
    await first.send({ action: 'status' });
    await first.send({ action: 'devices' });
    await first.send({ action: 'stop' });
    const second = createVoicePreviewSession();
    await second.send({ action: 'open' });
    const calls = request.mock.calls.map(([value]) => value);
    expect(calls.map(value => value.operationId)).toEqual([1, 1, 1, 2, 1]);
    expect(calls[1].epoch).toBe('engine-epoch');
    expect(calls[4].sessionId).toBeGreaterThan(calls[0].sessionId);
    expect(calls[4].clientId).toBe(calls[0].clientId);
});
it('open応答前でもepochなしでcloseでき、遅いopenから操作を再開しない', async () => {
    let resolve!: (value: ReturnType<typeof previewSnapshot>) => void;
    let opened!: Parameters<typeof previewSnapshot>[0];
    const request = vi.spyOn(voicePreviewApi, 'request').mockImplementation(value => {
        if (value.action === 'open') { opened = value; return new Promise(done => { resolve = done; }); }
        return Promise.resolve(previewSnapshot(value));
    });
    const session = createVoicePreviewSession();
    const opening = session.send({ action: 'open' });
    await session.send({ action: 'close' });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'close', epoch: null, operationId: 2 }));
    resolve(previewSnapshot(opened));
    await opening;
    expect(session.ready).toBe(false);
    await expect(session.send({ action: 'status' })).rejects.toThrow('再準備');
});


it('candidate_statusは操作IDを進めず、Startは候補IDを同じsessionへ渡す', async () => {
    const request = vi.spyOn(voicePreviewApi, 'request').mockImplementation(async value => previewSnapshot(value));
    const session = createVoicePreviewSession();
    await session.send({ action: 'open' });
    await session.send({ action: 'candidate_status', candidateId: 'candidate-1' });
    await session.send({ action: 'start', recordingId: 9, deviceId: 'hp', candidateId: 'candidate-1', source: 'processed', loopPlayback: true, levelMatch: false });
    expect(request.mock.calls.map(([value]) => value.operationId)).toEqual([1, 1, 2]);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ candidateId: 'candidate-1', epoch: 'engine-epoch' }));
});


it('closed/不一致snapshotはcanonical errorを保ち、閉じた後は要求を送らない', async()=>{
    const request=vi.spyOn(voicePreviewApi,'request').mockImplementation(async value=>previewSnapshot(value));
    const session=createVoicePreviewSession();await session.send({action:'close'});
    const calls=request.mock.calls.length;
    const closed=await session.send({action:'status'}).catch(error=>error);
    expect(closed).toBeInstanceOf(FixedClientError);expect(closed.code).toBe('preview.closed');
    expect(closed.toString()).toBe('Error: 試聴画面を再準備してください。');expect(request).toHaveBeenCalledTimes(calls);
    request.mockImplementation(async value=>previewSnapshot({...value,sessionId:value.sessionId+1}));
    const other=createVoicePreviewSession();const invalid=await other.send({action:'open'}).catch(error=>error);
    expect(invalid.code).toBe('preview.invalidSnapshot');expect(other.ready).toBe(false);
});
