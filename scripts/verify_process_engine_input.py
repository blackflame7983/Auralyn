"""実Engineのプロセス入力を、所有する小音量sourceと未使用の別再生先で確認する。"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import time
import uuid
from verify_process_audio_engine import Engine
from verify_process_loopback_probe import execute, start_source, stop_owned
from verify_process_loopback_route import wait_ready


def observe(engine: Engine, seconds: float) -> dict:
    engine.events.clear()
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            engine.next(min(0.2, max(0.01, until - time.monotonic())))
        except queue.Empty:
            pass
    stats = engine.request({"type": "GetRuntimeStats"})["payload"]
    meters = [e["payload"] for e in engine.events if e["type"] == "LevelMeter"]
    return {"stats": stats, "input_peak": max((max(m["input"]) for m in meters), default=0),
            "output_peak": max((max(m["output"]) for m in meters), default=0)}


def verify(args, directory: Path, summary: dict) -> None:
    before = json.loads(execute(args.probe, ["endpoints"], directory, "before").stdout)
    source_device = next(x for x in before if x["id"] == args.source_endpoint)
    output = next(x for x in before if x["id"] == args.output_endpoint)
    if source_device["default_roles"] or source_device["active_processes"] or source_device["id"] == output["id"]:
        raise RuntimeError("未使用・非既定の原音出力先と、別の本人用出力を指定してください")
    binary = directory / "isolated_process_source.exe"
    shutil.copyfile(args.probe, binary)
    ready = directory / "muted.ready.json"
    logs = [(directory / f"guard.{suffix}").open("x", encoding="utf-8") for suffix in ["stdout", "stderr"]]
    guard = subprocess.Popen([str(args.probe), "hold-endpoint-muted", source_device["id"], "70", str(ready)],
                             stdout=logs[0], stderr=logs[1], creationflags=subprocess.CREATE_NO_WINDOW)
    source = None
    engine = Engine(args.engine, directory)
    try:
        summary["muted"] = wait_ready(guard, ready)
        source, identity, source_ready = start_source(binary, directory, "source-low-volume", 60, source_device["id"], 733)
        config = {"kind": "process_loopback", "config": {
            "appKey": hashlib.sha256(str(binary).lower().encode()).hexdigest(), "appName": binary.name,
            "rawEndpointId": source_device["id"], "purpose": "music"}}
        selection = {"source": config, "target": {"pid": identity["pid"], "created": identity["created"]}}
        start = {"host": "WASAPI", "output_id": "wasapi:" + output["id"], "buffer_size": 512,
                 "sample_rate": 48000, "input_source": selection}
        capability = engine.request({"type": "ProcessInputCapability"})
        if capability != {"type": "ProcessInputCapability", "payload": {"version": 1}}:
            raise RuntimeError("入力形式の能力応答が一致しません")
        engine.request({"type": "SetNoiseReduction", "payload": {"active": True, "mode": "low"}})
        for rate in [48000, 44100]:
            start["sample_rate"] = rate
            reply = engine.request({"type": "Start", "payload": start})
            if reply["type"] != "Started" or reply["payload"].get("input_id") is not None:
                raise RuntimeError("機器入力を開かないプロセス開始を確認できません")
            result = observe(engine, 4)
            process = result["stats"]["process_input"]
            if not process["capturedFrames"] or process["failed"] or result["input_peak"] <= 0 or result["output_peak"] <= 0:
                raise RuntimeError("プロセス信号を出力できません: " + str(result))
            if abs(result["input_peak"] - result["output_peak"]) > 0.00001:
                raise RuntimeError("音楽のバイパス経路で信号レベルが変化しました")
            if result["stats"]["noise_reduction_active"] or result["stats"]["noise_reduction_latency_samples"]:
                raise RuntimeError("音楽へ声向けNRが適用されています")
            summary.setdefault("music", []).append({"rate": rate, "started": reply, **result})
            if rate == 48000:
                pause = source_ready.with_suffix(".pause")
                pause.touch(exist_ok=False)
                summary["paused"] = observe(engine, 1)
                pause.unlink()
                summary["resumed"] = observe(engine, 1)
                if summary["resumed"]["output_peak"] <= 0 or summary["resumed"]["stats"]["process_input"]["failed"]:
                    raise RuntimeError("一時停止後の取得を再開できません")
            engine.request({"type": "SetGlobalMute", "payload": {"active": True}})
            muted = observe(engine, 0.7)
            engine.request({"type": "SetGlobalMute", "payload": {"active": False}})
            engine.request({"type": "Stop"})
            summary.setdefault("mute", []).append(muted)
        # 生成時刻の不一致・同じ出力・機器との同時指定を拒否する。
        invalid = json.loads(json.dumps(start))
        invalid["input_source"]["target"]["created"] += 1
        cases = {"creation_mismatch": invalid, "same_output": {**start, "output_id": "wasapi:" + source_device["id"]},
                 "mixed_input": {**start, "input_id": "wasapi:invalid"}, "asio": {**start, "host": "ASIO"}}
        for name, value in cases.items():
            try:
                engine.request({"type": "Start", "payload": value})
            except RuntimeError as error:
                summary.setdefault("rejected", {})[name] = str(error)
            else:
                raise RuntimeError("不正指定を拒否しません: " + name)
        start["sample_rate"] = 48000
        config["config"]["purpose"] = "voice"
        engine.request({"type": "SetNoiseReduction", "payload": {"active": False, "mode": "low"}})
        engine.request({"type": "Start", "payload": start})
        summary["voice"] = observe(engine, 1)
        engine.request({"type": "SetNoiseReduction", "payload": {"active": True, "mode": "low"}})
        summary["voice_nr"] = observe(engine, 1)
        if not summary["voice_nr"]["stats"]["noise_reduction_active"]:
            raise RuntimeError("声の用途でNRが動作しません")
        engine.request({"type": "StartNoiseLearning", "payload": {"duration_ms": 1000}})
        summary["voice_learning"] = observe(engine, 1.5)
        conditions = engine.request({"type": "NoiseMeasurement", "payload": {"request": {"action": "snapshot"}}})["payload"]["conditions"]
        if not conditions or not conditions["inputId"].startswith("process:"):
            raise RuntimeError("プロセス専用の学習識別がありません")
        summary["learning_conditions"] = conditions
        engine.request({"type": "SetNoiseReduction", "payload": {"active": False, "mode": "low"}})
        engine.request({"type": "Stop"})
        summary["endpoint_muted_during"] = next(x for x in json.loads(execute(args.probe, ["endpoints"], directory, "during").stdout) if x["id"] == source_device["id"])["muted"]
        # 対象終了後は別PIDへ自動接続しない。
        engine.request({"type": "Start", "payload": start})
        stop_owned(source)
        until = time.monotonic() + 5
        failure = None
        while time.monotonic() < until:
            try:
                engine.next(0.3)
            except queue.Empty:
                pass
            except RuntimeError as error:
                failure = str(error)
                break
        if not failure:
            raise RuntimeError("対象終了を通知しません")
        summary["target_exit"] = failure
        engine.request({"type": "Stop"})
    finally:
        engine.close()
        if source is not None:
            stop_owned(source)
        stop_owned(guard)
        for log in logs:
            log.close()
        journal = ready.with_suffix(".restore.json")
        if journal.exists():
            restore = execute(args.probe, ["restore-endpoint", str(journal)], directory, "restore")
            if restore.returncode:
                raise RuntimeError(restore.stderr)
        after = {x["id"]: x for x in json.loads(execute(args.probe, ["endpoints"], directory, "after").stdout)}
        summary["endpoint_state_preserved"] = all(all(after[x["id"]][k] == x[k] for k in ["muted", "volume", "default_roles"]) for x in before)
        if not summary["endpoint_state_preserved"]:
            raise RuntimeError("再生先の設定が復元されませんでした")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--source-endpoint", required=True)
    parser.add_argument("--output-endpoint", required=True)
    args = parser.parse_args()
    args.engine, args.probe = args.engine.resolve(strict=True), args.probe.resolve(strict=True)
    directory = Path("src-tauri/target/process-loopback-probe", "engine-process-" + uuid.uuid4().hex[:10]).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    summary = {"functional_pass": False, "engine_sha256": hashlib.sha256(args.engine.read_bytes()).hexdigest(), "audible_monitor_tested": False}
    try:
        verify(args, directory, summary)
        summary["functional_pass"] = True
    except Exception as error:
        summary["error"] = str(error)
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"directory": str(directory), "functional_pass": summary["functional_pass"], "error": summary.get("error")}, ensure_ascii=False))
    return 0 if summary["functional_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
