"""所有するChromeだけで、プロセス入力の終了・再選択・経路変更・ミュート解除を確認する。"""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import queue
import subprocess
import sys
import time
from verify_process_app_soak import fixture, identity, record, sample
from verify_process_audio_engine import Engine
from verify_process_loopback_probe import execute, stop_owned
from verify_process_loopback_route import wait_ready


def audio_child(root_pid: int, root_created: int) -> int | None:
    # コマンドラインを出力せず、所有するChromeの子孫だけを対象にする。
    if identity(root_pid)['created'] != root_created:
        raise RuntimeError('所有するChromeのルートが変わりました')
    script = """@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object {
        [pscustomobject]@{pid=$_.ProcessId; parent=$_.ParentProcessId;
        audio=($_.CommandLine -like '*--utility-sub-type=audio.mojom.AudioService*')}
    }) | ConvertTo-Json -Compress"""
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script],
                            capture_output=True, text=True, timeout=15, check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    processes = json.loads(result.stdout)
    if not isinstance(processes, list):
        processes = [processes]
    descendants = {root_pid}
    for _ in range(64):
        found = {process['pid'] for process in processes if process['parent'] in descendants}
        if found.issubset(descendants):
            break
        descendants.update(found)
    candidates = [process['pid'] for process in processes if process['audio'] and process['pid'] in descendants]
    if len(candidates) > 1:
        raise RuntimeError('所有する音声子プロセスを一意に確認できません')
    if candidates and identity(candidates[0])['created'] < root_created:
        raise RuntimeError('音声子プロセスの生成時刻がルートより古くなっています')
    return candidates[0] if candidates else None


def stop_audio_child(pid: int) -> None:
    selected = identity(pid)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000 | 0x0001, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        created, exited, system, user = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        if ((created.dwHighDateTime << 32) | created.dwLowDateTime) != selected['created']:
            raise RuntimeError('終了対象の音声子プロセスが変わりました')
        if not kernel.TerminateProcess(handle, 0):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)


