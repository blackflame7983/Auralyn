"""所有する二つの音源と実Engineで二入力を確認する。物理マイク・OBS・聴感は対象外。"""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import platform
from pathlib import Path
import subprocess
import time
from verify_process_audio_engine import Engine
from verify_process_app_soak import fixture, identity, record, sample
from verify_process_loopback_probe import execute, start_source, stop_owned
from verify_process_loopback_route import wait_ready


def cpu_seconds(process):
    """所有するEngineだけのuser+kernel時間。100%を論理コア一つ分とする。"""
    get_times = ctypes.WinDLL('kernel32', use_last_error=True).GetProcessTimes
    get_times.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    get_times.restype = wintypes.BOOL
    times = [wintypes.FILETIME() for _ in range(4)]
    if not get_times(wintypes.HANDLE(int(process._handle)), *(ctypes.byref(value) for value in times)):
        raise ctypes.WinError(ctypes.get_last_error())
    return sum((value.dwHighDateTime << 32) | value.dwLowDateTime for value in times[2:]) / 10_000_000


def system_cpu():
    """Windows全体の経過CPU時間。背景負荷が同一だったとの断定を避ける。"""
    get_times = ctypes.WinDLL('kernel32', use_last_error=True).GetSystemTimes
    get_times.argtypes = [ctypes.POINTER(wintypes.FILETIME)] * 3
    get_times.restype = wintypes.BOOL
    times = [wintypes.FILETIME() for _ in range(3)]
    if not get_times(*(ctypes.byref(value) for value in times)):
        raise ctypes.WinError(ctypes.get_last_error())
    idle, kernel, user = [(value.dwHighDateTime << 32) | value.dwLowDateTime for value in times]
    return idle, kernel+user


