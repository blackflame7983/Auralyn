#!/usr/bin/env python3
"""Compatibility wrapper for the canonical Auralyn release uploader.

This command intentionally delegates to upload-release-to-public-repo.cjs so
all public releases pass the same repository, GPL/ASIO checks, and
Corresponding Source generation gate.
"""

import argparse
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOADER = PROJECT_ROOT / "scripts" / "upload-release-to-public-repo.cjs"


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish an Auralyn release")
    parser.add_argument("--version", required=True, help="Version string (for example: v1.1.0)")
    parser.add_argument(
        "--title",
        help="Deprecated compatibility option. GitHub release title is derived from the tag.",
    )
    args = parser.parse_args()

    if args.title:
        print("Note: --title is retained for compatibility and is not forwarded.")

    command = ["node", str(UPLOADER), args.version]
    completed = subprocess.run(command, cwd=PROJECT_ROOT, check=False)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
