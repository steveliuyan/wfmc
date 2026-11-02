# -*- coding: utf-8 -*-
"""生成 4 首「我的世界风格」的原创环境音乐（柔和钢琴 + 长尾混响 + 低频铺底）。
原创合成，无版权问题；输出 wav，再交给 ffmpeg 转 ogg。"""
import numpy as np, os, wave, struct

SR = 32000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wav')
os.makedirs(OUT, exist_ok=True)

def note(n):  # MIDI -> Hz
    return 440.0 * 2 ** ((n - 69) / 12.0)

def soft_piano(freq, dur, amp, bright=0.5):
    """加性合成：1..6 谐波，指数衰减，快起音，带轻微失谐。"""
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.exp(-t * (2.4 / max(dur, 0.4))) * (1 - np.exp(-t * 220))  # 5ms 起音
    sig = np.zeros(n)
    for h in range(1, 7):
        a = bright ** (h - 1) / h ** 1.6
        det = 1.0 + (0.0009 * (h % 2))
        sig += a * np.sin(2 * np.pi * freq * h * det * t + np.random.rand() * 6.283)
    return amp * sig * env

def bell(freq, dur, amp):
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.exp(-t * (3.2 / max(dur, 0.6))) * (1 - np.exp(-t * 300))
    sig = (np.sin(2 * np.pi * freq * t) * 0.6
           + np.sin(2 * np.pi * freq * 2.76 * t) * 0.25
           + np.sin(2 * np.pi * freq * 5.4 * t) * 0.12)
    return amp * sig * env

def pad(freqs, dur, amp):
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.minimum(1, t / 3.0) * np.minimum(1, (dur - t) / 3.0)
    sig = np.zeros(n)
    for f in freqs:
        sig += np.sin(2 * np.pi * f * t + np.random.rand() * 6.283) * 0.5
        sig += np.sin(2 * np.pi * f * 1.004 * t) * 0.5  # 轻微合唱
    lfo = 0.75 + 0.25 * np.sin(2 * np.pi * 0.07 * t)
    return amp * sig / len(freqs) * env * lfo

def reverb(x, seconds=2.2, wet=0.35, decay=3.0):
    """合成 IR（衰减噪声）做 FFT 卷积混响。"""
    n_ir = int(SR * seconds)
    ir = np.random.randn(n_ir) * np.exp(-np.arange(n_ir) / SR * decay)
    ir[: int(SR * 0.02)] *= np.linspace(0, 1, int(SR * 0.02))  # 去掉直通感
    ir /= np.max(np.abs(ir)) + 1e-9
    n = len(x) + n_ir
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    y /= np.max(np.abs(y)) + 1e-9
    out = x / (np.max(np.abs(x)) + 1e-9) * (1 - wet) + y * wet
    return out / (np.max(np.abs(out)) + 1e-9) * 0.9

def lowpass(x, cutoff):
    """一阶 IIR 低通（numpy 手写，够用）。"""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):  # 32000*90 会慢，用块向量化近似
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y

def lowpass_fast(x, cutoff):
    """FIR 低通（Hann 窗 sinc 核，FFT 卷积），温柔地削掉高频毛刺。"""
    ntap = max(5, int(SR / cutoff * 3) | 1)
    i = np.arange(ntap) - (ntap - 1) / 2
    fc = cutoff / SR
    h = 2 * fc * np.sinc(2 * fc * i) * np.hanning(ntap)
    h /= h.sum()
    n = len(x) + ntap - 1
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)
    return y[: len(x)]


def add(buf, s, sig):
    s = int(max(0, s))
    if s >= len(buf):
        return
    m = min(len(sig), len(buf) - s)
    buf[s : s + m] += sig[:m]

SCALES = {
    'major_pent': [0, 2, 4, 7, 9],
    'lydian': [0, 2, 4, 6, 7, 9, 11],
    'minor': [0, 2, 3, 5, 7, 8, 10],
    'maj7': [0, 2, 4, 5, 7, 9, 11],
}

def make_track(seed, root, scale_name, seconds, timbre, name):
    rng = np.random.default_rng(seed)
    scale = [root + s for s in SCALES[scale_name]] + [root + 12 + s for s in SCALES[scale_name]]
    n = int(SR * seconds)
    buf = np.zeros(n + SR * 4)  # 留尾巴给混响
    bpm = rng.uniform(50, 68)
    beat = 60.0 / bpm

    # 低频铺底：每 8 拍换一次和弦
    chord_deg = [0, 3, 5, 4, 2, 3, 0, 4]
    ci = 0
    t = 0.0
    while t < seconds - 8:
        rootnote = root - 12 + SCALES[scale_name][chord_deg[ci % len(chord_deg)] % len(SCALES[scale_name])]
        freqs = [note(rootnote), note(rootnote + 7), note(rootnote + 12)]
        p = pad(freqs, 8 * beat, 0.10)
        add(buf, t * SR, p)
        t += 8 * beat
        ci += 1

    # 主旋律：随机稀疏音符，落在拍上或后半拍
    t = 1.0
    last = None
    while t < seconds - 3:
        step = beat * rng.choice([1, 2, 2, 3, 4])
        if rng.random() < 0.22:  # 留白
            t += step
            continue
        d = int(rng.choice([0, 1, 2, 3, 4, 5, 6, 7]))
        if last is not None and rng.random() < 0.6:  # 级进为主
            d = max(0, min(8, last + int(rng.choice([-2, -1, -1, 0, 1, 1, 2]))))
        last = d
        f = note(scale[d % len(scale)])
        amp = rng.uniform(0.22, 0.42)
        dur = rng.uniform(1.6, 3.4)
        sig = bell(f, dur, amp * 0.55) if timbre == 'bell' else soft_piano(f, dur, amp, bright=rng.uniform(0.35, 0.65))
        add(buf, t * SR, sig)
        t += step

    # 稍微收高频，再混响
    buf = lowpass_fast(buf, 5200)
    buf = reverb(buf, seconds=2.4, wet=0.34)
    buf = buf[:n]
    fade = int(SR * 2.0)
    buf[:fade] *= np.linspace(0, 1, fade)
    buf[-fade:] *= np.linspace(1, 0, fade)
    buf *= 0.92 / (np.max(np.abs(buf)) + 1e-9)
    data = (buf * 32767).astype('<i2')
    path = os.path.join(OUT, name + '.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(name, os.path.getsize(path) // 1024, 'KB')

make_track(11, 62, 'major_pent', 96, 'piano', 'sunrise-meadow')   # D 大调五声，明亮
make_track(23, 57, 'lydian', 104, 'piano', 'calm-caves')          # A lydian，空灵低沉
make_track(37, 69, 'minor', 100, 'piano', 'rainy-window')         # A 小调，安静
make_track(53, 65, 'maj7', 92, 'bell', 'village-bells')           # F 大七，钟琴感
