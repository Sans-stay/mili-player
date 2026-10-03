# -*- coding: utf-8 -*-
"""
生成测试用的音频文件：
  testdata/周杰伦 - 晴天.wav   真实可播放的 WAV（文件名用来测「无标签时回退到文件名」）
  testdata/tagged.mp3          合成 MP3：ID3v2.3 标签 + 内嵌封面，用来验证标签解析
运行：python scripts/make-testdata.py
"""
import math
import os
import struct
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "testdata")
os.makedirs(OUT, exist_ok=True)

RATE = 22050


def make_wav(path, seconds=30.0):
    """一段很轻的五声音阶循环，够用来确认「真的有声音」"""
    notes = [523.25, 587.33, 659.25, 783.99, 880.00, 783.99, 659.25, 587.33]
    note_len = 0.55
    total = int(RATE * seconds)
    frames = bytearray()

    for i in range(total):
        t = i / RATE
        idx = int(t / note_len) % len(notes)
        freq = notes[idx]
        pos_in_note = (t % note_len) / note_len

        # 每个音符首尾做淡入淡出，避免爆音
        env = min(1.0, pos_in_note * 12) * min(1.0, (1 - pos_in_note) * 6)
        sample = math.sin(2 * math.pi * freq * t) * 0.22 * env
        sample += math.sin(2 * math.pi * freq * 2 * t) * 0.06 * env      # 加一点泛音

        frames += struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 32767))

    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(bytes(frames))
    print(f"{os.path.relpath(path, ROOT)}  {seconds}s / {RATE}Hz")


def id3_frame(frame_id, payload):
    """ID3v2.3 的帧：4 字节 ID + 4 字节大端长度 + 2 字节标志"""
    return frame_id.encode("ascii") + struct.pack(">I", len(payload)) + b"\x00\x00" + payload


def text_frame(frame_id, text, enc=0):
    """
    默认故意写成「编码 0(ISO-8859-1) + 实际 UTF-8」——
    这是中文标注工具极常见的组合，正好用来验证解析器的容错。
    """
    if enc == 0:
        return id3_frame(frame_id, b"\x00" + text.encode("utf-8"))
    if enc == 3:
        return id3_frame(frame_id, b"\x03" + text.encode("utf-8"))
    return id3_frame(frame_id, b"\x01" + "\ufeff".encode("utf-16-be") + text.encode("utf-16-be"))


def make_tagged_mp3(path):
    """手工拼一个 ID3v2.3 标签 + 假音频数据，专门喂给标签解析器"""
    # 1x1 红色 PNG
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
        "00000049454e44ae426082"
    )
    apic_payload = b"\x00" + b"image/png\x00" + b"\x03" + b"\x00" + png

    frames = (
        text_frame("TIT2", "测试歌曲")
        + text_frame("TPE1", "测试艺术家")
        + text_frame("TALB", "测试专辑")
        + id3_frame("APIC", apic_payload)
    )

    size = len(frames)
    syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    header = b"ID3\x03\x00\x00" + syncsafe

    with open(path, "wb") as f:
        f.write(header + frames + b"\xff\xfb\x90\x00" + b"\x00" * 512)
    print(f"{os.path.relpath(path, ROOT)}  {len(header) + size + 516} 字节")


if __name__ == "__main__":
    make_wav(os.path.join(OUT, "周杰伦 - 晴天.wav"))
    make_tagged_mp3(os.path.join(OUT, "tagged.mp3"))