def verify(args, root, result):
    before = json.loads(execute(args.probe, ['endpoints'], root, 'before').stdout)
    devices = {device['id']: device for device in before}
    capture_before = json.loads(execute(args.probe, ['capture-endpoints'], root, 'capture-before').stdout)
    raw, sink = [devices[value] for value in [args.raw_endpoint, args.broadcast_endpoint]]
    voice = next(device for device in before if device['name'] == 'CABLE Input (VB-Audio Virtual Cable)')
    if any(device['active_processes'] or device['default_roles'] for device in [raw, sink, voice]):
        raise RuntimeError('未使用・非既定の試験用入力と出力だけを指定してください')
    cable_captures = [device for device in capture_before if device['name'].startswith('CABLE Output')]
    if not cable_captures or any(device['active_processes'] or device['default_roles'] for device in cable_captures):
        raise RuntimeError('ケーブルの録音側が使用中・既定・不明のため、試験音を流しません')
    if len({raw['id'], sink['id'], voice['id'], args.output_endpoint}) != 4:
        raise RuntimeError('原音・声の試験音・本人用・配信用は分けてください')
    handles, guards = [], []
    engine = chrome = voice_source = post = None
    try:
        for index, device in enumerate([raw, sink]):
            ready = root / f'guard-{index}.ready.json'
            output = (root / f'guard-{index}.stdout').open('x', encoding='utf-8')
            error = (root / f'guard-{index}.stderr').open('x', encoding='utf-8')
            handles.extend([output, error])
            process = subprocess.Popen([str(args.probe), 'hold-endpoint-muted', device['id'], str(args.seconds + 300), str(ready)],
                stdout=output, stderr=error, creationflags=subprocess.CREATE_NO_WINDOW)
            guards.append((process, ready))
            original = wait_ready(process, ready)
            if original['muted'] != device['muted']:
                raise RuntimeError('試験用の出力がミュート状態を共有しています')
        current = json.loads(execute(args.probe, ['endpoints'], root, 'guarded').stdout)
        for device in current:
            original = devices[device['id']]
            expected_mute = True if device['id'] in [raw['id'], sink['id']] else original['muted']
            if device['muted'] != expected_mute or device['volume'] != original['volume'] or device['default_roles'] != original['default_roles']:
                raise RuntimeError('無関係な出力へ影響する組合せでは試験を開始しません')
        wave = root / 'accompaniment.wav'
        fixture(wave)
        result['accompanimentFixtureSha256'] = hashlib.sha256(wave.read_bytes()).hexdigest()
        chrome_out = (root / 'chrome.stdout').open('x', encoding='utf-8')
        chrome_err = (root / 'chrome.stderr').open('x', encoding='utf-8')
        handles.extend([chrome_out, chrome_err])
        chrome = subprocess.Popen(['node', str(args.chrome_helper), str(root), raw['name'], str(wave), 'webaudio'],
            stdout=chrome_out, stderr=chrome_err, creationflags=subprocess.CREATE_NO_WINDOW)
        ready = root / 'chrome.ready.json'
        deadline = time.monotonic() + 30
        while not ready.exists():
            if chrome.poll() is not None or time.monotonic() > deadline: raise RuntimeError('所有するChromeを開始できません')
            time.sleep(0.1)
        target = identity(json.loads(ready.read_text(encoding='utf-8'))['pid'])
        voice_source, _, _ = start_source(args.probe, root, 'source-low-volume', args.seconds + 240, voice['id'], 997)
        directory = root / 'engine'; directory.mkdir()
        engine = Engine(args.engine, directory)
        token = engine.request({'type':'BeginDeviceScan'})['payload']['token']
        deadline = time.monotonic() + 20
        while True:
            scan = engine.request({'type':'PollDeviceScan','payload':{'token':token}})['payload']['status']
            if scan['status'] == 'Completed': break
            if scan['status'] != 'Pending' or time.monotonic() > deadline: raise RuntimeError('機器一覧を取得できません')
            time.sleep(0.05)
        found = scan['data']
        primary = next(device for device in found if device['is_input'] and device['host'].lower() == 'wasapi' and device['name'].startswith('CABLE Output'))
        engine.request({'type':'SetGlobalMute','payload':{'active':True}})
        # 配信VSTを動かす試験では、VST後のmaster gainと両出力trimで無音にする。
        if args.active_processing:
            engine.request({'type':'SetOutputGain','payload':{'value':0.0}})
        engine.request({'type':'SetNoiseReduction','payload':{'active':False,'mode':'low'}})
        if args.vst:
            result['voicePlugin'] = engine.request({'type':'LoadPlugin','payload':{'path':str(args.vst)}})['payload']
        builtin = {'active':False,'preset':'broadcast','amount':0.0}
        engine.request({'type':'LiveOutput','payload':{'config':{'deviceId':'wasapi:'+sink['id'],'splitProcessing':True,
            'monitorTrim':0.0 if args.active_processing else 1.0,
            'broadcastTrim':0.0 if args.active_processing else 1.0,
            'monitorMuted':True,'monitorSinging':builtin,'monitorTalk':builtin}}})
        levels = {'voice':{'gain':1.0,'muted':False},'accompaniment':{'gain':1.0,'muted':False},'monitorAccompaniment':True,'offsetMs':0}
        config = {'version':1,'source':{'kind':'process_loopback','config':{'appKey':target['appKey'],'appName':target['name'],
            'rawEndpointId':raw['id'],'purpose':'music'}},'levels':levels}
        def status(): return engine.request({'type':'Mixing','payload':{'request':{'action':'snapshot'}}})['payload']
        def configure(value, selected=None):
            current = status()
            return engine.request({'type':'Mixing','payload':{'request':{'action':'configure','expectedEpoch':current['epoch'],
                'expectedRevision':current['revision'],'start':None if value is None else {'config':value,'target':selected}}}})['payload']
        def adjust(value):
            current = status()
            return engine.request({'type':'Mixing','payload':{'request':{'action':'levels','expectedEpoch':current['epoch'],
                'expectedRevision':current['revision'],'levels':value}}})['payload']
        start = {'host':'WASAPI','input':primary['name'],'input_id':primary['id'],'output_id':'wasapi:'+args.output_endpoint,
            'sample_rate':args.rate,'buffer_size':512}
        configure(config, {'pid':target['pid'],'created':target['created']})
        if args.post_vst:
            post_directory = root / 'post-engine'; post_directory.mkdir()
            post = Engine(args.engine, post_directory, ('--post-mix-worker',))
            result['postPlugin'] = post.request({'type':'LoadPlugin','payload':{'path':str(args.post_vst)}})['payload']
            descriptor = engine.request({'type':'PostMixPrepare','payload':{'sample_rate':args.rate}})['payload']
            post.request({'type':'PostMixStart','payload':{'descriptor':descriptor}})
            deadline = time.monotonic()+15
            while True:
                post_status = engine.request({'type':'PostMixStatus'})['payload']
                if post_status['failed']: raise RuntimeError('配信VSTの準備に失敗しました')
                if post_status['ready']: break
                if time.monotonic()>deadline: raise RuntimeError('配信VSTの準備が完了しません')
                time.sleep(0.05)
        result['started'] = engine.request({'type':'Start','payload':start})
        sample(engine, 2)
        initial = status(); result['initial'] = initial
        if not initial['running'] or initial['failed'] or max(initial['voicePeak']) <= 0 or max(initial['accompanimentPeak']) <= 0 or max(initial['mixPeak']) <= 0:
            raise RuntimeError('マイク相当の機器とオケの両方がミックスへ届きません')
        try: configure(None)
        except RuntimeError: result['runningSourceChangeRejected'] = True
        else: raise RuntimeError('実行中の入力元変更を拒否しません')
        if not status()['running']: raise RuntimeError('拒否した設定変更で主入力が停止しました')
        for offset in [50,-50,0]:
            levels = {**levels,'offsetMs':offset}; adjust(levels); sample(engine,0.8)
            if status()['pending']: raise RuntimeError('時間差の反映が完了しません')
        result['signedOffsetsApplied'] = True
        old = status(); levels = {**levels,'voice':{'gain':0.0,'muted':False}}; adjust(levels)
        try:
            engine.request({'type':'Mixing','payload':{'request':{'action':'levels','expectedEpoch':old['epoch'],'expectedRevision':old['revision'],'levels':levels}}})
        except RuntimeError: result['staleLevelsRejected'] = True
        else: raise RuntimeError('古い調整要求を拒否しません')
        sample(engine,0.8); muted_voice = status()
        if max(muted_voice['voicePeak']) != 0 or max(muted_voice['mixPeak']) <= 0: raise RuntimeError('声だけの完全な音量ゼロが維持されません')
        levels = {**levels,'voice':{'gain':1.0,'muted':False},'accompaniment':{'gain':0.0,'muted':True}}; adjust(levels); sample(engine,0.8)
        muted_music = status()
        if max(muted_music['accompanimentPeak']) != 0 or max(muted_music['voicePeak']) <= 0: raise RuntimeError('オケだけのミュートが維持されません')
        levels = {**levels,'accompaniment':{'gain':1.0,'muted':False}}; adjust(levels)
        if args.active_processing:
            deadline = time.monotonic()+10
            while True:
                stats = sample(engine,0.2)['runtime']['preparation']
                if stats['muted'] and stats['outputGain']==0 and not stats['controlsPending']: break
                if time.monotonic()>deadline: raise RuntimeError('VST後の音量ゼロを確認できません')
            engine.request({'type':'SetGlobalMute','payload':{'active':False}})
            sample(engine,2)
        began = time.monotonic()
        cpu_begin = cpu_seconds(engine.process)
        post_cpu_begin = cpu_seconds(post.process) if post else 0
        system_begin = system_cpu()
        last_post_packets = None
        if post and args.active_processing:
            rack = post.request({'type':'GetPluginRack'})['payload']
            plugins = rack.get('plugins', [])
            if len(plugins)!=1 or not plugins[0]['enabled'] or plugins[0]['muted']:
                raise RuntimeError('配信VSTが有効ではありません')
            result['postEnabledPluginCount'] = len(plugins)
            last_post_packets = engine.request({'type':'PostMixStatus'})['payload'].get('processed_packets')
            if last_post_packets is None: raise RuntimeError('配信VSTの処理開始数を取得できません')
            result['postProcessedPacketsAtBegin'] = last_post_packets
        with (root/'samples.jsonl').open('x',encoding='utf-8') as log:
            while time.monotonic()-began < args.seconds:
                observation = sample(engine,min(2,args.seconds-(time.monotonic()-began)))
                snapshot = status()
                if snapshot['failed'] or snapshot['accompaniment']['failed'] or not snapshot['running']:
                    raise RuntimeError('二入力の連続処理が停止しました')
                preparation = observation['runtime']['preparation']
                if observation['meterEvents'] <= 0: raise RuntimeError('出力メーターの観測が欠落しました')
                if observation['outputPeak'] != 0: raise RuntimeError('試験中の出力ゼロが外れました')
                if args.active_processing:
                    if preparation['muted'] or preparation['outputGain']!=0 or preparation['controlsPending']:
                        raise RuntimeError('VSTを動かした無音試験の条件が変わりました')
                    if observation['runtime']['global_bypass'] or min(max(snapshot[key]) for key in ['voicePeak','accompanimentPeak','mixPeak'])<=0:
                        raise RuntimeError('両入力の非ゼロ信号と加工の有効状態を確認できません')
                elif not preparation['muted']: raise RuntimeError('試験中の全体ミュートが外れました')
                elapsed = time.monotonic()-began
                cpu_elapsed = cpu_seconds(engine.process)-cpu_begin
                entry = {'elapsedSeconds':elapsed,'engineCpuSeconds':cpu_elapsed,
                    'engineCpuPercentOfOneCore':100*cpu_elapsed/elapsed,'mixing':snapshot,'runtime':observation['runtime'],
                    'meterEvents':observation['meterEvents'],'outputPeak':observation['outputPeak']}
                idle, total = system_cpu()
                entry['systemCpuPercentAllCores'] = 100*(1-(idle-system_begin[0])/max(1,total-system_begin[1]))
                if post:
                    entry['postMix'] = engine.request({'type':'PostMixStatus'})['payload']
                    if not entry['postMix']['ready'] or entry['postMix']['failed']:
                        raise RuntimeError('配信VSTの処理が停止しました')
                    if args.active_processing:
                        processed = entry['postMix'].get('processed_packets')
                        if processed is None or processed<=0 or (last_post_packets is not None and processed<=last_post_packets):
                            raise RuntimeError('配信VSTの処理済みパケットが進行しません')
                        last_post_packets = processed
                    entry['postCpuSeconds'] = cpu_seconds(post.process)-post_cpu_begin
                    entry['totalCpuPercentOfOneCore'] = 100*(cpu_elapsed+entry['postCpuSeconds'])/elapsed
                log.write(json.dumps(entry)+'\n');log.flush();record(root/'progress.json',entry)
        result['elapsedSeconds'] = time.monotonic()-began
        result['engineCpuSeconds'] = cpu_seconds(engine.process)-cpu_begin
        result['engineCpuPercentOfOneCore'] = 100*result['engineCpuSeconds']/result['elapsedSeconds']
        if post:
            result['postCpuSeconds'] = cpu_seconds(post.process)-post_cpu_begin
            result['totalCpuPercentOfOneCore'] = 100*(result['engineCpuSeconds']+result['postCpuSeconds'])/result['elapsedSeconds']
            result['postProcessedPacketsAtEnd'] = last_post_packets
        engine.request({'type':'SetGlobalMute','payload':{'active':True}})
        (root/'chrome.stop').touch(); chrome.wait(timeout=15)
        deadline = time.monotonic()+8
        while time.monotonic()<deadline:
            sample(engine,0.3); snapshot = status()
            if snapshot['accompaniment']['failed']: break
        if not snapshot['accompaniment']['failed'] or not snapshot['running'] or max(snapshot['voicePeak']) <= 0 or snapshot['failed']:
            raise RuntimeError('オケ終了後に声だけを継続できません')
        result['voiceContinuesAfterApplicationExit'] = True
        engine.request({'type':'Stop'})
        if post:
            engine.request({'type':'PostMixClear'})
            post.close(); post = None
        # 名前指定の旧入口でも、解決後の同一入力を拒否することを実機で確認する。
        duplicate = {**config,'source':{'kind':'device','config':{'host':'WASAPI','inputId':primary['id'],'inputChannels':[0,1]}}}
        configure(duplicate)
        named = {key:value for key,value in start.items() if key != 'input_id'}
        try: engine.request({'type':'Start','payload':named})
        except RuntimeError as error:
            if '同じ入力' not in str(error): raise
            result['resolvedDuplicateRejected'] = True
        else: raise RuntimeError('名前で解決した同一入力を二重取得しました')
        second = next((device for device in found if device['is_input'] and device['host'].lower()=='wasapi'
            and 'cable' in device['name'].lower() and '16ch' in device['name'].lower() and device['id']!=primary['id']),None)
        cable_start = start
        shared_fixture = True
        if second is None:
            # ケーブル入力が一つの場合は、無音を許容する別の仮想バスを主入力にする。
            # 物理マイクやVoicemeeterの内部配線は変更せず、オケの取得を確認する。
            alternate = next((device for device in found if device['is_input'] and device['host'].lower()=='wasapi'
                and device['name'].startswith('Voicemeeter Out A4')),None)
            if alternate:
                capture = next((device for device in capture_before if 'wasapi:'+device['id'] == alternate['id']), None)
                if not capture or capture['active_processes'] or capture['default_roles']:
                    raise RuntimeError('仮想マイク相当の録音側が使用中・既定・不明です')
                second = primary
                cable_start = {**start,'input':alternate['name'],'input_id':alternate['id']}
                shared_fixture = False
        if second:
            cable = {**config,'source':{'kind':'device','config':{'host':'WASAPI','inputId':second['id'],'inputChannels':[0,1]}}}
            configure(cable);engine.request({'type':'Start','payload':cable_start});sample(engine,2)
            current = status()
            if not current['running'] or current['failed'] or current['accompaniment']['failed'] or max(current['accompanimentPeak'])<=0 or current['primaryClock']['queuedFrames']<=0:
                raise RuntimeError('仮想ケーブルのオケ入力を取得できません')
            result['virtualCableAccompanimentCaptured'] = True
            result['virtualCableFixtureSharesPhysicalInputSignal'] = shared_fixture
            result['virtualCablePrimary'] = cable_start['input']
            engine.request({'type':'Stop'})
        else: result['virtualCableCaseUnavailable'] = '独立した機器IDのテスト入力がありません'
        result['physicalMicrophoneOpened'] = False; result['audibleMonitorTested'] = False; result['obsTested'] = False
    finally:
        cleanup_errors = []
        def cleanup(label, action):
            try: action()
            except Exception as error: cleanup_errors.append(f'{label}: {error}')
        def collect_events():
            events = []
            for line in (root/'engine/engine.stdout').read_text(encoding='utf-8').splitlines():
                if line.startswith('IPC:'):
                    try: message=json.loads(line[4:])
                    except json.JSONDecodeError: continue
                    if message['kind']=='Event': events.append(message['data']['type'])
            result['sourceFailureNotification'] = 'MixingSourceFailed' in events
        def close_chrome():
            try:
                (root/'chrome.stop').touch()
                chrome.wait(timeout=15)
            finally:
                if chrome.poll() is None: stop_owned(chrome)
        if engine:
            if engine.process.poll() is None:
                cleanup('global mute', lambda: engine.request({'type':'SetGlobalMute','payload':{'active':True}}))
            cleanup('main Engine', engine.close)
            cleanup('events', collect_events)
        if post: cleanup('post Engine', post.close)
        if chrome: cleanup('Chrome', close_chrome)
        if voice_source: cleanup('voice source', lambda: stop_owned(voice_source))
        for process, ready in reversed(guards):
            cleanup('mute guard', lambda: stop_owned(process))
            def restore():
                restored = execute(args.probe,['restore-endpoint',str(ready.with_suffix('.restore.json'))],root,ready.stem+'-restore')
                if restored.returncode: raise RuntimeError('出力端点の復元に失敗しました')
            cleanup('restore endpoint', restore)
        for handle in handles: cleanup('log handle', handle.close)
        def check_endpoints():
            after={device['id']:device for device in json.loads(execute(args.probe,['endpoints'],root,'after').stdout)}
            result['endpointStatePreserved']=all(device[key]==after.get(device['id'],{}).get(key) for device in before for key in ['muted','volume','default_roles'])
            if not result['endpointStatePreserved']: raise RuntimeError('試験前の出力設定を保持できませんでした')
            after_capture={device['id']:device for device in json.loads(execute(args.probe,['capture-endpoints'],root,'capture-after').stdout)}
            result['captureEndpointStatePreserved']=all(device[key]==after_capture.get(device['id'],{}).get(key) for device in capture_before for key in ['muted','volume','default_roles'])
            if not result['captureEndpointStatePreserved']: raise RuntimeError('試験前の録音端点設定を保持できませんでした')
        cleanup('endpoint verification', check_endpoints)
        if cleanup_errors:
            result['cleanupErrors'] = cleanup_errors
            raise RuntimeError('試験後の回収・端点復元に失敗しました: '+'; '.join(cleanup_errors))
        if result.get('voiceContinuesAfterApplicationExit') and not result.get('sourceFailureNotification'):
            raise RuntimeError('オケだけの失敗通知を確認できませんでした')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['engine','probe','raw-endpoint','broadcast-endpoint','output-endpoint','output-dir']: parser.add_argument('--'+name,required=True)
    parser.add_argument('--seconds',type=int,default=30);parser.add_argument('--rate',type=int,default=48000)
    parser.add_argument('--vst',type=Path);parser.add_argument('--chrome-helper',type=Path,default=Path('scripts/process-loopback-chrome-source.mjs'))
    parser.add_argument('--post-vst',type=Path,help='同じEngineバイナリの専用workerでミックス後VSTも動かす')
    parser.add_argument('--cadence-context',choices=['unknown','device_output','broadcast_worker'],default='unknown',
        help='対象ソースで確認した遅延カウンターの観測位置。旧Engineとの比較で区別する')
    parser.add_argument('--active-processing',action='store_true',
        help='master音量ゼロ・両出力trimゼロ・monitor mute・端点guardで無音を保ち、全体muteを解除してVSTへ実信号を流す')
    args=parser.parse_args()
    if not 1 <= args.seconds <= 10800: parser.error('secondsは1〜10800です')
    for name in ['engine','probe','chrome_helper']:setattr(args,name,Path(getattr(args,name)).resolve(strict=True))
    if args.vst:args.vst=args.vst.resolve(strict=True)
    if args.post_vst:args.post_vst=args.post_vst.resolve(strict=True)
    root=Path(args.output_dir).resolve();root.mkdir(parents=True,exist_ok=False)
    result={'passed':False,'engineSha256':hashlib.sha256(args.engine.read_bytes()).hexdigest(),
        'conditions':{'rate':args.rate,'requestedBufferFrames':512,'seconds':args.seconds,
            'cadenceContext':args.cadence_context,
            'os':platform.platform(),'logicalCores':os.cpu_count(),
            'voiceVst':str(args.vst) if args.vst else None,'postVst':str(args.post_vst) if args.post_vst else None,
            'voiceVstSha256':hashlib.sha256(args.vst.read_bytes()).hexdigest() if args.vst else None,
            'postVstSha256':hashlib.sha256(args.post_vst.read_bytes()).hexdigest() if args.post_vst else None,
            'performanceTweaksDisabled':True,'globalMuted':not args.active_processing,
            'activeProcessing':args.active_processing,
            'postProcessing':'not_loaded' if not args.post_vst else 'active' if args.active_processing else 'paused_by_global_mute'}}
    try:verify(args,root,result);result['passed']=True
    except Exception as error:result['error']=str(error)
    record(root/'summary.json',result);print(json.dumps({'directory':str(root),'passed':result['passed'],'error':result.get('error')},ensure_ascii=False))
    return 0 if result['passed'] else 1


if __name__=='__main__': raise SystemExit(main())
