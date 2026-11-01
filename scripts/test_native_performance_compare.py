import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name("native_performance_compare.py")
spec = importlib.util.spec_from_file_location("native_performance_compare", MODULE)
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


class CompareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.before = self.base / "before.exe"
        self.after = self.base / "after.exe"
        self.before.write_bytes(b"before")
        self.after.write_bytes(b"after")
        self.plan_path = self.base / "plan.json"
        self.plan = [{"label": "start", "command": {"type": "Start"}}, {"label": "active", "measure_seconds": 1}]
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        self.calls = []
        self.mode = "success"

    def fake_probe(self, args, **kwargs):
        binary, plan_path, directory = map(Path, args[-3:])
        self.calls.append(binary.name)
        directory.mkdir()
        sample = {"elapsed": 1.1, "cpu_one_core_percent": 10 if binary == self.before else 20, "private_bytes": 100, "working_set_bytes": 120, "os_peak_working_set_bytes": 140, "os_peak_commit_bytes": 160}
        if self.mode == "missing_peak":
            del sample["os_peak_commit_bytes"]
        if self.mode == "nan":
            sample["cpu_one_core_percent"] = float("nan")
        if self.mode == "window":
            sample["elapsed"] = 0.5
        response = {"type": "Error" if self.mode == "command_error" else "Success"}
        result = {"binary": str(binary), "plan": self.plan, "steps": [{"label": "start", "response": response}, {"label": "active", "measurement": {"samples": [sample]}}], "errors": [], "exit_code": 0}
        if self.mode == "missing_response":
            del result["steps"][0]["response"]
        (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")
        return subprocess.CompletedProcess(args, 1 if self.mode == "failure" else 0, "out", "err")

    def run_compare(self, output=None):
        with patch.object(compare.subprocess, "run", side_effect=self.fake_probe):
            return compare.run(self.before, self.after, self.plan_path, output or self.base / "output", 3)

    def test_order_aggregate_and_provenance(self):
        summary = self.run_compare()
        self.assertEqual(self.calls, ["before.exe", "after.exe", "after.exe", "before.exe", "before.exe", "after.exe"])
        self.assertEqual(summary["status"], "success")
        self.assertEqual(summary["aggregate"]["before"]["active"]["repeats"], 3)
        self.assertEqual(summary["aggregate"]["after"]["active"]["cpu_one_core_mean_percent"], 20)
        self.assertEqual(summary["aggregate"]["after"]["active"]["os_peak_commit_bytes"], 160)
        self.assertEqual(summary["provenance"]["plan"]["sha256"], compare.digest(self.plan_path))
        self.assertEqual(json.loads((self.base / "output" / "summary.json").read_text(encoding="utf-8")), summary)
        self.assertEqual((self.base / "output" / "01-before.stdout.log").read_text(encoding="utf-8"), "out")

    def test_failed_and_invalid_trials_are_not_aggregated(self):
        for mode in ("failure", "nan", "window", "command_error", "missing_response", "missing_peak"):
            with self.subTest(mode=mode):
                self.mode = mode
                summary = self.run_compare(self.base / mode)
                self.assertEqual(summary["status"], "failed")
                self.assertTrue(all(t["status"] == "failed" for t in summary["trials"]))
                self.assertEqual(summary["aggregate"]["before"]["active"]["status"], "unavailable")
                self.assertTrue((self.base / mode / "summary.json").exists())
                self.assertTrue((self.base / mode / "01-before.stderr.log").exists())

    def test_output_guards_and_repeats(self):
        existing = self.base / "existing"
        existing.mkdir()
        marker = existing / "keep"
        marker.write_text("untouched")
        with self.assertRaises(FileExistsError):
            self.run_compare(existing)
        self.assertEqual(marker.read_text(), "untouched")
        for name in ("test-results", "playwright-report", "blob-report", "playwright"):
            with self.assertRaises(ValueError):
                self.run_compare(self.base / name / "new")
        with self.assertRaises(ValueError):
            compare.run(self.before, self.after, self.plan_path, self.base / "new", 2)

    def test_changed_input_marks_trials_failed(self):
        original = self.fake_probe
        def changed(args, **kwargs):
            result = original(args, **kwargs)
            self.plan_path.write_text("[]", encoding="utf-8")
            return result
        with patch.object(compare.subprocess, "run", side_effect=changed):
            summary = compare.run(self.before, self.after, self.plan_path, self.base / "changed", 3)
        self.assertTrue(all(t["status"] == "failed" for t in summary["trials"]))
        self.assertEqual(summary["aggregate"]["before"]["active"]["repeats"], 0)

    def test_invalid_measurement_durations(self):
        for duration in (0, -1, 0.01, float("nan"), float("inf")):
            with self.subTest(duration=duration):
                self.plan[1]["measure_seconds"] = duration
                self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
                with self.assertRaises(ValueError):
                    compare.load_plan(self.plan_path)

    def test_expected_response_is_checked_again(self):
        self.plan[0]["expect"] = "Started"
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        summary = self.run_compare()
        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["aggregate"]["before"]["active"]["repeats"], 0)


if __name__ == "__main__":
    unittest.main()
