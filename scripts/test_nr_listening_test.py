import json
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from nr_listening_test import prepare, wav_info


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

    def extensible(self, path, tag, samples, *, extra=22, valid=32, mask=3,
                   guid=None, fmt_length=None):
        subtype = guid or struct.pack("<I", tag) + bytes.fromhex("00001000800000aa00389b71")
        fmt = struct.pack("<HHIIHHHHI", 0xfffe, 2, 48000, 384000, 8, 32,
                          extra, valid, mask) + subtype
        if fmt_length is not None:
            fmt = fmt[:fmt_length]
        body = (b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt
                + (b"\0" if len(fmt) % 2 else b"")
                + b"LIST" + struct.pack("<I", 4) + b"name"
                + b"data" + struct.pack("<I", len(samples)) + samples)
        path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)

    def test_extensible_float_and_pcm_preserve_samples_and_header(self):
        for tag, samples in [(3, struct.pack("<4f", 0.1, -0.2, 0.3, -0.4)),
                             (1, struct.pack("<4i", 1, -2, 3, -4))]:
            with self.subTest(tag=tag):
                self.extensible(self.one, tag, samples)
                self.extensible(self.two, tag, samples)
                self.run_prepare(f"blind{tag}", f"key{tag}.json")
                output = self.root / f"blind{tag}" / "A.wav"
                result = output.read_bytes()
                fmt, (offset, length) = wav_info(output)
                self.assertEqual(struct.unpack_from("<I", result, 4)[0] + 8, len(result))
                self.assertEqual(len(fmt), 40)
                self.assertEqual(struct.unpack_from("<HHI", fmt, 16), (22, 32, 3))
                self.assertEqual(fmt[24:28], struct.pack("<I", tag))
                self.assertEqual(result[offset:offset + length], samples)
                self.assertNotIn(b"LIST", result)
                self.assertEqual(sorted(p.name for p in output.parent.iterdir()), ["A.wav", "B.wav"])
                self.assertNotIn("private", (self.root / f"key{tag}.json").read_text())

    def test_extensible_rejects_bad_extension(self):
        cases = [dict(extra=21), dict(extra=23), dict(valid=24), dict(mask=1),
                 dict(mask=0x80000003), dict(guid=b"\xff" * 16),
                 dict(fmt_length=38), dict(fmt_length=17)]
        for index, case in enumerate(cases):
            with self.subTest(case=case):
                self.extensible(self.one, 3, bytes(16), **case)
                self.extensible(self.two, 3, bytes(16))
                with self.assertRaises(ValueError):
                    self.run_prepare(f"bad{index}", f"bad{index}.json")
                self.assertFalse((self.root / f"bad{index}.json").exists())

    def test_extensible_channel_masks_must_match_for_comparison(self):
        self.extensible(self.one, 3, bytes(16), mask=3)
        self.extensible(self.two, 3, bytes(16), mask=0)
        with self.assertRaises(ValueError):
            self.run_prepare()

    def test_reject_oversized_fmt_before_creating_output(self):
        fmt = struct.pack("<HHIIHH", 1, 1, 48000, 96000, 2, 16) + bytes(26)
        body = b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", 2) + bytes(2)
        self.one.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertFalse((self.root / "blind").exists())
        self.assertFalse((self.root / "key.json").exists())


if __name__ == "__main__":
    unittest.main()
