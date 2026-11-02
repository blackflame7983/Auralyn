"""同じ条件の2 WAVから、聞き手ごとの盲検A/Bを作る。"""
import argparse
import json
import random
import re
import struct
from pathlib import Path

SUBFORMAT_PCM = bytes.fromhex("0100000000001000800000aa00389b71")
SUBFORMAT_FLOAT = bytes.fromhex("0300000000001000800000aa00389b71")


def identifier(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise ValueError("IDは英数字、ハイフン、アンダースコアの1〜64文字です")
    return value


def wav_info(path):
    with path.open("rb") as source:
        header = source.read(12)
        if len(header) != 12:
            raise ValueError("WAVヘッダーが不足しています")
        riff, size, kind = struct.unpack("<4sI4s", header)
        if riff != b"RIFF" or kind != b"WAVE" or size + 8 != path.stat().st_size:
            raise ValueError("不正なWAVです")
        fmt = data = None
        while source.tell() < size + 8:
            chunk = source.read(8)
            if len(chunk) != 8:
                raise ValueError("不正なチャンクです")
            name, length = struct.unpack("<4sI", chunk)
            start = source.tell()
            if start + length + (length % 2) > size + 8:
                raise ValueError("WAVデータが不足しています")
            if name == b"fmt ":
                if fmt is not None or not 16 <= length <= 40:
                    raise ValueError("不正な形式です")
                fmt = source.read(length)
            elif name == b"data":
                if data is not None:
                    raise ValueError("複数のdataは未対応です")
                data = (start, length)
            source.seek(start + length + length % 2)
        if fmt is None or data is None:
            raise ValueError("形式または音声がありません")
        tag, channels, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", fmt[:16])
        if tag == 0xfffe:
            if len(fmt) != 40:
                raise ValueError("拡張WAVの形式長が不正です")
            extra, valid_bits, mask = struct.unpack("<HHI", fmt[16:24])
            subtype = fmt[24:40]
            if (extra != 22 or valid_bits != bits or subtype not in (SUBFORMAT_PCM, SUBFORMAT_FLOAT)
                    or mask & ~0x3ffff or (mask and mask.bit_count() != channels)):
                raise ValueError("拡張WAVの形式が未対応または不正です")
            tag = 1 if subtype == SUBFORMAT_PCM else 3
        else:
            # 従来どおり基本16バイトだけを出力する。
            fmt = fmt[:16]
        if (tag not in (1, 3) or not channels or not rate or bits not in (8, 16, 24, 32)
                or (tag == 3 and bits != 32) or align != channels * (bits // 8)
                or byte_rate != rate * align or not data[1] or data[1] % align):
            raise ValueError("非圧縮PCMまたは32bit float WAVが必要です")
        return fmt, data


def copy_pcm(source_path, target_path, info):
    # 元ファイル名や付随チャンクを配布せず、PCMだけを新規WAVへ書く。
    fmt, (offset, length) = info
    with source_path.open("rb") as source, target_path.open("xb") as target:
        target.write(struct.pack("<4sI4s4sI", b"RIFF", 20 + len(fmt) + length + length % 2, b"WAVE", b"fmt ", len(fmt)))
        target.write(fmt)
        target.write(struct.pack("<4sI", b"data", length))
        source.seek(offset)
        remaining = length
        while remaining:
            block = source.read(min(65536, remaining))
            if not block:
                raise ValueError("WAVデータが不足しています")
            target.write(block)
            remaining -= len(block)
        if length % 2:
            target.write(b"\0")


def prepare(first, second, listener, seed, output, key):
    label1, path1 = identifier(first[0]), Path(first[1]).resolve(strict=True)
    label2, path2 = identifier(second[0]), Path(second[1]).resolve(strict=True)
    listener = identifier(listener)
    output, key = Path(output).resolve(), Path(key).resolve()
    if label1 == label2 or path1 == path2:
        raise ValueError("異なる条件IDとファイルを指定してください")
    if key == output or output in key.parents or key in output.parents:
        raise ValueError("対応表は配布フォルダと別の場所に置いてください")
    if output.exists() or key.exists():
        raise ValueError("出力先または対応表が既に存在します")
    if not output.parent.is_dir() or not key.parent.is_dir():
        raise ValueError("出力先の親フォルダが必要です")
    if output in path1.parents or output in path2.parents:
        raise ValueError("入力を配布先に置けません")
    p1, p2 = wav_info(path1), wav_info(path2)
    if p1[0] != p2[0] or p1[1][1] != p2[1][1]:
        raise ValueError("WAVの形式、レート、チャンネル、長さを揃えてください")
    cases = [(label1, path1), (label2, path2)]
    random.Random(seed).shuffle(cases)
    # 途中失敗時も既存データを上書きしない。残った新規出力は操作者が確認する。
    with key.open("x", encoding="utf-8") as out:
        json.dump({"listener_id": listener, "seed": seed,
                   "A": cases[0][0], "B": cases[1][0]}, out, ensure_ascii=False, indent=2)
        out.write("\n")
    output.mkdir()
    for name, (_, source) in zip(("A.wav", "B.wav"), cases):
        copy_pcm(source, output / name, p1 if source == path1 else p2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--first", nargs=2, required=True, metavar=("ID", "WAV"))
    parser.add_argument("--second", nargs=2, required=True, metavar=("ID", "WAV"))
    parser.add_argument("--listener", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--key", required=True)
    args = parser.parse_args()
    try:
        prepare(args.first, args.second, args.listener, args.seed, args.output, args.key)
    except (ValueError, OSError, EOFError, struct.error) as exc:
        # OSエラーに素材パスが含まれ得るので詳細を表示しない。
        parser.exit(2, f"作成失敗（{type(exc).__name__}）。入力と出力先を確認してください。\n")
    print("盲検A/Bと対応表を作成しました。対応表は配布しないでください。")


if __name__ == "__main__":
    main()
