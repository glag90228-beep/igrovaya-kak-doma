"""Звуковые эффекты для рилсов — синтез на numpy, без сэмплов и без лицензий на звук.

Подключается из audio.py ролика так:
    exec(open(ENGINE / 'synth.py').read().replace('T = 12.0', f'T = {TT}'))
После этого доступны SR, mix (стерео-дорожка длиной T) и генераторы ниже.
place(звук, время, громкость, панорама) кладёт звук на дорожку.

Первый вариант модуля пропал вместе с контейнером; этот написан заново под те же
имена и сигнатуры, поэтому старые audio.py работают без правок. Тембр подобран
на слух заново и может отличаться от звука в уже отрендеренных роликах.
"""
import numpy as np

SR = 44100
T = 12.0
mix = np.zeros((int(SR * T) + SR, 2))
_rng = np.random.default_rng(7)          # шум одинаковый при каждой сборке — звук не «плывёт» между рендерами


def _t(d):
    return np.arange(int(SR * d)) / SR


def _env(n, a=0.005, dec=0.2):
    t = np.arange(n) / SR
    att = np.clip(t / max(a, 1e-4), 0, 1)
    return att * np.exp(-t / max(dec, 1e-4))


def place(sig, t, gain=1.0, pan=0.0):
    """Кладёт моно-звук на дорожку; pan от -1 (лево) до 1 (право)."""
    i = int(round(max(0.0, t) * SR))
    if i >= len(mix):
        return
    s = sig[: len(mix) - i] * gain
    l, r = np.sqrt((1 - pan) / 2), np.sqrt((1 + pan) / 2)
    mix[i:i + len(s), 0] += s * l * 1.414
    mix[i:i + len(s), 1] += s * r * 1.414


def tone(f, d, a=0.005, dec=0.3, harm=(1.0,)):
    t = _t(d)
    s = sum(h * np.sin(2 * np.pi * f * (k + 1) * t) for k, h in enumerate(harm))
    return s * _env(len(t), a, dec) / max(1.0, sum(harm))


def kick():
    t = _t(0.35)
    f = 50 + 110 * np.exp(-t / 0.03)                 # частота падает — «удар», а не «бип»
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)


def hat():
    n = int(SR * 0.06)
    s = np.diff(_rng.standard_normal(n + 1))          # дифференцированный шум — остаются только верха
    return s * _env(n, 0.001, 0.015) * 0.5


def click(d=0.008, bright=0.6):
    n = int(SR * d)
    s = _rng.standard_normal(n)
    if bright < 1:
        s = np.convolve(s, np.ones(3) / 3, 'same') * (1 - bright) + s * bright
    return s * _env(n, 0.0005, d / 3)


def pop(f=900):
    t = _t(0.12)
    ff = f * (1 + 0.6 * np.exp(-t / 0.015))
    return np.sin(2 * np.pi * np.cumsum(ff) / SR) * _env(len(t), 0.001, 0.04)


def whoosh(d=0.35, up=True):
    n = int(SR * d)
    s = _rng.standard_normal(n)
    k = np.linspace(0.02, 0.4, n) if up else np.linspace(0.4, 0.02, n)
    out, y = np.zeros(n), 0.0
    for i in range(n):                                # однополюсный фильтр с бегущей частотой среза
        y += k[i] * (s[i] - y)
        out[i] = y
    return out * np.sin(np.pi * np.arange(n) / n) ** 2 * 2.5


def boom(d=0.7):
    t = _t(d)
    f = 38 + 60 * np.exp(-t / 0.08)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (d / 3))
    return s + 0.15 * _rng.standard_normal(len(t)) * np.exp(-t / 0.03)


def glitch(d=0.2):
    n = int(SR * d)
    step = int(SR * 0.012)
    s = np.repeat(_rng.uniform(-1, 1, n // step + 1), step)[:n]     # «ступеньки» — цифровой треск
    gate = np.repeat(_rng.integers(0, 2, n // (step * 2) + 1), step * 2)[:n]
    return s * gate * 0.6


def shimmer(d=1.0):
    t = _t(d)
    s = np.zeros(len(t))
    for k, f in enumerate([1568, 2093, 2637, 3136, 4186]):
        s += np.sin(2 * np.pi * f * t + k) * (0.5 + 0.5 * np.sin(2 * np.pi * (3 + k) * t))
    return s * np.sin(np.pi * t / d) / 5


def clang(d=0.4):
    t = _t(d)
    s = sum(np.sin(2 * np.pi * f * t) * w for f, w in [(523, 1), (1187, 0.6), (1931, 0.4), (2797, 0.25)])
    return s * _env(len(t), 0.001, d / 4) / 2.2
