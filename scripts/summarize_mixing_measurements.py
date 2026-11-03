"""保存した二入力試験を同じ基準で集計する。聴感やOBS到達の合否は判定しない。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def summarize(root: Path) -> dict:
    summary = json.loads((root / 'summary.json').read_text(encoding='utf-8'))
    rows = [json.loads(line) for line in (root / 'samples.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
    if not summary.get('passed') or not summary.get('endpointStatePreserved') or len(rows) < 2:
        raise ValueError(f'完了・端点復元・複数観測を確認できません: {root}')
    if any(a['elapsedSeconds'] >= b['elapsedSeconds'] for a, b in zip(rows, rows[1:])):
        raise ValueError(f'観測時刻が増加しません: {root}')

    def values(*keys):
        result = []
        for row in rows:
            for key in keys:
                row = row[key]
            result.append(row)
        return result

    def delta(*keys):
        data = values(*keys)
        if any(a > b for a, b in zip(data, data[1:])):
            raise ValueError(f'固定運転中にカウンターが戻りました: {root}, {keys}')
        return data[-1] - data[0]

    def span(*keys):
        data = values(*keys)
        known = [value for value in data if value is not None]
        result = {'min': min(known) if known else None, 'max': max(known) if known else None}
        if len(known) != len(data): result['unknownObservations'] = len(data)-len(known)
        return result

    if len(set(values('mixing', 'epoch'))) != 1 or len(set(values('mixing', 'revision'))) != 1:
        raise ValueError(f'集計窓に運転・調整の切替が含まれています: {root}')
    active = (summary.get('conditions') or {}).get('activeProcessing', False)
    if active:
        if any(values('runtime', 'preparation', 'muted')) or any(values('runtime', 'preparation', 'outputGain')) or any(values('runtime', 'preparation', 'controlsPending')):
            raise ValueError(f'VSTを動かした無音試験の条件が変わっています: {root}')
        if not all(value>0 for value in values('meterEvents')) or any(values('outputPeak')):
            raise ValueError(f'メーター観測または出力ゼロの確認が成立しません: {root}')
    elif not all(values('runtime', 'preparation', 'muted')):
        raise ValueError(f'試験中に全体ミュートが解除されています: {root}')
    if any(values('mixing', 'failed')) or any(values('mixing', 'accompaniment', 'failed')):
        raise ValueError(f'試験中の音声停止を検出しました: {root}')
    callbacks = delta('runtime', 'queue_diagnostics', 'queueReadCallbacks')
    frames = delta('runtime', 'queue_diagnostics', 'requestedOutputFrames')
    result = {
        'root': str(root), 'engineSha256': summary['engineSha256'],
        'accompanimentFixtureSha256': summary.get('accompanimentFixtureSha256'),
        'conditions': summary.get('conditions'), 'observations': len(rows),
        'sampleWindowSeconds': rows[-1]['elapsedSeconds']-rows[0]['elapsedSeconds'],
        'mainCpuPercentOfOneCore': summary['engineCpuPercentOfOneCore'],
        'totalCpuPercentOfOneCore': summary.get('totalCpuPercentOfOneCore', summary['engineCpuPercentOfOneCore']),
        'reportedCadence': {
            'context': (summary.get('conditions') or {}).get('cadenceContext', 'unknown'),
            'lateCountDelta': delta('runtime', 'glitch_count'),
            'maxLateUsSinceStart': rows[-1]['runtime']['max_jitter_us'],
        },
        'inputDelivery': {
            'callbacksDelta': callbacks, 'requestedFramesDelta': frames,
            'averageRequestedFramesPerCallback': frames/callbacks if callbacks else None,
            'zeroFilledFramesDelta': delta('runtime', 'queue_diagnostics', 'zeroFilledOutputFrames'),
            'underflowCallbacksDelta': delta('runtime', 'queue_diagnostics', 'underflowCallbacks'),
            'recoveryDiscardedFramesDelta': delta('runtime', 'queue_diagnostics', 'recoveryDiscardedFrames'),
            'primaryUnderrunsDelta': delta('mixing', 'primaryClock', 'underruns'),
            'primaryQueuedFrames': span('mixing', 'primaryClock', 'queuedFrames'),
            'primaryCorrectionPpm': span('mixing', 'primaryClock', 'correctionPpm'),
        },
        # 分離時の処理時間は配信workerの値。上のOS callback間隔とは母集団が異なる。
        'dspProcessing': {
            'context': rows[-1]['runtime']['latency_metadata']['processingContext'],
            'blocksDelta': delta('runtime', 'callback_diagnostics', 'count'),
            'processingUsDelta': delta('runtime', 'callback_diagnostics', 'totalProcessingUs'),
            'maxProcessingUsSinceStart': rows[-1]['runtime']['callback_diagnostics']['maxProcessingUs'],
        },
        'accompaniment': {
            'queuedFrames': span('mixing', 'accompaniment', 'queuedFrames'),
            'correctionPpm': span('mixing', 'accompaniment', 'correctionPpm'),
            **{key+'Delta': delta('mixing', 'accompaniment', key) for key in [
                'capturedFrames', 'nonzeroFrames', 'pauseResets', 'waitingDiscardedFrames',
                'discontinuities', 'timestampErrors', 'nonfiniteSamples']},
        },
        'endpointStatePreserved': True,
    }
    if 'systemCpuPercentAllCores' in rows[0]:
        result['systemCpuPercentAllCores'] = span('systemCpuPercentAllCores')
    if 'postMix' in rows[0]:
        if not all(values('postMix', 'ready')) or any(values('postMix', 'failed')):
            raise ValueError(f'配信VSTの停止を検出しました: {root}')
        result['postMix'] = {
            'transportFrames': span('postMix', 'transport_latency_frames'),
            'declaredPluginFrames': span('postMix', 'declared_plugin_latency_frames'),
        }
        if active:
            packets = values('postMix', 'processed_packets')
            if any(a >= b for a, b in zip(packets, packets[1:])):
                raise ValueError(f'配信VSTの処理が進行していません: {root}')
            result['postMix']['processedPacketsDelta'] = delta('postMix', 'processed_packets')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('roots', nargs='+', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = {'measurements': [summarize(root.resolve(strict=True)) for root in args.roots],
              'audibleAcceptance': False, 'obsAcceptance': False}
    # 過去の計測原本・集計は上書きしない。
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(str(args.output.resolve()))


if __name__ == '__main__':
    main()
