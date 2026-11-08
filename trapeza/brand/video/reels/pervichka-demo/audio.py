"""Звук рекламы: мягкий бит, «вжух» на переходах, лёгкие хлопки на ключевых словах, тихие щелчки на словах вместо голоса.
Когда запись голоса будет, она кладётся поверх (см. README). Времена берутся из story.json."""
import json, sys, wave
import numpy as np
from pathlib import Path
HERE = Path(__file__).resolve().parent
D = json.load(open(HERE / 'story.json', encoding='utf-8'))
TT, BEAT = D['T'], 60 / D['bpm']
# якоря «время замысла → время записи голоса» — те же, что в build.py
WARP = [[0.0, 0.0]]
for (_a, _b, _), (_ra, _rb) in zip(D['vo'], D['vo_real']): WARP += [[_a, _ra], [_b, _rb]]
def W(t):
    if t <= 0: return t
    for p, q in zip(WARP, WARP[1:]):
        if t <= q[0]: return p[1] + (t - p[0]) * (q[1] - p[1]) / (q[0] - p[0])
    return WARP[-1][1] + (t - WARP[-1][0])
exec(open(HERE.parent / 'engine' / 'synth.py').read().replace('T = 12.0', f'T = {TT}'))
b = 0
while b * BEAT < TT - 0.8:
    t = b * BEAT
    place(kick(), t, 0.11)
    if b % 2: place(click(0.01, 0.9), t, 0.06)
    place(hat(), t + BEAT / 2, 0.03, 0.3)
    if b % 8 in (0, 3): place(tone(55, 0.3, a=0.01, dec=0.2, harm=(1.0, 0.5)), t, 0.1)
    b += 1
for i, s in enumerate(D['scenes']):
    if i == 0: continue
    place(whoosh(0.4, up=s['trans'] != 'left'), W(s['start']) - 0.1, 0.14)
    if s['trans'] == 'circle': place(boom(0.5), W(s['start']) + 0.2, 0.12)
for a, bb in D['risers']: place(whoosh(W(bb) - W(a), up=True), W(a), 0.12)
for c in D['clicks']: place(pop(1500), W(c), 0.09); place(click(0.006, 0.9), W(c), 0.06)   # нажатия героя
place(shimmer(0.7), W(30.4), 0.06)                                 # долг закрыт
for k in range(5): place(pop(900 + k * 90), W(30.4) + k * 0.08, 0.08)
# Голос — главное. Музыку и эффекты притушаем, голос приводим к ровной громкости.
import subprocess
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(HERE / 'voice.m4a'), '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
voice = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)
voice *= 0.17 / max(np.sqrt(np.mean(voice ** 2)), 1e-6)
mix *= 0.55 / max(np.max(np.abs(mix)), 1e-6)
n = min(len(voice), len(mix)); mix[:n] += voice[:n]
mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.89 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
