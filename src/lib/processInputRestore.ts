import { audioApi } from '@/api/audio';
import type { InputSource, InputSourceRequest } from './inputSource';

/** アプリの音声は、いま起動しているアプリの候補を引き直さないと再開できない。起動していなければ null。 */
export async function resumableInputSource(source: InputSource): Promise<InputSourceRequest | null> {
    if (source.kind !== 'process_loopback') return { source };
    const appKey = source.config.appKey.toLowerCase();
    const found = (await audioApi.processInputSources()).find(candidate => candidate.appKey.toLowerCase() === appKey);
    return found ? { source, candidateId: found.id } : null;
}
