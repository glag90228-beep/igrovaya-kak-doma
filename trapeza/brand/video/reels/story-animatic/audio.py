"""Звук аниматика: бит 120 BPM, «дроп»-тишина перед раскрытием, райзеры, вжух на каждом переходе, хлопки на ключевых словах,
тихие щелчки на словах — вместо голоса, чтобы на слух чувствовался ритм. Всё берётся из story.json."""
import json, sys, wave
import numpy as np
from pathlib import Path
HERE = Path(__file__).resolve().parent
D = json.load(open(HERE / 'story.json', encoding='utf-8'))
TT, BEAT = D['T'], 60 / D['bpm']
exec(open(HERE.parent / 'engine' / 'synth.py').read().replace('T = 12.0', f'T = {TT}'))
silent = lambda t: any(a <= t < b for a, b in D['drops'])
b = 0
while b * BEAT < TT - 0.6:
    t = b * BEAT
    if not silent(t):
        place(kick(), t, 0.17)
        if b % 2: place(click(0.01, 0.9), t, 0.10)            # «снейр» на 2 и 4 долю
        place(hat(), t + BEAT / 2, 0.04, 0.3)
        if b % 8 in (0, 3): place(tone(55, 0.3, a=0.01, dec=0.2, harm=(1.0, 0.5)), t, 0.14)
    b += 1
for i, s in enumerate(D['scenes']):
    if i == 0: continue
    t = s['start']; tr = s['trans']
    place(whoosh(0.3, up=tr != 'whip'), t - 0.15, 0.13)
    if tr in ('flash', 'punch'): place(boom(0.4), t, 0.16)
    if tr == 'glitch': place(glitch(0.25), t, 0.12)
    if tr == 'zoom': place(shimmer(0.5), t, 0.07)
for a, bb in D['risers']: place(whoosh(bb - a, up=True), a, 0.16)
place(boom(0.9), 30.0, 0.26)                                    # удар после «дропа»
for a, bb, txt in D['vo']:
    words = txt.split(' '); wts = [len(w.replace('*', '')) + 2 for w in words]; sm = sum(wts); acc = a
    for w, k in zip(words, wts):
        t0 = acc; acc += (bb - a) * k / sm
        place(click(0.004, 0.5), t0, 0.035)                      # тихий щелчок вместо голоса
        if '*' in w: place(pop(900), t0, 0.12)
place(tone(1046.5, 0.5, dec=0.3), D['scenes'][5]['start'] + 0.3, 0.08)   # раскрытие
mix *= 0.89 / np.max(np.abs(mix)); mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.85 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
