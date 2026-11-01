import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import tempfile

spec = importlib.util.spec_from_file_location("native_audio_probe", Path(__file__).with_name("native_audio_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeProcess:
    def __init__(self, pid, cpu=12):
        self.pid, self.cpu, self.calls = pid, cpu, 0
        self.child_list = []

    def create_time(self):
        return float(self.pid)

    def is_running(self):
        return True

    def cpu_percent(self, _):
        self.calls += 1
        return 0 if self.calls == 1 else self.cpu

    def memory_info(self):
        return SimpleNamespace(rss=100, private=80, peak_wset=130, peak_pagefile=150)

    def children(self, recursive):
        return self.child_list


class TreeTests(unittest.TestCase):
    def run_tree(self, root, duration=0.2):
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
        with patch.object(probe.psutil, "Process", return_value=root), patch.object(probe.time, "perf_counter", side_effect=lambda: clock[0]), patch.object(probe.time, "sleep", side_effect=sleep):
            return probe.measure_tree(root.pid, duration)

    def test_priming_and_peaks(self):
        root, child = FakeProcess(1), FakeProcess(2, 8)
        root.child_list = [child]
        result = self.run_tree(root)
        self.assertEqual([s["cpu_one_core_percent"] for s in result["samples"]], [20, 20])
        self.assertEqual(result["cpu_one_core_mean_percent"], 20)
        self.assertEqual(result["samples"][0]["cpu_unprimed_process_count"], 0)
        self.assertEqual(result["max_private_bytes"], 160)
        self.assertEqual(result["root_lifetime_peak_commit_bytes"], 150)

    def test_invalid_duration(self):
        for value in (0, -1, float("nan"), float("inf"), 0.01, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe.measure_tree(1, value)

    def test_child_appearing_during_measurement_is_marked_unprimed(self):
        root, child = FakeProcess(1), FakeProcess(2, 8)
        calls = []
        def children(recursive):
            calls.append(True)
            return [] if len(calls) == 1 else [child]
        root.children = children
        result = self.run_tree(root)
        self.assertEqual(result["samples"][0]["cpu_unprimed_process_count"], 1)
        self.assertEqual([s["cpu_one_core_percent"] for s in result["samples"]], [12, 20])

    def test_root_exit_and_access_denied_fail(self):
        root = FakeProcess(1)
        root.is_running = lambda: False
        with self.assertRaises(RuntimeError):
            self.run_tree(root)
        root.is_running = lambda: True
        root.children = lambda recursive: (_ for _ in ()).throw(probe.psutil.AccessDenied(1))
        with self.assertRaises(probe.psutil.AccessDenied):
            self.run_tree(root)

    def test_child_exit_is_recorded(self):
        root, child = FakeProcess(1), FakeProcess(2)
        child.memory_info = lambda: (_ for _ in ()).throw(probe.psutil.NoSuchProcess(2))
        root.child_list = [child]
        result = self.run_tree(root, 0.1)
        self.assertEqual(result["samples"][0]["disappeared_child_count"], 1)
        self.assertEqual(result["samples"][0]["process_count"], 1)

    def test_existing_evidence_is_not_measured_or_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tree.json"
            output.write_text("retained", encoding="utf-8")
            with patch.object(probe.sys, "argv", ["probe", "--tree", "1", "1", str(output)]), patch.object(probe, "measure_tree") as measure:
                with self.assertRaises(FileExistsError):
                    probe.main()
                measure.assert_not_called()
            self.assertEqual(output.read_text(encoding="utf-8"), "retained")


if __name__ == "__main__":
    unittest.main()
