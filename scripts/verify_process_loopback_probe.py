"""段階0の実機試験。対象は自分で起動したsourceだけ。通常設定を変更しない。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid


def execute(binary: Path, arguments: list[str], directory: Path, name: str, timeout: float = 12) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(binary), *arguments], capture_output=True, text=True, encoding="utf-8",
        timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    (directory / f"{name}.stdout").write_text(result.stdout, encoding="utf-8")
    (directory / f"{name}.stderr").write_text(result.stderr, encoding="utf-8")
    return result


def start_source(binary: Path, directory: Path, mode: str, seconds: int, endpoint: str | None = None, frequency: int | None = None) -> tuple[subprocess.Popen, dict, Path]:
    tag = mode + "-" + uuid.uuid4().hex[:8]
    ready = directory / f"{tag}.ready.json"
    stdout = (directory / f"{tag}.source.stdout").open("x", encoding="utf-8")
    stderr = (directory / f"{tag}.source.stderr").open("x", encoding="utf-8")
    try:
        process = subprocess.Popen(
            [str(binary), mode, str(seconds), str(ready), *([endpoint] if endpoint else []), *([str(frequency)] if frequency is not None and endpoint else [])], stdout=stdout, stderr=stderr,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    finally:
        stdout.close()
        stderr.close()
    deadline = time.monotonic() + 6
    try:
        identity = None
        while time.monotonic() < deadline and process.poll() is None:
            try:
                identity = json.loads(ready.read_text(encoding="utf-8"))
                break
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.02)
        if identity is None:
            raise RuntimeError(f"source開始失敗: {mode}")
        if identity["pid"] != process.pid:
            raise RuntimeError("sourceのPIDが不一致です")
        return process, identity, ready
    except BaseException:
        stop_owned(process)
        raise


def stop_owned(process: subprocess.Popen) -> None:
    # 起動して保持している子だけを回収する。PID名による一括終了は行わない。
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=5)


def capture(binary: Path, directory: Path, identity: dict, name: str, seconds: int = 3, cancel_ms: int | None = None) -> tuple[subprocess.CompletedProcess[str], dict | None, Path]:
    destination = directory / f"{name}.wav"
    arguments = ["capture", str(identity["pid"]), str(identity["created"]), str(seconds), str(destination)]
    if cancel_ms is not None:
        arguments.append(str(cancel_ms))
    result = execute(binary, arguments, directory, name, timeout=seconds + 8)
    return result, json.loads(result.stdout) if result.returncode == 0 else None, destination


def verify_capture(result: subprocess.CompletedProcess[str], report: dict | None, expected_end: str) -> None:
    if result.returncode != 0 or report is None:
        raise RuntimeError(f"取得失敗: {result.stderr.strip()}")
    stats = report["capture"]
    if stats["ended"] != expected_end:
        raise RuntimeError(f"終了理由が不一致です: {stats['ended']}")
    if stats["nonfinite_samples"] or report["dropped_frames"] or report["recorded_frames"] != stats["frames"]:
        raise RuntimeError("非有限値または録音キューの欠落を検出しました")


def verify(binary: Path, directory: Path, allow_tone: bool, summary: dict) -> dict:
    source_binary = directory / "isolated_loopback_source.exe"
    with binary.open("rb") as source, source_binary.open("xb") as destination:
        shutil.copyfileobj(source, destination)
    summary.update({
        "probe_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "cases": {}, "positive_reference_run": allow_tone,
        "single_endpoint_gate": "not_tested", "functional_pass": False,
    })
    modes = ["source-muted", "source-volume-zero"]
    if allow_tone:
        modes.append("source-low-volume")
    for mode in modes:
        process, identity, ready = start_source(source_binary, directory, mode, 9)
        try:
            listed = execute(binary, ["list"], directory, mode + "-list")
            if listed.returncode != 0:
                raise RuntimeError("候補一覧を取得できません")
            candidates = json.loads(listed.stdout)
            matches = [value for value in candidates if value["pid"] == identity["pid"] and value["created"] == identity["created"]]
            if len(matches) != 1:
                raise RuntimeError("試験用sourceを一意な候補として取得できません")
            result, report, wave = capture(binary, directory, identity, mode)
            verify_capture(result, report, "duration")
            if not report["capture"]["frames"]:
                raise RuntimeError("取得フレームがありません")
            if mode == "source-muted":
                bad_identity = {**identity, "created": identity["created"] + 1}
                bad, _, bad_wave = capture(binary, directory, bad_identity, "invalid-identity", seconds=1)
                if bad.returncode == 0 or bad_wave.exists():
                    raise RuntimeError("生成時刻の不一致が拒否されませんでした")
                pre, _, pre_wave = capture(binary, directory, identity, "pre-cancelled", seconds=1, cancel_ms=0)
                if pre.returncode == 0 or pre_wave.exists():
                    raise RuntimeError("開始前の取消が拒否されませんでした")
                cancelled, cancelled_report, _ = capture(binary, directory, identity, "cancelled", seconds=2, cancel_ms=250)
                verify_capture(cancelled, cancelled_report, "cancelled")
                if cancelled_report["capture"]["elapsed_ms"] > 1000:
                    raise RuntimeError("取得中の取消が期限を超えました")
                before = hashlib.sha256(wave.read_bytes()).hexdigest()
                overwrite = execute(binary, ["capture", str(identity["pid"]), str(identity["created"]), "1", str(wave)], directory, "overwrite")
                if overwrite.returncode == 0 or hashlib.sha256(wave.read_bytes()).hexdigest() != before:
                    raise RuntimeError("既存の録音ファイルが保護されませんでした")
                summary["lifecycle"] = {"identity_rejected": True, "pre_cancelled_rejected": True, "cancel_elapsed_ms": cancelled_report["capture"]["elapsed_ms"], "existing_wave_preserved": True}
            process.wait(timeout=12)
            if process.returncode != 0:
                raise RuntimeError("sourceが異常終了しました")
            source_result = json.loads(ready.with_suffix(".result.json").read_text(encoding="utf-8"))
            if source_result["emitted_frames"] == 0 or source_result["source_failed"]:
                raise RuntimeError("sourceがテスト信号を生成していません")
            summary["cases"][mode] = {"source": identity, "source_result": source_result, "capture": report}
            print(json.dumps({"case": mode, "nonzero_frames": report["capture"]["nonzero_frames"], "frames": report["capture"]["frames"]}), flush=True)
        finally:
            stop_owned(process)

    # 音声の有無に依存せず、対象終了によって取得が終了することを別に確認する。
    process, identity, _ = start_source(source_binary, directory, "source-muted", 2)
    try:
        result, report, _ = capture(binary, directory, identity, "process-exit", seconds=6)
        verify_capture(result, report, "process_exited")
        summary["process_exit"] = report
    finally:
        stop_owned(process)
    if allow_tone:
        reference = summary["cases"]["source-low-volume"]["capture"]["capture"]
        if reference["nonzero_frames"] == 0 or reference["peak"] < 0.0001:
            raise RuntimeError("低音量の基準信号を取得できません")
        gate = any(summary["cases"][mode]["capture"]["capture"]["nonzero_frames"] > 0 for mode in modes[:2])
        summary["single_endpoint_gate"] = "signal_survives_source_suppression" if gate else "not_established_by_session_mute_or_volume"
    summary["functional_pass"] = True
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("src-tauri/target/debug/examples/process_loopback_probe.exe"))
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--allow-low-volume-tone", action="store_true", help="9秒間の997Hz・振幅0.002の基準音を明示的に許可する")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    directory = (args.output_dir or Path("src-tauri/target/process-loopback-probe") / ("verify-" + uuid.uuid4().hex[:10])).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    print(json.dumps({"output_directory": str(directory)}), flush=True)
    summary: dict = {}
    try:
        verify(binary, directory, args.allow_low_volume_tone, summary)
    except Exception as error:
        summary.update({"functional_pass": False, "error": str(error)})
    (directory / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0 if summary["functional_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
