"""段階0：未使用の別再生先をミュートしてもプロセス取得音が残るかを確認する。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

from verify_process_loopback_probe import capture, execute, start_source, stop_owned, verify_capture


def wait_ready(process: subprocess.Popen, ready: Path) -> dict:
    deadline = time.monotonic() + 8
    while process.poll() is None and time.monotonic() < deadline:
        try:
            return json.loads(ready.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.02)
    raise RuntimeError("出力デバイスのミュートを確認できません")


def verify(binary: Path, endpoint: str, directory: Path, summary: dict, seconds: int = 3, monitor_endpoint: str | None = None, frequency: int = 997) -> None:
    listed = execute(binary, ["endpoints"], directory, "before")
    if listed.returncode:
        raise RuntimeError(listed.stderr)
    before = json.loads(listed.stdout)
    selected = [x for x in before if x["id"] == endpoint]
    if len(selected) != 1 or selected[0]["default_roles"] or selected[0]["active_processes"]:
        raise RuntimeError("既定出力以外の未使用の再生先を一つ指定してください")
    if monitor_endpoint == endpoint:
        raise RuntimeError("本人用出力と原音用出力を分けてください")
    total = seconds * (2 if monitor_endpoint else 1)
    summary.update({"probe_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                    "endpoint_before": selected[0], "signal_survives_endpoint_mute": False,
                    "audible_monitor_tested": False, "endpoint_state_restored": False})
    ready = directory / "endpoint-muted.ready.json"
    # 専用のコピーを使い、通常アプリのセッション設定を変更しない。
    source_binary = directory / "isolated_route_source.exe"
    with binary.open("rb") as src, source_binary.open("xb") as dst:
        import shutil
        shutil.copyfileobj(src, dst)
    with (directory / "guard.stdout").open("x", encoding="utf-8") as out, (directory / "guard.stderr").open("x", encoding="utf-8") as err:
        guard = subprocess.Popen([str(binary), "hold-endpoint-muted", endpoint, str(total + 16), str(ready)],
                                 stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        summary["mute_snapshot"] = wait_ready(guard, ready)
        process, identity, source_ready = start_source(source_binary, directory, "source-low-volume", total + 6, endpoint, frequency)
        try:
            if identity["muted"] or identity["session_volume"] != 1 or identity["render_endpoint"] != endpoint:
                raise RuntimeError("試験音の再生先またはセッション音量が不一致です")
            current = execute(binary, ["endpoints"], directory, "during")
            states = json.loads(current.stdout)
            muted = next(x for x in states if x["id"] == endpoint)
            if not muted["muted"] or muted["active_processes"] != [process.pid]:
                raise RuntimeError("ミュート中の試験音以外の使用、または経路変更を検出しました")
            result, report, wave = capture(binary, directory, identity, "endpoint-muted-capture", seconds=seconds)
            verify_capture(result, report, "duration")
            stats = report["capture"]
            summary.update({"source": identity, "endpoint_during": muted, "capture": report, "wave": str(wave)})
            if stats["nonzero_frames"] == 0 or stats["peak"] < 0.0001:
                raise RuntimeError("出力デバイスのミュート中に取得した信号がありません")
            if monitor_endpoint:
                monitored = execute(binary, ["monitor", str(identity["pid"]), str(identity["created"]), monitor_endpoint, str(seconds)], directory, "monitor", timeout=seconds + 8)
                if monitored.returncode:
                    raise RuntimeError("本人用の返し試験に失敗しました: " + monitored.stderr)
                summary["monitor"] = json.loads(monitored.stdout)
                summary["monitor_path_exercised"] = True
            process.wait(timeout=12)
            source_result = json.loads(source_ready.with_suffix(".result.json").read_text(encoding="utf-8"))
            summary["source_result"] = source_result
            if process.returncode or source_result["source_failed"] or not source_result["emitted_frames"]:
                raise RuntimeError("試験音が正常に生成されませんでした")
            summary["signal_survives_endpoint_mute"] = True
        finally:
            stop_owned(process)
        guard.wait(timeout=20)
        if guard.returncode:
            raise RuntimeError("出力ミュートの保持または復元に失敗しました")
    finally:
        # 子の強制終了時も復元記録を使用する。通常アプリや既定出力は操作しない。
        if guard.poll() is None:
            try:
                guard.wait(timeout=20)
            except subprocess.TimeoutExpired:
                stop_owned(guard)
        restore = ready.with_suffix(".restore.json")
        if restore.exists():
            restored = execute(binary, ["restore-endpoint", str(restore)], directory, "restore")
            if restored.returncode:
                raise RuntimeError("出力状態を復元できません: " + restored.stderr)
        after = execute(binary, ["endpoints"], directory, "after")
        state_by_id = {x["id"]: x for x in json.loads(after.stdout)}
        preserved = all(x["id"] in state_by_id and
                        all(state_by_id[x["id"]][k] == x[k] for k in ["muted", "volume", "default_roles"])
                        for x in before)
        summary["endpoint_state_restored"] = preserved
        if not preserved:
            raise RuntimeError("再生先の音量・ミュート・既定設定に変更が残っています")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--source-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--seconds", type=int, default=3)
    parser.add_argument("--monitor-endpoint", help="指定した再生先に低音量の試験音を返す")
    parser.add_argument("--frequency", type=int, default=997)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3500:
        parser.error("--seconds は1〜3500秒です")
    binary = args.binary.resolve(strict=True)
    directory = (args.output_dir or Path("src-tauri/target/process-loopback-probe") / ("route-" + uuid.uuid4().hex[:10])).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    summary = {"functional_pass": False}
    try:
        verify(binary, args.source_endpoint, directory, summary, args.seconds, args.monitor_endpoint, args.frequency)
        summary["functional_pass"] = True
    except Exception as error:
        summary["error"] = str(error)
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output_directory": str(directory), **summary}, ensure_ascii=False))
    return 0 if summary["functional_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
