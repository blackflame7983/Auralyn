"""明示計画の実sidecarを連続運転する。物理遅延・聴感の検査は含まない。"""
import hashlib
import json
from pathlib import Path
import sys
import time

from native_audio_probe import Probe, validate_duration


def validate_progress(previous, current, expected_plugins):
    """停止したcallbackや設定の逸脱を、エラーイベントの有無と独立に拒否する。"""
    if current['active_plugin_count'] != expected_plugins or current['enabled_plugin_count'] != expected_plugins or not current['latency_metadata']['streamRunning']:
        raise ValueError('Chain stopped or plugins disappeared')
    before, after = previous['queue_diagnostics'], current['queue_diagnostics']
    if after['state'] != 'running' or before['epoch'] != after['epoch']:
        raise ValueError('Audio stream epoch changed')
    for key in ['receivedInputFrames', 'requestedOutputFrames', 'consumedOutputFrames']:
        if after[key] <= before[key]:
            raise ValueError(f'Audio callbacks did not advance: {key}')
    if after['zeroFilledOutputFrames'] != before['zeroFilledOutputFrames'] or after['droppedOutputFrames'] != before['droppedOutputFrames']:
        raise ValueError('Audio queue lost frames')


def run(binary, plan, output):
    seconds = plan['durationSeconds']
    validate_duration(seconds)
    output.mkdir(parents=True, exist_ok=False)
    result = {'plan': plan, 'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'binary': str(binary), 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'status': 'failed', 'windows': [], 'boundary': 'Queue/callback diagnostics; no physical roundtrip or continuous WAV evidence'}
    probe = Probe(binary, output)

    def request(command, expected):
        response = probe.request(command)
        if response.get('type') != expected:
            raise RuntimeError(f"{command['type']}: {response}")
        return response.get('payload')

    try:
        result['started'] = request(plan['start'], 'Started')
        result['setup'] = [request(item['command'], item['expected']) for item in plan['setup']]
        time.sleep(2)
        result['initialStats'] = request({'type': 'GetRuntimeStats'}, 'RuntimeStats')
        if result['initialStats']['active_plugin_count'] != plan['expectedPlugins']:
            raise RuntimeError('Expected active plugins not observed')
        begin = time.perf_counter()
        previous_stats = result['initialStats']
        while time.perf_counter() - begin < seconds:
            measurement = probe.measure(min(30, max(.1, seconds - (time.perf_counter() - begin))))
            stats = request({'type': 'GetRuntimeStats'}, 'RuntimeStats')
            validate_progress(previous_stats, stats, plan['expectedPlugins'])
            previous_stats = stats
            result['windows'].append({'elapsedSeconds': time.perf_counter() - begin, 'measurement': measurement, 'stats': stats})
            (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print('STABILITY', round(time.perf_counter() - begin, 1), '/', seconds, 'zero', stats['queue_diagnostics']['zeroFilledOutputFrames'], flush=True)
        result['elapsedSeconds'] = time.perf_counter() - begin
        result['finalStats'] = result['windows'][-1]['stats']
        before = result['initialStats']['queue_diagnostics']
        after = result['finalStats']['queue_diagnostics']
        result['queueDelta'] = {key: after[key] - before[key] for key in before if isinstance(before[key], int) and not isinstance(before[key], bool)}
        request({'type': 'Stop'}, 'Success')
        if after['zeroFilledOutputFrames'] != before['zeroFilledOutputFrames']:
            raise RuntimeError('Queue underflow increased during continuous run')
        result['status'] = 'success'
    except Exception as error:
        result['failure'] = str(error)
    finally:
        probe.close()
        result.update(exitCode=probe.child.returncode, errors=probe.errors, events=dict(probe.events))
        if probe.child.returncode != 0 or probe.errors:
            result['status'] = 'failed'
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


if __name__ == '__main__':
    outcome = run(Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text(encoding='utf-8-sig')), Path(sys.argv[3]))
    print('STABILITY_RESULT', outcome['status'], outcome.get('failure', ''), flush=True)
    raise SystemExit(0 if outcome['status'] == 'success' else 1)
