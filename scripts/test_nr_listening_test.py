import json
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from nr_listening_test import prepare


class ListeningTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.one, self.two = self.root / "private-one.wav", self.root / "private-two.wav"
        self.write(self.one, b"\x01\x02" * 40)
        self.write(self.two, b"\x03\x04" * 40)

    def write(self, path, samples):
        with wave.open(str(path), "wb") as w:
            w.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
            w.writeframes(samples)

    def run_prepare(self, output="blind", key="key.json", seed=42):
        prepare(("old", self.one), ("new", self.two), "listener_1", seed,
                self.root / output, self.root / key)

    def test_mapping_reproducible_and_samples_match(self):
        self.run_prepare()
        self.run_prepare("blind2", "key2.json")
        key = json.loads((self.root / "key.json").read_text(encoding="utf-8"))
        self.assertEqual(key, json.loads((self.root / "key2.json").read_text(encoding="utf-8")))
        self.assertEqual({key["A"], key["B"]}, {"old", "new"})
        for name in ("A", "B"):
            with wave.open(str(self.root / "blind" / f"{name}.wav"), "rb") as actual:
                with wave.open(str(self.one if key[name] == "old" else self.two), "rb") as expected:
                    self.assertEqual(actual.readframes(40), expected.readframes(40))
        self.assertEqual(sorted(p.name for p in (self.root / "blind").iterdir()), ["A.wav", "B.wav"])
        self.assertNotIn("private", json.dumps(key))

    def test_reject_existing_without_overwrite(self):
        self.run_prepare()
        before = (self.root / "key.json").read_bytes()
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertEqual(before, (self.root / "key.json").read_bytes())

    def test_reject_key_inside_distribution(self):
        with self.assertRaises(ValueError):
            self.run_prepare(key="blind/key.json")
        self.assertFalse((self.root / "blind").exists())

    def test_reject_invalid_and_mismatched_inputs(self):
        with self.assertRaises(ValueError):
            prepare(("bad/path", self.one), ("new", self.two), "L", 1, self.root / "out", self.root / "key")
        self.write(self.two, b"\x01\x02" * 20)
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertFalse((self.root / "key.json").exists())

    def test_reject_truncated_wav(self):
        data = self.two.read_bytes()
        self.two.write_bytes(data[:-4])
        with self.assertRaises(ValueError):
            self.run_prepare()

    def test_float_wav_is_copied_without_metadata(self):
        samples = struct.pack("<4f", 0.1, -0.2, 0.3, -0.4)
        fmt = struct.pack("<HHIIHH", 3, 1, 48000, 192000, 4, 32)
        body = b"WAVEfmt " + struct.pack("<I", 16) + fmt + b"LIST" + struct.pack("<I", 4) + b"name" + b"data" + struct.pack("<I", len(samples)) + samples
        for path in (self.one, self.two):
            path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
        self.run_prepare()
        result = (self.root / "blind/A.wav").read_bytes()
        self.assertNotIn(b"LIST", result)
        self.assertTrue(result.endswith(samples))


if __name__ == "__main__":
    unittest.main()
