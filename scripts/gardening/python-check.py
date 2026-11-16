import ast
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tokenize

ROOT = Path(__file__).resolve().parents[2]


def collect():
    files = sorted((ROOT / "scripts").rglob("*.py"))
    result = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--config", str(ROOT / "ruff.toml"), "--ignore-noqa", "--no-cache", "--output-format", "json", *map(str, files)],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    diagnostics = json.loads(result.stdout)
    sources = {}
    for file in files:
        source = file.read_text(encoding="utf-8-sig")
        tree = ast.parse(source, filename=str(file))
        sources[file.resolve()] = tree
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT and re.search(r"\bnoqa\b|type:\s*ignore", token.string):
                diagnostics.append({"filename": str(file), "code": "suppression", "location": {"row": token.start[0]}, "message": "新規抑制は禁止です。入力型・例外処理を修正してください。"})
    groups = {}
    for item in diagnostics:
        file = Path(item["filename"]).resolve()
        tree = sources[file]
        line = item["location"]["row"]
        node = next((node for node in tree.body if node.lineno <= line <= node.end_lineno), tree)
        fingerprint = hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest()
        key = (file.relative_to(ROOT).as_posix(), item["code"], fingerprint)
        entry = groups.setdefault(key, {"file": key[0], "rule": f"python/{key[1]}", "hash": fingerprint, "count": 0, "line": line, "message": item["message"]})
        entry["count"] += 1
    return sorted(groups.values(), key=lambda entry: (entry["file"], entry["rule"], entry["hash"]))


if __name__ == "__main__":
    try:
        print(json.dumps(collect(), ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
