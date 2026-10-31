"""実機用の明示的なJSON計画を実sidecarへ送り、応答・負荷を記録する。

python scripts/native_audio_probe.py BINARY PLAN_JSON OUTPUT_DIR
計測用Pythonにはpsutilが必要。通常設定を読まず、音声機器は計画で指定する。
測定値のCPUは1論理コア=100%。プローブ自身は測定対象に含めない。
"""
import collections
import json
import pathlib
import queue
import subprocess
import sys
import threading
import time

import psutil


class Probe:
    def __init__(self, binary, output):
        self.output = output
        self.responses = queue.Queue()
        self.events = collections.Counter()
        self.channel_peaks = []
        self.errors = []
        self.child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, encoding="utf-8", errors="replace",
                                      creationflags=subprocess.CREATE_NO_WINDOW)
        self.process = psutil.Process(self.child.pid)
        self.threads = []
        for name, stream in [("stdout", self.child.stdout), ("stderr", self.child.stderr)]:
            thread = threading.Thread(target=self.read, args=(name, stream), daemon=True)
            thread.start()
            self.threads.append(thread)

    def read(self, name, stream):
        with (self.output / (name + ".log")).open("w", encoding="utf-8") as log:
            for line in stream:
                log.write(line)
                if not line.startswith("IPC:"):
                    continue
                try:
                    message = json.loads(line[4:])
                except ValueError as error:
                    self.errors.append(str(error))
                    continue
                value = message.get("data", {})
                if message.get("kind") == "Response":
                    self.responses.put(value)
                elif message.get("kind") == "Event":
                    kind = value.get("type", "unknown")
                    self.events[kind] += 1
                    if kind == "Error":
                        self.errors.append(value.get("payload"))
                    if kind == "ChannelLevels":
                        levels = value["payload"]
                        if len(self.channel_peaks) < len(levels):
                            self.channel_peaks.extend([0] * (len(levels) - len(self.channel_peaks)))
                        for index, peak in enumerate(levels):
                            self.channel_peaks[index] = max(peak, self.channel_peaks[index])

    def request(self, command):
        self.child.stdin.write(json.dumps(command) + "\n")
        self.child.stdin.flush()
        return self.responses.get(timeout=45)

    def measure(self, seconds):
        before = self.events.copy()
        start = time.perf_counter()
        self.process.cpu_percent(None)
        samples = []
        while time.perf_counter() - start < seconds:
            time.sleep(0.1)
            memory = self.process.memory_info()
            samples.append({"elapsed": time.perf_counter() - start,
                            "cpu_one_core_percent": self.process.cpu_percent(None),
                            "working_set_bytes": memory.rss,
                            "private_bytes": memory.private,
                            "os_peak_working_set_bytes": memory.peak_wset})
        return {"samples": samples, "event_counts": dict(self.events - before),
                "cpu_one_core_mean_percent": sum(x["cpu_one_core_percent"] for x in samples) / len(samples),
                "max_working_set_bytes": max(x["working_set_bytes"] for x in samples),
                "max_private_bytes": max(x["private_bytes"] for x in samples)}

    def close(self):
        if self.child.poll() is None:
            try:
                self.request({"type": "Stop"})
            except (OSError, queue.Empty) as error:
                self.errors.append("cleanup Stop: " + repr(error))
            finally:
                try:
                    self.child.stdin.close()
                except OSError:
                    pass
                try:
                    self.child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
        for thread in self.threads:
            thread.join(timeout=5)


def main():
    if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[1] != "--tree"):
        raise SystemExit("usage: native_audio_probe.py BINARY PLAN_JSON OUTPUT_DIR | --tree PID SECONDS OUTPUT_JSON")
    if sys.argv[1] == "--tree":
        root = psutil.Process(int(sys.argv[2]))
        duration = float(sys.argv[3])
        output = pathlib.Path(sys.argv[4])
        known = {}
        samples = []
        start = time.perf_counter()
        while time.perf_counter() - start < duration:
            processes = [root] + root.children(recursive=True)
            root_memory = root.memory_info()
            working_set = private = cpu = 0
            for process in processes:
                try:
                    key = (process.pid, process.create_time())
                    if key not in known:
                        known[key] = process
                        process.cpu_percent(None)
                    memory = process.memory_info()
                    working_set += memory.rss
                    private += memory.private
                    cpu += known[key].cpu_percent(None)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            samples.append({"elapsed": time.perf_counter() - start,
                            "cpu_one_core_percent": cpu,
                            "working_set_bytes": working_set,
                            "private_bytes": private, "process_count": len(processes),
                            "root_lifetime_peak_working_set_bytes": root_memory.peak_wset,
                            "root_lifetime_peak_commit_bytes": root_memory.peak_pagefile})
            time.sleep(0.2)
        result = {"samples": samples,
                  "cpu_one_core_mean_percent": sum(s["cpu_one_core_percent"] for s in samples[1:]) / max(1, len(samples)-1),
                  "max_working_set_bytes": max(s["working_set_bytes"] for s in samples),
                  "max_private_bytes": max(s["private_bytes"] for s in samples),
                  "root_lifetime_peak_working_set_bytes": max(s["root_lifetime_peak_working_set_bytes"] for s in samples),
                  "root_lifetime_peak_commit_bytes": max(s["root_lifetime_peak_commit_bytes"] for s in samples),
                  "processes": [{"pid": pid, "created": created} for pid, created in known]}
        output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({k:v for k,v in result.items() if k != "samples"}), flush=True)
        return
    binary, plan_path, output = map(pathlib.Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=False)
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    probe = Probe(binary.resolve(), output)
    result = {"binary": str(binary.resolve()), "plan": plan, "steps": []}
    try:
        for step in plan:
            record = {"label": step["label"]}
            if "command" in step:
                command = json.loads(json.dumps(step["command"]).replace("$OUTPUT", str(output.resolve()).replace("\\", "/")))
                record["response"] = probe.request(command)
                print(step["label"], json.dumps(record["response"], ensure_ascii=True)[:1200], flush=True)
                if "expect" in step and record["response"].get("type") != step["expect"]:
                    raise RuntimeError("unexpected response: " + str(record))
            if "measure_seconds" in step:
                record["measurement"] = probe.measure(step["measure_seconds"])
            if "wait_seconds" in step:
                time.sleep(step["wait_seconds"])
            result["steps"].append(record)
    except Exception as error:
        result["failure"] = repr(error)
        raise
    finally:
        probe.close()
        result.update(events=dict(probe.events), channel_peaks=probe.channel_peaks,
                      errors=probe.errors, exit_code=probe.child.returncode)
        (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
