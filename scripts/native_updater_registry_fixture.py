"""テスト用 Uninstall キーだけを所有し、完全一致時のみ削除する。"""
import ctypes
import json
import sys
import winreg
import os
import stat
from pathlib import Path

BASE = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
VIEW = winreg.KEY_WOW64_64KEY
NEW = 1
advapi = ctypes.WinDLL("advapi32", use_last_error=True)
create = advapi.RegCreateKeyExW
create.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_wchar_p,
                   ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p,
                   ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_ulong)]
create.restype = ctypes.c_long


def exact(key, location):
    count, values, _ = winreg.QueryInfoKey(key)
    if count != 0 or values != 3:
        return False
    expected = {"DisplayName": ("Auralyn", winreg.REG_SZ),
                "InstallLocation": (location, winreg.REG_SZ),
                "WindowsInstaller": (0, winreg.REG_DWORD)}
    actual = {}
    for index in range(values):
        name, value, kind = winreg.EnumValue(key, index)
        actual[name] = (value, kind)
    return actual == expected


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--check-paths':
        root = Path(sys.argv[2]).absolute()
        paths = [root, *root.parents]
        for directory, dirs, files in os.walk(root, followlinks=False):
            paths.extend(Path(directory) / name for name in [*dirs, *files])
        for path in paths:
            if path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('reparse point in fixture path')
        print(json.dumps({'status': 'paths_checked', 'count': len(paths)}))
        return
    if len(sys.argv) != 3:
        raise ValueError("expected GUID name and install location")
    name, location = sys.argv[1:]
    import re
    if not re.fullmatch(r"\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}", name):
        raise ValueError("invalid fixture GUID")
    created = False
    key = None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, BASE, 0, winreg.KEY_CREATE_SUB_KEY | VIEW) as parent:
            handle = ctypes.c_void_p()
            disposition = ctypes.c_ulong()
            status = create(int(parent), name, 0, None, 0,
                            winreg.KEY_READ | winreg.KEY_WRITE | VIEW, None,
                            ctypes.byref(handle), ctypes.byref(disposition))
            if status:
                raise OSError(status, "RegCreateKeyExW failed")
            # winreg の操作は整数HANDLEも受け取る。PyHKEY型は直接構築できない。
            key = handle.value
            created = disposition.value == NEW
            if disposition.value != NEW:
                raise RuntimeError("fixture key already exists")
            winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, "Auralyn")
            winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, location)
            winreg.SetValueEx(key, "WindowsInstaller", 0, winreg.REG_DWORD, 0)
            if not exact(key, location):
                raise RuntimeError("fixture validation failed")
            winreg.CloseKey(key)
            key = None
            print(json.dumps({"status": "ready", "name": name, "view": 64}), flush=True)
            sys.stdin.readline()  # 親終了による EOF も後片付けへ進む。
    finally:
        if key is not None:
            winreg.CloseKey(key)
        if created:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, BASE + "\\" + name, 0, winreg.KEY_READ | VIEW) as current:
                    matches = exact(current, location)
                if matches:
                    winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, BASE + "\\" + name, VIEW, 0)
                    print(json.dumps({"status": "deleted", "name": name}), flush=True)
                else:
                    print(json.dumps({"status": "retained_mismatch", "name": name}), flush=True)
                    sys.exit(2)
            except OSError:
                print(json.dumps({"status": "retained_error", "name": name}), flush=True)
                sys.exit(2)


if __name__ == "__main__":
    main()
