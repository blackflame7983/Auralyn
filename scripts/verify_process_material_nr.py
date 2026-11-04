"""実素材の声用途と、制御音を使った機器／プロセス間の学習結果の分離を実Engineで確認する。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

from verify_process_app_soak import identity, record, sample
from verify_process_audio_engine import Engine
from verify_process_loopback_probe import execute, start_source, stop_owned
from verify_process_loopback_route import wait_ready


def verify(args, root: Path, result: dict) -> None:
    before = json.loads(execute(args.probe, ['endpoints'], root, 'before').stdout)
    devices = {device['id']: device for device in before}
    raw, output = [devices[value] for value in [args.raw_endpoint, args.output_endpoint]]
    cable = next(device for device in before if device['name'] == 'CABLE Input (VB-Audio Virtual Cable)')
    if len({raw['id'], cable['id'], output['id']}) != 3:
        raise RuntimeError('原音、制御音、返しの出力先は分けてください')
    if raw['default_roles'] or raw['active_processes']:
        raise RuntimeError('未使用・非既定の原音用出力だけを指定してください')
    if cable['muted'] or cable['active_processes'] or cable['default_roles']:
        raise RuntimeError('未使用・非既定・ミュート解除済みのCABLE Inputが必要です')
    result['before'] = before
    result['engineSha256'] = hashlib.sha256(args.engine.read_bytes()).hexdigest()
    result['materialSha256'] = hashlib.sha256(args.material.read_bytes()).hexdigest()
    guard = source = engine = None
    browsers, handles = [], []
    ready = root / 'guard.ready.json'

    def start_browser(file: Path, index: int):
        directory = root / f'chrome-{index}'
        directory.mkdir()
        streams = [(directory / f'chrome.{suffix}').open('x', encoding='utf-8') for suffix in ['stdout', 'stderr']]
        handles.extend(streams)
        process = subprocess.Popen(['node', str(args.chrome_helper), str(directory), raw['name'], str(file), 'audio-element'],
                                   stdout=streams[0], stderr=streams[1], creationflags=subprocess.CREATE_NO_WINDOW)
        browsers.append((process, directory))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                state = json.loads((directory / 'chrome.ready.json').read_text(encoding='utf-8'))
                return process, directory, identity(state['pid'])
            except (FileNotFoundError, json.JSONDecodeError):
                if process.poll() is not None:
                    raise RuntimeError('専用Chromeが準備前に終了しました')
                time.sleep(0.05)
        raise TimeoutError('専用Chromeの準備が期限切れです')

    def close_browser(process, directory):
        (directory / 'chrome.stop').touch(exist_ok=True)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            stop_owned(process)
            raise

    def start(payload, nr_active):
        engine.request({'type': 'SetNoiseControlConfig', 'payload': {
            'active': nr_active, 'mode': 'low', 'strength': 0.8, 'voice_guard': True}})
        response = engine.request({'type': 'Start', 'payload': payload})
        observed = sample(engine, 0.7)
        if observed['inputPeak'] <= 0 or observed['outputPeak'] != 0:
            raise RuntimeError('取得信号と無音の返しを確認できません')
        return {'response': response, **observed}

    def process_payload(target, purpose):
        return {'host': 'WASAPI', 'output_id': 'wasapi:' + output['id'], 'sample_rate': 48000, 'buffer_size': 512,
                'input_source': {'source': {'kind': 'process_loopback', 'config': {
                    'appKey': target['appKey'], 'appName': target['name'], 'rawEndpointId': raw['id'], 'purpose': purpose}},
                    'target': {'pid': target['pid'], 'created': target['created']}}}

    def snapshot():
        return engine.request({'type': 'NoiseMeasurement', 'payload': {'request': {'action': 'snapshot'}}})['payload']

    def approve_controlled_noise(expected_identity):
        # 人の声を含まない制御音だけを測定・承認する。配信素材は承認に使わない。
        current = snapshot()
        engine.request({'type': 'NoiseMeasurement', 'payload': {'request': {
            'action': 'start', 'epoch': current['epoch'], 'generation': current['generation']}}})
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            sample(engine, 0.2)
            current = snapshot()
            if current['state'] == 'review':
                break
            if current['state'] in ['invalid', 'stale']:
                raise RuntimeError('制御音の学習が無効です: ' + json.dumps(current))
        else:
            raise TimeoutError('制御音の学習が期限切れです')
        if current['conditions']['inputId'] != expected_identity:
            raise RuntimeError('学習結果の入力識別が一致しません')
        current = engine.request({'type': 'NoiseMeasurement', 'payload': {'request': {
            'action': 'approve', 'epoch': current['epoch'], 'generation': current['generation'],
            'acknowledgedQuiet': True}}})['payload']
        if not current['usable'] or current['state'] != 'approved':
            raise RuntimeError('制御音の学習を承認できません')
        return current

    def assert_device_retained(original, name):
        observed = sample(engine, 0.3)
        state = snapshot()
        result[name] = {'snapshot': state, 'runtime': observed['runtime']}
        if abs(state['rms'] - original['rms']) > 1e-7 or abs(state['appliedMix'] - original['appliedMix']) > 1e-7:
            raise RuntimeError('機器側の学習値が入力切替後に保持されませんでした')
        if state['usable']:
            raise RuntimeError('入力切替前の測定を確認済みのまま再利用しています')

    try:
        guard_logs = [(root / f'guard.{suffix}').open('x', encoding='utf-8') for suffix in ['stdout', 'stderr']]
        handles.extend(guard_logs)
        guard = subprocess.Popen([str(args.probe), 'hold-endpoint-muted', raw['id'], '240', str(ready)],
                                 stdout=guard_logs[0], stderr=guard_logs[1], creationflags=subprocess.CREATE_NO_WINDOW)
        wait_ready(guard, ready)
        engine_dir = root / 'engine'
        engine_dir.mkdir()
        engine = Engine(args.engine, engine_dir)
        engine.request({'type': 'SetGlobalMute', 'payload': {'active': True}})
        token = engine.request({'type': 'BeginDeviceScan'})['payload']['token']
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = engine.request({'type': 'PollDeviceScan', 'payload': {'token': token}})['payload']['status']
            if status['status'] == 'Completed':
                inputs = [device for device in status['data'] if device['is_input'] and device['host'].lower() == 'wasapi'
                          and (device['name'] == 'CABLE Output' or device['name'].startswith('CABLE Output ['))]
                break
            if status['status'] != 'Pending':
                raise RuntimeError('音声機器の列挙に失敗しました')
            time.sleep(0.05)
        else:
            raise TimeoutError('音声機器の列挙が期限切れです')
        if len(inputs) != 1:
            raise RuntimeError('制御用の機器入力を一意に選べません')
        device = inputs[0]
        device_start = {'host': 'WASAPI', 'input_id': device['id'], 'output_id': 'wasapi:' + output['id'],
                        'sample_rate': 48000, 'buffer_size': 512,
                        'input_source': {'source': {'kind': 'device', 'config': {'purpose': 'voice'}}, 'target': None}}
        source, _, _ = start_source(args.probe, root, 'source-low-volume', 150, cable['id'], 733)
        result['deviceStarted'] = start(device_start, False)
        accepted_device = approve_controlled_noise(device['id'])
        result['deviceAccepted'] = accepted_device
        engine.request({'type': 'Stop'})

        browser, directory, target = start_browser(args.material, 1)
        result['materialStarted'] = start(process_payload(target, 'voice'), False)
        if result['materialStarted']['response']['payload'].get('input_id') is not None:
            raise RuntimeError('プロセス入力で機器入力を開いています')
        result['materialRecordings'] = []
        for active in [False, True, False]:
            index = len(result['materialRecordings']) + 1
            engine.request({'type': 'SetNoiseControlConfig', 'payload': {
                'active': active, 'mode': 'low', 'strength': 0.8, 'voice_guard': True}})
            observed = sample(engine, 0.5)
            if observed['runtime']['noise_reduction_active'] != active:
                raise RuntimeError('声の用途でNRの切替が反映されません')
            engine.request({'type': 'StartVoiceCheckRecording', 'payload': {'max_ms': 4000}})
            recorded = sample(engine, 4.4)
            paths = [root / f'material-{index}-{kind}.wav' for kind in ['raw', 'processed']]
            for kind, path in zip(['raw', 'processed'], paths):
                engine.request({'type': 'ExportVoiceCheck', 'payload': {'path': str(path), 'source': kind}})
            raw_samples, rate = sf.read(paths[0], dtype='float32', always_2d=True)
            processed, processed_rate = sf.read(paths[1], dtype='float32', always_2d=True)
            if raw_samples.shape != (192000, 2) or processed.shape != raw_samples.shape or rate != processed_rate or rate != 48000:
                raise RuntimeError('実素材の録音形式・長さが一致しません')
            if not np.isfinite(raw_samples).all() or not np.isfinite(processed).all() or np.max(np.abs(raw_samples)) <= 1e-5:
                raise RuntimeError('実素材の録音が無音または不正です')
            identical = bool(np.array_equal(raw_samples, processed))
            if identical == active:
                raise RuntimeError('NRの有無と加工前後の差が一致しません')
            if recorded['runtime']['process_input']['failed'] or recorded['outputPeak'] != 0:
                raise RuntimeError('プロセス取得か無音の返しを確認できません')
            result['materialRecordings'].append({'nrActive': active, 'rawProcessedIdentical': identical,
                'frames': len(raw_samples), 'sampleRate': rate, 'rawPeak': float(np.max(np.abs(raw_samples))),
                'processedPeak': float(np.max(np.abs(processed))), 'runtime': recorded['runtime']})
        engine.request({'type': 'Stop'})
        close_browser(browser, directory)
        start(device_start, False)
        assert_device_retained(accepted_device, 'deviceAfterMaterial')
        engine.request({'type': 'Stop'})

        invalid_target = {**target, 'created': target['created'] + 1}
        try:
            engine.request({'type': 'Start', 'payload': process_payload(invalid_target, 'voice')})
        except RuntimeError as error:
            result['failedStartRejected'] = str(error)
        else:
            raise RuntimeError('終了した対象・不正な生成時刻を拒否しません')
        start(device_start, False)
        assert_device_retained(accepted_device, 'deviceAfterFailedStart')
        engine.request({'type': 'Stop'})

        tone = root / 'controlled-noise.wav'
        frames = np.arange(48000 * 8, dtype='float64')
        values = (np.sin(frames * (2 * np.pi * 997 / 48000)) * 0.012).astype('float32')
        sf.write(tone, np.column_stack((values, values)), 48000, subtype='FLOAT')
        browser, directory, target = start_browser(tone, 2)
        start(process_payload(target, 'voice'), False)
        accepted_process = approve_controlled_noise('process:' + target['appKey'])
        result['processAccepted'] = accepted_process
        if abs(accepted_process['rms'] - accepted_device['rms']) <= 0.001:
            raise RuntimeError('比較する学習値の差が小さすぎます')
        engine.request({'type': 'Stop'})
        start(device_start, False)
        assert_device_retained(accepted_device, 'deviceAfterProcessApproval')
        engine.request({'type': 'Stop'})
        start(process_payload(target, 'voice'), False)
        restored = snapshot()
        if abs(restored['rms'] - accepted_process['rms']) > 1e-7 or abs(restored['appliedMix'] - accepted_process['appliedMix']) > 1e-7:
            raise RuntimeError('プロセス側の学習値を復帰できません')
        if restored['usable']:
            raise RuntimeError('再開始時に古い測定を確認済みにしています')
        result['processRestored'] = restored
        engine.request({'type': 'Stop'})
        result['musicStarted'] = start(process_payload(target, 'music'), True)
        if result['musicStarted']['runtime']['noise_reduction_active']:
            raise RuntimeError('音楽用途にNRが適用されています')
        try:
            engine.request({'type': 'StartNoiseLearning', 'payload': {'duration_ms': 1000}})
        except RuntimeError as error:
            result['musicLearningRejected'] = str(error)
        else:
            raise RuntimeError('音楽用途で声向け学習を拒否しません')
        engine.request({'type': 'Stop'})
    finally:
        if engine is not None:
            engine.close()
        for browser, directory in browsers:
            if browser.poll() is None:
                close_browser(browser, directory)
        if source is not None:
            stop_owned(source)
        if guard is not None:
            stop_owned(guard)
        journal = ready.with_suffix('.restore.json')
        if journal.exists():
            restored = execute(args.probe, ['restore-endpoint', str(journal)], root, 'restore')
            if restored.returncode:
                raise RuntimeError('原音用の出力先を復元できません')
        for handle in handles:
            handle.close()
        after = {device['id']: device for device in json.loads(execute(args.probe, ['endpoints'], root, 'after').stdout)}
        result['endpointStatePreserved'] = all(device[key] == after[device['id']][key]
            for device in before for key in ['muted', 'volume', 'default_roles'])
        if not result['endpointStatePreserved']:
            raise RuntimeError('再生先の設定が試験前と一致しません')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['engine', 'probe', 'material', 'raw-endpoint', 'output-endpoint', 'output-dir']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--chrome-helper', type=Path, default=Path('scripts/process-loopback-chrome-source.mjs'))
    args = parser.parse_args()
    for name in ['engine', 'probe', 'material', 'chrome_helper']:
        setattr(args, name, Path(getattr(args, name)).resolve(strict=True))
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=False)
    result = {'passed': False, 'physicalMicrophoneOpened': False, 'audibleMonitorTested': False,
              'deviceLearningFixture': 'WASAPI CABLE Output with owned controlled tone'}
    try:
        verify(args, root, result)
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
    record(root / 'summary.json', result)
    print(json.dumps({'directory': str(root), 'passed': result['passed'], 'error': result.get('error')}, ensure_ascii=False))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