def verify(args, root: Path, result: dict) -> None:
    before = json.loads(execute(args.probe, ['endpoints'], root, 'before').stdout)
    devices = {d['id']: d for d in before}
    raw, alternate, output = (devices[value] for value in [args.raw_endpoint, args.alternate_endpoint, args.output_endpoint])
    if len({raw['id'], alternate['id'], output['id']}) != 3:
        raise RuntimeError('原音用2機器と返し用機器は分けてください')
    for device in [raw, alternate]:
        if device['default_roles'] or device['active_processes']:
            raise RuntimeError('未使用・非既定の原音用出力だけを指定してください')
    if raw['muted']:
        raise RuntimeError('ミュート解除の試験は、元の状態がミュート解除済みの機器だけを使います')
    result['before'] = before
    fixture_path = root / 'fixture.wav'
    fixture(fixture_path)
    guards, sources, handles = [], [], []
    engine = None

    def start(binary, arguments, directory, name):
        streams = [(directory / (name + suffix)).open('x', encoding='utf-8') for suffix in ['.stdout', '.stderr']]
        handles.extend(streams)
        return subprocess.Popen([str(binary), *arguments], stdout=streams[0], stderr=streams[1],
                                cwd=directory, creationflags=subprocess.CREATE_NO_WINDOW)

    def start_source(index):
        directory = root / ('source-' + str(index))
        directory.mkdir()
        process = start('node', [str(args.chrome_helper), str(directory), raw['name'], str(fixture_path), 'audio-element'], directory, 'chrome')
        sources.append((process, directory))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready = directory / 'chrome.ready.json'
            if ready.exists():
                try:
                    browser = json.loads(ready.read_text(encoding='utf-8'))
                    return process, directory, identity(browser['pid'])
                except json.JSONDecodeError:
                    pass
            if process.poll() is not None:
                raise RuntimeError('試験用Chromeが終了しました')
            time.sleep(0.05)
        raise RuntimeError('試験用Chromeの準備が期限切れです')

    def stop_source(process, directory):
        (directory / 'chrome.stop').touch(exist_ok=True)
        process.wait(timeout=15)

    def payload(target):
        return {'host': 'WASAPI', 'output_id': 'wasapi:' + output['id'], 'sample_rate': 48000, 'buffer_size': 512,
                'input_source': {'source': {'kind': 'process_loopback', 'config': {'appKey': target['appKey'],
                    'appName': target['name'], 'rawEndpointId': raw['id'], 'purpose': 'music'}},
                    'target': {'pid': target['pid'], 'created': target['created']}}}

    def start_input(target):
        engine.request({'type': 'Start', 'payload': payload(target)})
        observation = sample(engine, 0.7)
        state = observation['runtime'].get('process_input')
        if not state or state['failed'] or state['nonzeroFrames'] < 1000:
            raise RuntimeError('実アプリの取得を確認できません')
        return state

    def expect_failure(began, expected):
        while time.monotonic() - began < 6:
            try:
                engine.next(0.25)
            except queue.Empty:
                pass
            except RuntimeError as error:
                if expected not in str(error):
                    raise
                return {'message': str(error), 'observedAfterSeconds': time.monotonic() - began}
        # 期限超過を合格へ読み替えない。取得状態と、実際に変更できた出力を残す。
        try:
            result['failureRuntime'] = engine.request({'type': 'GetRuntimeStats'})['payload']
        except RuntimeError as error:
            result['failureRuntimeError'] = str(error)
        current = json.loads(execute(args.probe, ['endpoints'], root, 'failure-endpoints').stdout)
        result['failureEndpoints'] = [device for device in current if device['id'] in [raw['id'], alternate['id']]]
        raise RuntimeError('異常時の停止通知がありません: ' + expected)

    try:
        for index, device in enumerate([raw, alternate]):
            ready = root / ('guard-' + str(index) + '.ready.json')
            guard = start(args.probe, ['hold-endpoint-muted', device['id'], '240', str(ready)], root, 'guard-' + str(index))
            guards.append((guard, ready))
            observed = wait_ready(guard, ready)
            if any(observed[key] != device[key] for key in ['muted', 'volume', 'default_roles']):
                raise RuntimeError('原音用の2機器がミュート状態を共有しているか、準備中に設定が変わりました。独立した出力先で試してください')
        engine_dir = root / 'engine'
        engine_dir.mkdir()
        engine = Engine(args.engine, engine_dir)
        engine.request({'type': 'SetGlobalMute', 'payload': {'active': True}})
        source, directory, old_target = start_source(1)
        result['initial'] = start_input(old_target)

        if args.audio_service_restart:
            child = audio_child(old_target['pid'], old_target['created'])
            if child is None:
                raise RuntimeError('所有するChromeに独立した音声子プロセスがありません')
            # 列挙中にも音声は進むため、終了直前の値を基準にする。
            before_frames = engine.request({'type': 'GetRuntimeStats'})['payload']['process_input']['nonzeroFrames']
            began = time.monotonic()
            stop_audio_child(child)
            deadline = time.monotonic() + 15
            source_replayed = False
            source_reloaded = False
            while time.monotonic() < deadline:
                observation = sample(engine, 0.5)
                current = observation['runtime']['process_input']
                heartbeat = directory / 'chrome-heartbeat.json'
                if heartbeat.exists() and not source_replayed:
                    try:
                        source_state = json.loads(heartbeat.read_text(encoding='utf-8'))
                    except json.JSONDecodeError:
                        source_state = {}
                    if source_state.get('state') == 'paused':
                        # 音声serviceの終了でChrome自身が一時停止する。元アプリの再生操作と
                        # Auralynの対象再選択を区別して、前者だけを所有するsourceへ送る。
                        result['sourcePausedAfterAudioChildExit'] = source_state
                        record(directory / 'chrome-control.json', {'action': 'play', 'epoch': 'audio-service-restart'})
                        source_replayed = True
                if source_replayed and not source_reloaded and time.monotonic() - began >= 4:
                    # playだけで再生時計が動かない場合は、所有する素材をChrome側で読み直す。
                    record(directory / 'chrome-control.json', {'action': 'reload', 'epoch': 'audio-service-reload'})
                    source_reloaded = True
                replacement = audio_child(old_target['pid'], old_target['created'])
                if (replacement and replacement != child and current['nonzeroFrames'] > before_frames + 24000
                        and not current['waitingForAudio'] and observation['inputPeak'] > 0.00001):
                    if identity(old_target['pid'])['created'] != old_target['created'] or current['failed']:
                        raise RuntimeError('元のChromeの識別・取得を維持できません')
                    result['audioChildRestart'] = {'oldChildPid': child, 'newChildPid': replacement,
                        'sameRoot': True, 'reselectionRequired': False, 'process': current,
                        'sourceReplayRequired': source_replayed,
                        'sourceReloadRequired': source_reloaded,
                        'nonzeroFramesAfterRestart': current['nonzeroFrames'] - before_frames,
                        'observedAfterSeconds': time.monotonic() - began}
                    break
            else:
                raise RuntimeError('音声子プロセス再生成後の取得復帰を確認できません')

        began = time.monotonic()
        stop_source(source, directory)
        result['targetExit'] = expect_failure(began, '選んだアプリ')
        engine.request({'type': 'Stop'})
        source, directory, target = start_source(2)
        if (target['pid'], target['created']) == (old_target['pid'], old_target['created']):
            raise RuntimeError('再起動後の識別が変わりません')
        try:
            engine.request({'type': 'Start', 'payload': payload(old_target)})
        except RuntimeError as error:
            result['staleTargetRejected'] = str(error)
        else:
            raise RuntimeError('終了した対象への自動再接続を拒否しません')
        result['explicitReselection'] = start_input(target)

        began = time.monotonic()
        record(directory / 'chrome-control.json', {'action': 'route', 'epoch': 1, 'endpointName': alternate['name']})
        result['routeMigration'] = expect_failure(began, '原音用の出力先')
        if not (directory / 'chrome-control-ack.json').exists():
            raise RuntimeError('Chrome自身の経路変更完了を確認できません')
        engine.request({'type': 'Stop'})
        stop_source(source, directory)

        source, directory, target = start_source(3)
        result['beforeUnmute'] = start_input(target)
        began = time.monotonic()
        guard, ready = guards[0]
        stop_owned(guard)
        execute(args.probe, ['restore-endpoint', str(ready.with_suffix('.restore.json'))], root, 'inject-unmute')
        result['rawUnmute'] = expect_failure(began, '原音用の出力先')
        engine.request({'type': 'Stop'})
    finally:
        if engine:
            engine.close()
        for source, directory in sources:
            if source.poll() is None:
                try:
                    stop_source(source, directory)
                except subprocess.TimeoutExpired:
                    stop_owned(source)
        for guard, ready in reversed(guards):
            stop_owned(guard)
            journal = ready.with_suffix('.restore.json')
            if journal.exists():
                restored = execute(args.probe, ['restore-endpoint', str(journal)], root, ready.stem + '-restore')
                if restored.returncode:
                    raise RuntimeError('原音用デバイスの復元に失敗しました')
        for handle in handles:
            handle.close()
        after = {d['id']: d for d in json.loads(execute(args.probe, ['endpoints'], root, 'after').stdout)}
        result['endpointStatePreserved'] = all(d[k] == after[d['id']][k] for d in before for k in ['muted', 'volume', 'default_roles'])
        if not result['endpointStatePreserved']:
            raise RuntimeError('試験前の再生先設定が保持されませんでした')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['engine', 'probe', 'raw-endpoint', 'alternate-endpoint', 'output-endpoint', 'output-dir']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--chrome-helper', type=Path, default=Path('scripts/process-loopback-chrome-source.mjs'))
    parser.add_argument('--audio-service-restart', action='store_true', help='所有するChromeの音声子プロセスだけを終了し再生成を確認する')
    args = parser.parse_args()
    for name in ['engine', 'probe', 'chrome_helper']:
        setattr(args, name, Path(getattr(args, name)).resolve(strict=True))
    root = Path(args.output_dir).resolve()
    root.mkdir(parents=True, exist_ok=False)
    result = {'passed': False, 'audibleMonitorTested': False}
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
