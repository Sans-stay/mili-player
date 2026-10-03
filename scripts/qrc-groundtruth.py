# -*- coding: utf-8 -*-
"""
用参考实现（L-1124/QQMusicApi 的 tripledes.py）在真实 QRC 数据上验证解密，
拿到 ground truth，作为之后 JS 移植的比对基准。

运行：python scripts/qrc-groundtruth.py
"""
import base64
import json
import os
import sys
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".reference"))

from tripledes import DECRYPT, tripledes_crypt, tripledes_key_setup  # noqa: E402

KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Referer": "https://y.qq.com/",
    "Content-Type": "application/json",
}


def fetch_qrc(song_mid: str) -> dict:
    body = json.dumps({
        "comm": {"ct": 24, "cv": 0},
        "req": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {"songMID": song_mid, "songID": 0, "qrc": 1, "trans": 1, "roma": 1},
        },
    }).encode()
    req = urllib.request.Request("https://u.y.qq.com/cgi-bin/musicu.fcg", data=body, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())["req"]["data"]


def decrypt_qrc(hex_text: str) -> str:
    data = bytearray.fromhex(hex_text)
    schedule = tripledes_key_setup(KEY, DECRYPT)
    out = bytearray()
    for i in range(0, len(data), 8):
        out += tripledes_crypt(data[i:i + 8], schedule)
    for name, fn in (("raw", lambda b: zlib.decompress(b, -15)),
                     ("zlib", zlib.decompress)):
        try:
            return fn(bytes(out)).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            print(f"  {name} 解压失败: {exc}")
    return ""


if __name__ == "__main__":
    import hashlib

    data = fetch_qrc("0039MnYb0qxYhV")
    text = decrypt_qrc(data["lyric"])
    payload = text.encode("utf-8")
    print("明文长度:", len(payload))
    print("SHA-256:", hashlib.sha256(payload).hexdigest())
    print("行数:", len(text.splitlines()) if text else 0)
    print("前 200 字符:", repr(text[:200]))
