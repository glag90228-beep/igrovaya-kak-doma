"""Звук «Моды»: тихий бит, тревога на «видит», капли пазлов, щелчки печати, щелчок рубильника на --safe-mode. Голос — из voice/voice.wav, если есть."""
import json, os, sys, wave
import numpy as np
from pathlib import Path
HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / 'engine'
E = json.load(open(HERE / 'events.json'))
EV, TT = E['EV'], E['T']
exec(open(ENGINE / 'synth.py').read().replace('T = 12.0', f'T = {TT}'))
S = EV['s']
t = 0.0
while t < TT - 0.9:
    place(kick(), t, 0.2); place(hat(), t + 0.25, 0.05, 0.3); t += 0.5
place(tone(43.65, TT, a=0.05, dec=4, harm=(1.0, 0.4, 0.15)), 0, 0.08)
for j in range(14): place(click(0.008, 0.6), 0.05 + j * 0.09, 0.04)
for k in range(9): place(pop(700 + k * 60), EV['mods'] + k * 0.03, 0.06)
place(glitch(0.25), EV['sees'], 0.25); place(boom(0.7), EV['sees'], 0.3)
for k in range(3): place(tone(880, 0.12, dec=0.08), EV['sees'] + 0.25 + k * 0.18, 0.06)
place(whoosh(0.35, up=True), S[1] - 0.1, 0.15); place(clang(0.3), EV['off1'], 0.12)
place(whoosh(0.35, up=False), S[2], 0.15); place(pop(1100), EV['oct'], 0.2)
for key in ['ui', 'pr', 'cmd']: place(whoosh(0.25, up=True), EV[key] - 0.1, 0.12); place(pop(900), EV[key] + 0.15, 0.15)
for k in range(16): place(pop(500 + (k * 137) % 700), EV['weeks'] + (k % 8) * 0.12 + (k // 8) * 0.55 + 0.6, 0.05)
place(boom(0.5), EV['k'] + 0.2, 0.2); place(shimmer(0.8), EV['skills'], 0.05)
for k in range(12): place(click(0.006, 0.8), EV['n359'] + k * 0.05, 0.04)
for k in range(10): place(tone(659.3, 0.08, dec=0.05), EV['n111'] + k * 0.08, 0.04)
for k in range(8): place(tone(987.8, 0.08, dec=0.05), EV['n75'] + k * 0.08, 0.04)
place(tone(1318.5, 0.35, dec=0.2, harm=(1, 0.5)), EV['harm'], 0.06)
place(glitch(0.2), EV['nosb'], 0.2); place(clang(0.4), EV['nosb'] + 0.05, 0.2)
for key in ['rights', 'files', 'keys']: place(pop(800), EV[key], 0.18)
for k, key in enumerate(['auth', 'code']): place(tone([1046.5, 1318.5][k], 0.3, dec=0.15), EV[key], 0.07)
for j in range(18): place(click(0.008, 0.7), EV['safe'] - 0.5 + j * 0.045, 0.06)
place(clang(0.5), EV['off'] - 0.15, 0.3); place(boom(0.6), EV['off'] - 0.1, 0.25)
for f, dt in [(880, 0.3), (1318.5, 0.37)]: place(tone(f, 0.4, dec=0.2), EV['off'] + dt, 0.07)
place(pop(900), S[8], 0.25); place(whoosh(0.3, up=True), TT - 1.0, 0.2); place(whoosh(0.3, up=True), TT - 0.8, 0.2)
VW = HERE / 'voice' / 'voice.wav'
if os.path.exists(VW):
    mix *= 0.32 / max(1e-9, np.max(np.abs(mix)))
    with wave.open(VW) as w:
        v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767
        if w.getnchannels() == 2: v = v.reshape(-1, 2).mean(axis=1)
    v = v[:len(mix)] * (0.95 / max(1e-9, np.max(np.abs(v))))
    mix[:len(v), 0] += v; mix[:len(v), 1] += v
mix *= 0.89 / np.max(np.abs(mix))
mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.85 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
