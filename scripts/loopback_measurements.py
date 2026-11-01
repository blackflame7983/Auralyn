"""#211 のオフライン計測準備と録音解析。音声デバイスは操作しない。"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy import signal
import soundfile as sf


def new_output(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=False)
    return path


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def valid_rate(rate):
    if not 8000 <= rate <= 384000:
        raise ValueError("sample rate must be 8000..384000 Hz")


def prepare(args):
    valid_rate(args.rate)
    if any(b <= 0 for b in args.buffers):
        raise ValueError("buffers must be positive")
    out = new_output(args.output)
    # 固定seedの非発声広帯域信号。低振幅で、再生前に経路・音量を確認する。
    rng = np.random.default_rng(211)
    fixture = rng.uniform(-0.15, 0.15, args.rate * 3)
    sf.write(out / "fixture.wav", fixture, args.rate, subtype="PCM_16")
    cases = []
    for backend in ("ASIO", "WASAPI"):
        for buffer in args.buffers:
            for nr in (False, True):
                for vst in (0, 3):
                    cases.append({"backend": backend, "requestedBufferFrames": buffer,
                                  "actualCallbackFrames": None, "nr": nr, "vstCount": vst,
                                  "repetitions": 5})
    save(out / "plan.json", {"rateHz": args.rate, "device": args.device, "driver": args.driver,
         "build": args.build, "routing": args.routing, "actualCallbackFramesNote": "unknown until observed",
         "fixture": "fixture.wav (non-speech measurement signal)", "cases": cases})


def read_info(path):
    f = sf.SoundFile(path)
    try:
        valid_rate(f.samplerate)
        if f.channels != 2:
            raise ValueError("WAV must have two channels: reference, processed")
        if f.format != "WAV":
            raise ValueError("input must be WAV")
    except Exception:
        f.close()
        raise
    return f


def analyze_a1(path):
    with read_info(path) as f:
        rate = f.samplerate
        # 短い fixture 録音専用。長時間ファイルの誤投入を防ぐ。
        if f.frames > rate * 60:
            raise ValueError("A1 recording must be at most 60 seconds")
        data = f.read(dtype="float64", always_2d=True)
    result = {"status": "unknown", "lagFrames": None, "lagMs": None,
              "meaning": "processed relative to reference; not physical round-trip latency"}
    if len(data) < rate // 2 or not np.isfinite(data).all():
        result["reason"] = "short or non-finite recording"
        return result
    ref, proc = data[:, 0] - data[:, 0].mean(), data[:, 1] - data[:, 1].mean()
    denom = np.linalg.norm(ref) * np.linalg.norm(proc)
    if denom < 1e-8 or np.std(ref) < 1e-5 or np.std(proc) < 1e-5:
        result["reason"] = "silence or insufficient signal"
        return result
    corr = np.abs(signal.correlate(proc, ref, mode="full", method="fft")) / denom
    lags = signal.correlation_lags(len(proc), len(ref), mode="full")
    peak_index = int(np.argmax(corr))
    peak = float(corr[peak_index])
    # 隣接sampleは同一peakとし、離れた競合peakを周期性の判断に使う。
    competitors = corr.copy()
    radius = max(1, rate // 1000)
    competitors[max(0, peak_index-radius):peak_index+radius+1] = 0
    second = float(np.max(competitors))
    result.update(peakCorrelation=peak, competingCorrelation=second)
    if peak < 0.2 or second >= peak * 0.8:
        result["reason"] = "low confidence or ambiguous correlation peaks"
        return result
    lag = int(lags[peak_index])
    result.update(status="measured", lagFrames=lag, lagMs=lag * 1000 / rate)
    return result


def analyze_a3(path):
    with read_info(path) as f:
        rate, total = f.samplerate, f.frames
        window = max(1, rate // 100)  # 10 ms単位の疑い区間
        segments, start, active_frames, invalid_frames = [], None, 0, 0
        zero_segments, zero_start, zero_energy, zero_length = [], None, 0.0, 0

        def finish_zero():
            nonlocal zero_start, zero_energy, zero_length
            if (zero_start is not None and zero_length >= (rate + 999) // 1000
                    and zero_energy / zero_length >= 0.01 ** 2):
                zero_segments.append({"startSeconds": zero_start / rate,
                                      "durationSeconds": zero_length / rate})
            zero_start, zero_energy, zero_length = None, 0.0, 0

        pos = 0
        while True:
            data = f.read(window, dtype="float64", always_2d=True)
            n = len(data)
            if not n:
                break
            # block境界を越える連続ゼロを保持し、その区間の参照RMSを照合する。
            zeros = (data[:, 1] == 0) & np.isfinite(data[:, 0])
            edges = np.flatnonzero(np.diff(np.concatenate(([False], zeros, [False]))))
            if zero_start is not None and not zeros[0]:
                finish_zero()
            for left, right in zip(edges[::2], edges[1::2]):
                if zero_start is None:
                    zero_start = pos + int(left)
                zero_length += int(right - left)
                zero_energy += float(np.dot(data[left:right, 0], data[left:right, 0]))
                if right < n:
                    finish_zero()
            finite = np.isfinite(data).all()
            suspect = False
            if finite:
                ref = float(np.sqrt(np.mean(data[:, 0] ** 2)))
                proc = float(np.sqrt(np.mean(data[:, 1] ** 2)))
                if ref >= 0.01:
                    active_frames += n
                    suspect = proc <= ref * 0.01
            else:
                invalid_frames += n
            if suspect and start is None:
                start = pos
            if not suspect and start is not None:
                segments.append({"startSeconds": start / rate, "durationSeconds": (pos-start) / rate})
                start = None
            pos += n
        finish_zero()
        if start is not None:
            segments.append({"startSeconds": start / rate, "durationSeconds": (pos-start) / rate})
    reasons = []
    if total < rate * 3600:
        reasons.append("recording shorter than one hour")
    if not active_frames:
        reasons.append("no active reference")
    if invalid_frames:
        reasons.append("non-finite samples")
    if total > active_frames:
        reasons.append("reference inactive or invalid for part of recording")
    status = "unknown" if total < rate * 3600 or not active_frames or invalid_frames else (
        "partial" if total > active_frames else "analyzed")
    return {"status": status, "reasons": reasons,
            "durationSeconds": total / rate, "activeReferenceSeconds": active_frames / rate,
            "unanalyzedSeconds": (total-active_frames) / rate, "invalidSeconds": invalid_frames / rate,
            "suspectedIntervalCount": len(segments), "suspectedIntervals": segments,
            "digitalZeroIntervalCount": len(zero_segments), "digitalZeroIntervals": zero_segments,
            "digitalZeroMinimumSeconds": 0.001,
            "windowSeconds": window / rate,
            "meaning": "suspected attenuation intervals, not proven dropouts or a pass"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("output")
    p.add_argument("--rate", type=int, required=True)
    for name in ("device", "driver", "build", "routing"):
        p.add_argument("--" + name, required=True)
    p.add_argument("--buffers", type=int, nargs="+", required=True)
    for name in ("a1", "a3"):
        p = sub.add_parser(name)
        p.add_argument("wav")
        p.add_argument("output")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args)
        else:
            result = analyze_a1(args.wav) if args.command == "a1" else analyze_a3(args.wav)
            out = new_output(args.output)
            save(out / "result.json", result)
    except (ValueError, OSError, RuntimeError) as exc:
        parser.exit(2, f"error: {exc}\n")


if __name__ == "__main__":
    main()
