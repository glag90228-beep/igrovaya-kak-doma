"""Звук рекламы: мягкий бит, «вжух» на переходах, лёгкие хлопки на ключевых словах, тихие щелчки на словах вместо голоса.
Когда запись голоса будет, она кладётся поверх (см. README). Времена берутся из story.json."""
import json, sys, wave
import numpy as np
from pathlib import Path
HERE = Path(__file__).resolve().parent
D = json.load(open(HERE / 'story.json', encoding='utf-8'))
TT, BEAT = D['T'], 60 / D['bpm']
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
    place(whoosh(0.4, up=s['trans'] != 'left'), s['start'] - 0.1, 0.14)
    if s['trans'] == 'circle': place(boom(0.5), s['start'] + 0.2, 0.12)
for a, bb in D['risers']: place(whoosh(bb - a, up=True), a, 0.12)
for a, bb, txt in D['vo']:
    words = txt.split(' '); wts = [len(w.replace('*', '')) + 2 for w in words]; sm = sum(wts); acc = a
    for w, k in zip(words, wts):
        t0 = acc; acc += (bb - a) * k / sm
        place(click(0.004, 0.5), t0, 0.03)
        if '*' in w: place(pop(900), t0, 0.1)
for c in D['clicks']: place(pop(1500), c, 0.09); place(click(0.006, 0.9), c, 0.06)   # нажатия героя
place(shimmer(0.7), 30.4, 0.06)                                    # долг закрыт
for k in range(5): place(pop(900 + k * 90), 30.4 + k * 0.08, 0.08)
mix *= 0.89 / np.max(np.abs(mix)); mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.85 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
