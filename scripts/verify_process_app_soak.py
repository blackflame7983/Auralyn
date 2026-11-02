"""Chrome/VLCと実Engine・実VSTを使う、通常設定から隔離した明示実行の連続試験。"""
from __future__ import annotations
import argparse
from array import array
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import time
import uuid
import wave
from verify_process_audio_engine import Engine
from verify_process_loopback_probe import execute, stop_owned
from verify_process_loopback_route import wait_ready


def fixture(path: Path) -> None:
    rate = 44100
    samples = array('h')
    notes = [220, 246.94165, 261.62557, 293.66477, 329.62756, 349.22823, 391.99544, 440]
    for frame in range(rate * 16):
        t = frame / rate
        frequency = notes[(frame // (rate * 2)) % len(notes)]
        envelope = min(1.0, (t % 2) * 25, (2 - t % 2) * 25)
        for factor in [1, 1.5]:
            signal = envelope * 0.0015 * (math.sin(math.tau * frequency * factor * t) + 0.25 * math.sin(math.tau * frequency * factor * 2 * t))
            samples.append(round(signal * 32767))
    with wave.open(str(path), 'wb') as output:
        output.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        output.writeframes(samples.tobytes())


def identity(pid: int) -> dict:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created, exited, system, user = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        length = wintypes.DWORD(32768)
        image = ctypes.create_unicode_buffer(length.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(length)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'pid': pid, 'created': (created.dwHighDateTime << 32) | created.dwLowDateTime,
                'image': image.value, 'name': Path(image.value).name,
                'appKey': hashlib.sha256(image.value.lower().encode()).hexdigest()}
    finally:
        kernel.CloseHandle(handle)


def record(path: Path, value: dict) -> None:
    temporary = path.with_suffix('.writing')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    # Windowsでは監視側の短い読み取りも置換と競合する。音声異常とは区別する。
    deadline = time.monotonic() + 3
    while True:
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def rc(port: int, command: str) -> str:
    with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
        connection.settimeout(0.2)
        try:
            connection.recv(65536)
        except socket.timeout:
            pass
        connection.sendall((command + '\n').encode())
        result = b''
        try:
            while True:
                block = connection.recv(65536)
                if not block:
                    break
                result += block
        except socket.timeout:
            pass
        return result.decode('utf-8', errors='replace')


def sample(engine: Engine, duration: float) -> dict:
    engine.events.clear()
    until = time.monotonic() + duration
    while time.monotonic() < until:
        try:
            engine.next(min(0.2, max(0.01, until - time.monotonic())))
        except queue.Empty:
            pass
    stats = engine.request({'type': 'GetRuntimeStats'})['payload']
    meters = [event['payload'] for event in engine.events if event['type'] == 'LevelMeter']
    result = {'runtime': stats, 'inputPeak': max((max(m['input']) for m in meters), default=0),
              'outputPeak': max((max(m['output']) for m in meters), default=0)}
    engine.events.clear()
    return result


def verify(args, root: Path, summary: dict) -> None:
    before = json.loads(execute(args.probe, ['endpoints'], root, 'before').stdout)
    raw = next(device for device in before if device['id'] == args.raw_endpoint)
    output = next(device for device in before if device['id'] == args.output_endpoint)
    if raw['default_roles'] or raw['active_processes'] or raw['id'] == output['id']:
        raise RuntimeError('未使用・非既定の原音用出力と、別の本人用出力を指定してください')
    fixture_path = root / 'stereo-44100.wav'
    fixture(fixture_path)
    summary.update({'raw': raw, 'output': output, 'fixtureSha256': hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
                    'engineSha256': hashlib.sha256(args.engine.read_bytes()).hexdigest(), 'vstSha256': hashlib.sha256(args.vst.read_bytes()).hexdigest()})
    guard_ready = root / 'muted.ready.json'
    handles = []
    def start(binary, arguments, name, environment=None):
        stdout = (root / (name + '.stdout')).open('x', encoding='utf-8')
        stderr = (root / (name + '.stderr')).open('x', encoding='utf-8')
        handles.extend([stdout, stderr])
        return subprocess.Popen([str(binary), *arguments], stdout=stdout, stderr=stderr, env=environment,
                                cwd=root, creationflags=subprocess.CREATE_NO_WINDOW)
    guard = start(args.probe, ['hold-endpoint-muted', raw['id'], str(args.seconds + 240), str(guard_ready)], 'guard')
    player = None
    engine = None
    try:
        summary['guard'] = wait_ready(guard, guard_ready)
        if args.kind == 'vlc':
            with socket.socket() as allocation:
                allocation.bind(('127.0.0.1', 0))
                port = allocation.getsockname()[1]
            environment = dict(os.environ, APPDATA=str(root / 'player-appdata'), LOCALAPPDATA=str(root / 'player-localdata'))
            player = start(args.vlc, ['--ignore-config', '--no-one-instance', '--no-media-library', '--no-metadata-network-access',
                '--intf=dummy', '--extraintf=rc', '--rc-quiet', '--rc-host=127.0.0.1:' + str(port),
                '--verbose=2', '--file-logging', '--logfile=' + str(root / 'vlc.log'), '--no-video', '--aout=mmdevice', '--mmdevice-backend=wasapi', '--mmdevice-audio-device=' + raw['id'], '--repeat', str(fixture_path)], 'player', environment)
            deadline = time.monotonic() + 15
            while True:
                try:
                    summary['playerStatus'] = rc(port, 'status')
                    break
                except OSError:
                    if time.monotonic() >= deadline or player.poll() is not None:
                        raise RuntimeError('VLCの制御接続を確認できません')
                    time.sleep(0.1)
            target = identity(player.pid)
            deadline = time.monotonic() + 20
            attempt = 0
            while True:
                attempt += 1
                current = json.loads(execute(args.probe, ['endpoints'], root, 'source-ready-' + str(attempt)).stdout)
                route = next(d for d in current if d['id'] == raw['id'])
                if player.pid in route['active_processes']:
                    summary['playerStatusReady'] = rc(port, 'status')
                    break
                if player.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('VLCの原音用出力への再生を確認できません')
                time.sleep(0.25)
        else:
            player = start(args.node, [str(args.chrome_helper), str(root), raw['name'], str(fixture_path), args.chrome_media_kind], 'player')
            ready = root / 'chrome.ready.json'
            deadline = time.monotonic() + 30
            while not ready.exists():
                if player.poll() is not None or time.monotonic() > deadline:
                    error = root / 'chrome.error.json'
                    raise RuntimeError(error.read_text(encoding='utf-8') if error.exists() else 'Chrome sourceの準備に失敗しました')
                time.sleep(0.1)
            browser = json.loads(ready.read_text(encoding='utf-8'))
            summary['browser'] = browser
            target = identity(browser['pid'])
        summary['target'] = target
        time.sleep(0.5)
        engine_dir = root / 'engine'
        engine_dir.mkdir()
        engine = Engine(args.engine, engine_dir)
        capability = engine.request({'type': 'ProcessInputCapability'})
        if capability.get('payload', {}).get('version') != 1:
            raise RuntimeError('Engineの入力形式が一致しません')
        loaded = engine.request({'type': 'LoadPlugin', 'payload': {'path': str(args.vst)}})
        if loaded['type'] != 'PluginLoaded':
            raise RuntimeError('VSTを読み込めません: ' + str(loaded))
        summary['plugin'] = loaded['payload']
        source = {'source': {'kind': 'process_loopback', 'config': {'appKey': target['appKey'], 'appName': target['name'],
            'rawEndpointId': raw['id'], 'purpose': 'music'}}, 'target': {'pid': target['pid'], 'created': target['created']}}
        started = engine.request({'type': 'Start', 'payload': {'host': 'WASAPI', 'output_id': 'wasapi:' + output['id'],
            'sample_rate': args.rate, 'buffer_size': 512, 'input_source': source}})
        summary['started'] = started
        normal = sample(engine, 2)
        if normal['inputPeak'] <= 0 or normal['outputPeak'] <= 0 or normal['runtime']['enabled_plugin_count'] != 1:
            raise RuntimeError('実アプリ→SRC→VST→出力の信号を確認できません')
        summary['initialSignal'] = normal
        if args.kind == 'vlc':
            summary['pauseCommand'] = rc(port, 'pause')
        else:
            record(root / 'chrome-control.json', {'action': 'pause', 'epoch': 1})
        summary['paused'] = sample(engine, 1.2)
        if args.kind == 'vlc':
            summary['playCommand'] = rc(port, 'pause')
        else:
            record(root / 'chrome-control.json', {'action': 'play', 'epoch': 2})
        resumed = sample(engine, 2)
        summary['resumed'] = resumed
        if resumed['inputPeak'] <= 0 or resumed['outputPeak'] <= 0:
            raise RuntimeError('実アプリの一時停止後に信号が戻りません')
        engine.request({'type': 'SetGlobalMute', 'payload': {'active': True}})
        sample(engine, 1)
        baseline = engine.request({'type': 'GetRuntimeStats'})['payload']
        began = time.monotonic()
        summary['steadyStartUnix'] = time.time()
        maximum_queue = 0
        minimum_queue = 16384
        min_correction = 2000
        max_correction = -2000
        last_signal = began
        previous_nonzero = baseline['process_input']['nonzeroFrames']
        with (root / 'samples.jsonl').open('x', encoding='utf-8') as log:
            while time.monotonic() - began < args.seconds:
                if player.poll() is not None:
                    raise RuntimeError('再生アプリが途中で終了しました')
                observation = sample(engine, min(2.0, args.seconds - (time.monotonic() - began)))
                elapsed = time.monotonic() - began
                stats = observation['runtime']
                process = stats.get('process_input')
                if not process or process['failed'] or process['nonfiniteSamples'] or stats['enabled_plugin_count'] != 1:
                    raise RuntimeError('連続運転中に取得・SRC・VSTの異常を検出しました')
                if process['nonzeroFrames'] > previous_nonzero:
                    last_signal = time.monotonic()
                if time.monotonic() - last_signal > 5:
                    raise RuntimeError('再生中の信号が5秒以上途絶えました')
                previous_nonzero = process['nonzeroFrames']
                maximum_queue = max(maximum_queue, process['queuedFrames'])
                minimum_queue = min(minimum_queue, process['queuedFrames'])
                min_correction = min(min_correction, process['correctionPpm'])
                max_correction = max(max_correction, process['correctionPpm'])
                status = {'elapsedSeconds': elapsed, 'requestedSeconds': args.seconds, 'kind': args.kind, 'process': process,
                    'glitchCount': stats['glitch_count'], 'maxJitterUs': stats['max_jitter_us'],
                    'inputPeak': observation['inputPeak'], 'outputPeak': observation['outputPeak'], 'enabledPlugins': stats['enabled_plugin_count']}
                log.write(json.dumps(status) + '\n')
                log.flush()
                try:
                    record(root / 'progress.json', status)
                except PermissionError:
                    # 詳細の追記ログは残るため、表示用snapshotの競合で連続運転を止めない。
                    summary['progressSnapshotContentions'] = summary.get('progressSnapshotContentions', 0) + 1
            final = stats
        summary.update({'steadyElapsedSeconds': time.monotonic() - began, 'baseline': baseline, 'final': final,
            'queueMin': minimum_queue, 'queueMax': maximum_queue, 'correctionMinPpm': min_correction,
            'correctionMaxPpm': max_correction, 'audibleMonitorTested': False})
        engine.request({'type': 'Stop'})
        engine.request({'type': 'UnloadPlugin', 'payload': {'id': loaded['payload']['id']}})
    finally:
        if engine is not None:
            engine.close()
        if args.kind == 'chrome':
            (root / 'chrome.stop').touch()
            if player is not None:
                try:
                    player.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    stop_owned(player)
        elif player is not None:
            stop_owned(player)
        stop_owned(guard)
        journal = guard_ready.with_suffix('.restore.json')
        if journal.exists():
            restore = execute(args.probe, ['restore-endpoint', str(journal)], root, 'restore')
            if restore.returncode:
                raise RuntimeError('出力デバイスの復元に失敗しました: ' + restore.stderr)
        for handle in handles:
            handle.close()
        after = {device['id']: device for device in json.loads(execute(args.probe, ['endpoints'], root, 'after').stdout)}
        # 同時実行する別caseの原音用ミュートは、このcaseの責務に含めない。
        summary['ownedEndpointRestored'] = all(after[raw['id']][key] == raw[key] for key in ['muted', 'volume', 'default_roles'])
        summary['outputEndpointPreserved'] = all(after[output['id']][key] == output[key] for key in ['muted', 'volume', 'default_roles'])
        if not summary['ownedEndpointRestored'] or not summary['outputEndpointPreserved']:
            raise RuntimeError('試験で扱った出力先の状態が復元されませんでした')


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=['chrome', 'vlc'], required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--probe', type=Path, required=True)
    parser.add_argument('--vst', type=Path, required=True)
    parser.add_argument('--raw-endpoint', required=True)
    parser.add_argument('--output-endpoint', required=True)
    parser.add_argument('--rate', type=int, default=48000)
    parser.add_argument('--seconds', type=int, default=3900)
    parser.add_argument('--vlc', type=Path, default=Path(r'C:\Program Files\VideoLAN\VLC\vlc.exe'))
    parser.add_argument('--node', default='node')
    parser.add_argument('--chrome-helper', type=Path, default=Path('scripts/process-loopback-chrome-source.mjs'))
    parser.add_argument('--chrome-media-kind', choices=['webaudio', 'audio-element'], default='webaudio')
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 6600:
        parser.error('--seconds は1〜6600秒です')
    for name in ['engine', 'probe', 'vst', 'chrome_helper']:
        setattr(args, name, getattr(args, name).resolve(strict=True))
    if args.kind == 'vlc':
        args.vlc = args.vlc.resolve(strict=True)
    root = (args.output_dir or Path('src-tauri/target/process-loopback-probe') / ('app-' + args.kind + '-' + uuid.uuid4().hex[:10])).resolve()
    root.mkdir(parents=True, exist_ok=False)
    print(json.dumps({'directory': str(root), 'kind': args.kind, 'requestedSeconds': args.seconds}), flush=True)
    summary = {'passed': False, 'kind': args.kind, 'requestedSeconds': args.seconds}
    try:
        verify(args, root, summary)
        summary['passed'] = True
    except Exception as error:
        summary['error'] = str(error)
    record(root / 'summary.json', summary)
    print(json.dumps({'directory': str(root), 'passed': summary['passed'], 'error': summary.get('error')}, ensure_ascii=False))
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
