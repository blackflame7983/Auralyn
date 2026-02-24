#!/usr/bin/env python3
"""
Auralyn Release Automation Script
Usage: python publish_release.py --version v0.3.0 --title "Update Title"
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# 設定
PROJECT_ROOT = Path("..").resolve()
ARTIFACTS_DIR = PROJECT_ROOT / "release_artifacts"
SETUP_FILE = "Auralyn_Setup.exe"
PORTABLE_FILE = "Auralyn_Portable.zip"
HISTORY_FILE = "release-history.json"
REPO_OWNER = "blackflame7983"
REPO_NAME = "Auralyn"

def calculate_sha256(file_path):
    """Calculates the SHA256 hash of a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

def run_command(command, cwd=None, check=True):
    """Runs a shell command."""
    try:
        print(f"Running: {' '.join(command)}")
        subprocess.run(command, cwd=cwd, check=check, shell=True) # shell=True for Windows compatibility in some envs
    except subprocess.CalledProcessError as e:
        print(f"Error executing command: {e}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Automate Auralyn Release")
    parser.add_argument("--version", required=True, help="Version string (e.g., v0.3.0)")
    parser.add_argument("--title", required=True, help="Release title")
    args = parser.parse_args()

    print(f"\033[96mStarting Auralyn Release Process for {args.version}...\033[0m")

    # 1. Validation
    setup_path = ARTIFACTS_DIR / SETUP_FILE
    portable_path = ARTIFACTS_DIR / PORTABLE_FILE
    

    if not setup_path.exists() or not portable_path.exists():
        print(f"\033[91mError: Artifacts not found in {ARTIFACTS_DIR}\033[0m")
        sys.exit(1)

    # 2. Calculate Hashes
    print("\033[93mCalculating SHA256 hashes...\033[0m")
    setup_hash = calculate_sha256(setup_path)
    portable_hash = calculate_sha256(portable_path)
    
    print(f"Setup Hash:    {setup_hash}")
    print(f"Portable Hash: {portable_hash}")

    # 3. Update release-history.json
    print(f"\033[93mUpdating {HISTORY_FILE}...\033[0m")
    
    local_json_path = ARTIFACTS_DIR / HISTORY_FILE

    # Read existing
    try:
        with open(local_json_path, 'r', encoding='utf-8') as f:
            history = json.load(f)
    except Exception as e:
        print(f"Error reading history file: {e}")
        sys.exit(1)

    # Create new entry
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    
    new_entry = {
        "version": args.version,
        "date": today,
        "title": args.title,
        "sha256": {
            "setup": setup_hash,
            "portable": portable_hash
        },
        "changes": [
            {
                "type": "feature",
                "text": "New release" 
            }
        ]
    }

    # Prepend
    history.insert(0, new_entry)

    # 書き戻し
    json_content = json.dumps(history, indent=4, ensure_ascii=False)
    
    with open(local_json_path, 'w', encoding='utf-8') as f:
        f.write(json_content)
        
    print("\033[92mJSON updated.\033[0m")

    # 4. コミットとプッシュ
    print("\033[93mPushing JSON update to GitHub...\033[0m")
    run_command(["git", "add", str(local_json_path)], cwd=PROJECT_ROOT)
    run_command(["git", "commit", "-m", f"release: {args.version} - {args.title}"], cwd=PROJECT_ROOT)
    run_command(["git", "push", "origin", "main"], cwd=PROJECT_ROOT)

    # 5. Create GitHub Release
    print("\033[93mCreating GitHub Release...\033[0m")
    
    # Check for gh CLI
    if shutil.which("gh"):
        repo_arg = f"{REPO_OWNER}/{REPO_NAME}"
        
        cmd = [
            "gh", "release", "create", args.version,
            str(setup_path), str(portable_path),
            "--repo", repo_arg,
            "--title", f"{args.version} - {args.title}",
            "--notes", f"Release {args.version}"
        ]
        
        run_command(cmd)
        print("\033[92mRelease created successfully on GitHub!\033[0m")
    else:
        print("\033[93mWarning: 'gh' CLI not found. Skipping release upload.\033[0m")

    print("\033[96mDone!\033[0m")

if __name__ == "__main__":
    main()
