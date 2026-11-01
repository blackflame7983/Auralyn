import argparse
import tempfile
import unittest
from unittest import mock
from pathlib import Path

import numpy as np
import soundfile as sf

import loopback_measurements as m


class LoopbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rate = 8000

    def tearDown(self):
        self.temp.cleanup()

    def wav(self, name, data):
        path = self.root / name
        sf.write(path, data, self.rate, subtype="FLOAT")
        return path

    def test_delay_polarity_noise_and_order(self):
        rng = np.random.default_rng(42)
        ref = rng.normal(0, .1, self.rate * 2)
        delayed = np.concatenate([np.zeros(123), -ref[:-123]]) + rng.normal(0, .001, len(ref))
        for data, expected in ((np.column_stack((ref, delayed)), 123),
                               (np.column_stack((delayed, ref)), -123)):
            result = m.analyze_a1(self.wav("delay.wav", data))
            self.assertEqual(result["status"], "measured")
            self.assertEqual(result["lagFrames"], expected)

    def test_silence_periodic_and_nonfinite_unknown(self):
        t = np.arange(self.rate * 2) / self.rate
        for x in (np.zeros(len(t)), np.sin(2*np.pi*100*t)):
            result = m.analyze_a1(self.wav("unknown.wav", np.column_stack((x, x))))
            self.assertEqual(result["status"], "unknown")
            self.assertIsNone(result["lagMs"])
        x = np.ones(len(t)); x[5] = np.nan
        self.assertEqual(m.analyze_a1(self.wav("nan.wav", np.column_stack((x, x))))["status"], "unknown")

    def test_a3_intervals_merge_and_short_coverage(self):
        data = np.ones((self.rate * 2, 2)) * .1
        data[800:1040, 1] = 0  # 3 consecutive windows -> one interval
        data[4000:4160, 1] = .0001
        data[12000:12800, 0] = 0
        result = m.analyze_a3(self.wav("gaps.wav", data))
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["suspectedIntervalCount"], 2)
        self.assertAlmostEqual(result["suspectedIntervals"][0]["durationSeconds"], .03)
        self.assertAlmostEqual(result["unanalyzedSeconds"], .1)

    def test_short_zero_runs_across_windows(self):
        data = np.ones((self.rate, 2)) * .1
        data[100:132, 1] = 0  # 4ms within a window
        data[150:182, 1] = 0  # 4ms crossing the 160-frame boundary
        data[300, 1] = 0  # one sample is not a dropout candidate
        data[400:432, :] = 0  # inactive reference cannot establish a candidate
        result = m.analyze_a3(self.wav("short-gaps.wav", data))
        self.assertEqual(result["digitalZeroIntervalCount"], 2)
        for interval, start in zip(result["digitalZeroIntervals"], (100, 150)):
            self.assertAlmostEqual(interval["startSeconds"], start / self.rate)
            self.assertAlmostEqual(interval["durationSeconds"], .004)
        self.assertEqual(result["suspectedIntervalCount"], 0)

    def test_inactive_coverage_is_partial_for_hour_recording(self):
        class FakeRecording:
            samplerate = 8000
            frames = 8000 * 3600
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, *args, **kwargs):
                if not hasattr(self, "done"):
                    self.done = True
                    return np.full((80, 2), .1)
                return np.empty((0, 2))
        # coverage status を短時間で確認するため、宣言長と読取値を模擬する。
        with mock.patch.object(m, "read_info", return_value=FakeRecording()):
            result = m.analyze_a3("unused")
        self.assertEqual(result["status"], "partial")
        self.assertIn("reference inactive or invalid for part of recording", result["reasons"])

    def test_prepare_and_no_overwrite(self):
        out = self.root / "new"
        args = argparse.Namespace(output=out, rate=self.rate, device="device", driver="driver",
                                  build="build", routing="route", buffers=[128, 512])
        m.prepare(args)
        import json
        plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
        self.assertEqual(len(plan["cases"]), 16)
        self.assertTrue(all(c["repetitions"] == 5 and c["actualCallbackFrames"] is None for c in plan["cases"]))
        with self.assertRaises(FileExistsError):
            m.prepare(args)

    def test_no_reference_and_invalid_rate(self):
        data = np.zeros((self.rate, 2))
        self.assertIn("no active reference", m.analyze_a3(self.wav("empty.wav", data))["reasons"])
        data[0, 0] = np.nan
        self.assertIn("non-finite samples", m.analyze_a3(self.wav("invalid.wav", data))["reasons"])
        path = self.root / "rate.wav"
        sf.write(path, data, 4000)
        with self.assertRaises(ValueError):
            m.analyze_a3(path)


if __name__ == "__main__":
    unittest.main()
