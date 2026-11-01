"""Run alternating, isolated native sidecar measurements using one explicit plan."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys

PROBE = Path(__file__).with_name("native_audio_probe.py")
BLOCKED_DIRS = {"test-results", "playwright-report", "blob-report", "playwright"}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def load_plan(path):
    plan = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(plan, list) or not plan:
        raise ValueError("plan must be a nonempty array")
    labels = set()
    for step in plan:
        if not isinstance(step, dict) or not isinstance(step.get("label"), str) or not step["label"]:
            raise ValueError("every step requires a nonempty label")
        if "measure_seconds" in step:
            duration = step["measure_seconds"]
            if not number(duration) or duration <= 0 or step["label"] in labels:
                raise ValueError("measurement durations must be positive and labels unique")
            labels.add(step["label"])
    if not labels:
        raise ValueError("plan requires at least one measurement")
    return plan


def validate_result(result, plan):
    if not isinstance(result, dict) or result.get("failure") or result.get("exit_code") != 0 or result.get("errors") != []:
        raise ValueError("probe reported failure, errors, or nonzero sidecar exit")
    steps = result.get("steps")
    if not isinstance(steps, list) or len(steps) != len(plan):
        raise ValueError("probe did not complete all plan steps")
    measurements = {}
    for expected, actual in zip(plan, steps):
        if not isinstance(actual, dict) or actual.get("label") != expected["label"]:
            raise ValueError("probe steps do not match the plan")
        if "measure_seconds" not in expected:
            continue
        m = actual.get("measurement")
        samples = m.get("samples") if isinstance(m, dict) else None
        if not isinstance(samples, list) or not samples:
            raise ValueError("measurement has no samples")
        for sample in samples:
            if not isinstance(sample, dict) or any(not number(sample.get(key)) or sample[key] < 0 for key in ("elapsed", "cpu_one_core_percent", "private_bytes")):
                raise ValueError("invalid measurement sample")
        if any(samples[i]["elapsed"] <= samples[i - 1]["elapsed"] for i in range(1, len(samples))) or samples[-1]["elapsed"] < expected["measure_seconds"]:
            raise ValueError("incomplete measurement window")
        cpu = sum(s["cpu_one_core_percent"] for s in samples) / len(samples)
        private = max(s["private_bytes"] for s in samples)
        if not number(cpu) or not number(private):
            raise ValueError("invalid aggregate")
        measurements[expected["label"]] = {"cpu_one_core_mean_percent": cpu, "max_private_bytes": private}
    return measurements


def aggregate(trials, labels):
    result = {}
    for version in ("before", "after"):
        result[version] = {}
        for label in labels:
            values = [t["measurements"][label] for t in trials if t["version"] == version and t["status"] == "success"]
            if not values:
                result[version][label] = {"status": "unavailable", "repeats": 0}
                continue
            cpus = [v["cpu_one_core_mean_percent"] for v in values]
            result[version][label] = {"status": "available", "repeats": len(values),
                "cpu_one_core_mean_percent": statistics.mean(cpus), "cpu_one_core_range_percent": [min(cpus), max(cpus)],
                "cpu_one_core_stdev_percent": statistics.pstdev(cpus),
                "max_private_bytes": max(v["max_private_bytes"] for v in values)}
    return result


def run(before, after, plan_path, output, repeats):
    if repeats < 3:
        raise ValueError("at least 3 repeats per version are required")
    output = output.resolve()
    if any(part.casefold() in BLOCKED_DIRS for part in output.parts):
        raise ValueError("output cannot be inside a test-results or Playwright output directory")
    before, after, plan_path = (p.resolve(strict=True) for p in (before, after, plan_path))
    plan = load_plan(plan_path)
    paths = {"before": before, "after": after, "plan": plan_path}
    provenance = {name: {"path": str(path), "sha256": digest(path)} for name, path in paths.items()}
    output.mkdir(parents=True, exist_ok=False)
    labels = [step["label"] for step in plan if "measure_seconds" in step]
    summary = {"provenance": provenance, "repeats_per_version": repeats,
               "cpu_unit": "one logical core = 100%", "trials": [], "status": "failed"}
    try:
        for index in range(repeats):
            for version in (("before", "after") if index % 2 == 0 else ("after", "before")):
                trial = {"round": index + 1, "version": version, "status": "skipped"}
                summary["trials"].append(trial)
                directory = output / f"{index + 1:02d}-{version}"
                trial["output"] = directory.name
                stdout_log = output / f"{directory.name}.stdout.log"
                stderr_log = output / f"{directory.name}.stderr.log"
                stdout_log.write_text("", encoding="utf-8")
                stderr_log.write_text("", encoding="utf-8")
                try:
                    if any(digest(path) != provenance[name]["sha256"] for name, path in paths.items()):
                        raise ValueError("input changed during comparison")
                    completed = subprocess.run([sys.executable, str(PROBE), str(paths[version]), str(plan_path), str(directory)], capture_output=True, text=True, encoding="utf-8", errors="replace")
                    stdout_log.write_text(completed.stdout or "", encoding="utf-8")
                    stderr_log.write_text(completed.stderr or "", encoding="utf-8")
                    trial["probe_exit_code"] = completed.returncode
                    if completed.returncode != 0:
                        raise ValueError("probe exited unsuccessfully")
                    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
                    if result.get("plan") != plan or Path(result.get("binary", "")).resolve() != paths[version]:
                        raise ValueError("probe provenance does not match inputs")
                    trial["measurements"] = validate_result(result, plan)
                    if any(digest(path) != provenance[name]["sha256"] for name, path in paths.items()):
                        raise ValueError("input changed during comparison")
                    trial["status"] = "success"
                except (OSError, ValueError, TypeError, KeyError) as error:
                    trial["status"] = "failed"
                    trial["error"] = str(error)
        summary["status"] = "success" if all(t["status"] == "success" for t in summary["trials"]) else "failed"
    finally:
        summary["aggregate"] = aggregate(summary["trials"], labels)
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    try:
        summary = run(args.before, args.after, args.plan, args.output, args.repeats)
    except (OSError, ValueError) as error:
        print(f"comparison failed: {error}", file=sys.stderr)
        return 1
    print(f"{summary['status']}: {args.output / 'summary.json'}")
    return 0 if summary["status"] == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
