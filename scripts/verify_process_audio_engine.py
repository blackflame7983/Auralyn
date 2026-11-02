"""隔離した実Engineで、指定した音声入力経路だけを確認する明示実行用runner。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

from verify_process_loopback_probe import execute, start_source, stop_owned


class Engine:
    def __init__(self, binary: Path, directory: Path):
        self.events: list[dict] = []
        self.messages: queue.Queue = queue.Queue()
        self.stderr = (directory / "engine.stderr").open("x", encoding="utf-8")
        environment = dict(os.environ, AURALYN_DISABLE_PERF_TWEAKS="1",
                           APPDATA=str(directory / "appdata"), LOCALAPPDATA=str(directory / "localappdata"))
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, text=True, encoding="utf-8", env=environment,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
        self.reader = threading.Thread(target=self.read, args=(directory,), daemon=True)
        self.reader.start()

    def read(self, directory: Path) -> None:
        with (directory / "engine.stdout").open("x", encoding="utf-8") as log:
            for line in self.process.stdout:
                log.write(line)
                if line.startswith("IPC:"):
                    try:
                        self.messages.put(json.loads(line[4:]))
                    except json.JSONDecodeError as error:
                        self.messages.put(error)
        self.messages.put(RuntimeError("Engineのstdoutが閉じました"))

    def next(self, timeout: float) -> dict:
        message = self.messages.get(timeout=timeout)
        if isinstance(message, Exception):
            raise message
        if message["kind"] == "Event":
            event = message["data"]
            self.events.append(event)
            if event["type"] == "Error":
                raise RuntimeError(event["payload"])
        return message

    def request(self, command: dict) -> dict:
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            message = self.next(max(0.01, deadline - time.monotonic()))
            if message["kind"] == "Response":
                if message["data"]["type"] == "Error":
                    raise RuntimeError(message["data"]["payload"])
                return message["data"]
        raise TimeoutError("Engineから応答がありません")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                stop_owned(self.process)
        self.reader.join(timeout=3)
        self.stderr.close()


def verify_cable(engine_binary: Path, probe: Path, directory: Path, summary: dict, purpose: str = "voice") -> None:
    before_result = execute(probe, ["endpoints"], directory, "before")
    before = json.loads(before_result.stdout)
    cable = next(x for x in before if x["name"] == "CABLE Input (VB-Audio Virtual Cable)")
    if cable["active_processes"] or cable["muted"]:
        raise RuntimeError("CABLE Inputが使用中かミュート中です。通常設定は変更しません")
    engine = Engine(engine_binary, directory)
    source = None
    try:
        scan = engine.request({"type": "BeginDeviceScan"})
        token = scan["payload"]["token"]
        deadline = time.monotonic() + 15
        devices = None
        while time.monotonic() < deadline:
            status = engine.request({"type": "PollDeviceScan", "payload": {"token": token}})["payload"]["status"]
            if status["status"] == "Completed":
                devices = status["data"]
                break
            if status["status"] != "Pending":
                raise RuntimeError("デバイス検出に失敗しました: " + str(status))
            time.sleep(0.05)
        if devices is None:
            raise TimeoutError("デバイス検出が完了しません")
        inputs = [d for d in devices if d["is_input"] and d["host"].lower() == "wasapi" and (d["name"] == "CABLE Output" or d["name"].startswith("CABLE Output ["))]
        outputs = [d for d in devices if not d["is_input"] and d["host"].lower() == "wasapi" and d["is_default"]]
        if len(inputs) != 1 or len(outputs) != 1:
            raise RuntimeError("ケーブル入力と既定WASAPI出力を一意に選べません")
        source, identity, ready = start_source(probe, directory, "source-low-volume", 12, cable["id"], 523)
        source_config = {"source": {"kind": "device", "config": {"purpose": purpose}}, "target": None}
        if purpose == "music":
            engine.request({"type": "SetNoiseReduction", "payload": {"active": True, "mode": "low"}})
        response = engine.request({"type": "Start", "payload": {
            **({"input_source": source_config} if purpose == "music" else {}),
            "host": "WASAPI", "input": inputs[0]["name"], "output": outputs[0]["name"],
            "input_id": inputs[0]["id"], "output_id": outputs[0]["id"],
            "buffer_size": 512, "sample_rate": 48000}})
        if response["type"] != "Started" or response["payload"]["input_id"] != inputs[0]["id"]:
            raise RuntimeError("指定したケーブル入力で開始できません")
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                engine.next(min(0.2, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                pass
        runtime = engine.request({"type": "GetRuntimeStats"})
        meters = [e["payload"] for e in engine.events if e["type"] == "LevelMeter"]
        input_peak = max((max(m["input"]) for m in meters), default=0)
        output_peak = max((max(m["output"]) for m in meters), default=0)
        if input_peak <= 0 or output_peak <= 0:
            raise RuntimeError("入力または出力メーターに信号がありません")
        if purpose == "music" and (runtime["payload"]["noise_reduction_active"] or abs(input_peak - output_peak) > 0.00001):
            raise RuntimeError("音楽のケーブル入力で声向け処理が適用されています")
        engine.request({"type": "Stop"})
        summary["purpose"] = purpose
        summary.update({"input": inputs[0], "output": outputs[0], "source": identity,
                        "started": response, "runtime": runtime, "input_peak": input_peak,
                        "output_peak": output_peak, "meter_events": len(meters)})
        source.wait(timeout=14)
        summary["source_result"] = json.loads(ready.with_suffix(".result.json").read_text(encoding="utf-8"))
    finally:
        if source is not None:
            stop_owned(source)
        engine.close()
        after_result = execute(probe, ["endpoints"], directory, "after")
        after = {x["id"]: x for x in json.loads(after_result.stdout)}
        preserved = all(all(after[x["id"]][k] == x[k] for k in ["muted", "volume", "default_roles"]) for x in before)
        summary["endpoint_state_preserved"] = preserved
        if not preserved:
            raise RuntimeError("再生先の設定が試験前と異なります")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--purpose", choices=["voice", "music"], default="voice")
    args = parser.parse_args()
    engine = args.engine.resolve(strict=True)
    probe = args.probe.resolve(strict=True)
    directory = (args.output_dir or Path("src-tauri/target/process-loopback-probe") / ("engine-cable-" + uuid.uuid4().hex[:10])).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    summary = {"functional_pass": False, "engine_sha256": hashlib.sha256(engine.read_bytes()).hexdigest(),
               "probe_sha256": hashlib.sha256(probe.read_bytes()).hexdigest()}
    try:
        verify_cable(engine, probe, directory, summary, args.purpose)
        summary["functional_pass"] = True
    except Exception as error:
        summary["error"] = str(error)
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output_directory": str(directory), **summary}, ensure_ascii=False))
    return 0 if summary["functional_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
