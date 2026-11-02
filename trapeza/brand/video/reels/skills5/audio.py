"""Звук «5 скиллов»: лёгкий бит, «пум» на каждом номере, щелчки печати, тиканье часов, щит, финальный аккорд. Голос — из voice/voice.wav, если есть."""
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
    place(kick(), t, 0.16); place(hat(), t + 0.25, 0.04, 0.3); t += 0.5
place(tone(55, TT, a=0.05, dec=4, harm=(1.0, 0.4, 0.15)), 0, 0.06)
place(tone(659.3, 0.25, dec=0.12), EV['half'], 0.06)
for k in range(5): place(pop(700 + k * 90), EV['five'] + k * 0.08, 0.12)
for f, dt in [(880, 0), (1318.5, 0.07)]: place(tone(f, 0.4, dec=0.2), EV['built'] + dt, 0.07)
for k in range(1, 6):
    place(whoosh(0.3, up=True), S[k] - 0.15, 0.12); place(boom(0.4), S[k] + 0.05, 0.12)
    for j in range(8): place(click(0.006, 0.7), EV[f'c{k}'] + j * 0.04, 0.04)
    place(pop(1200), EV[f'c{k}'], 0.15)
place(clang(0.25), EV['rep1'], 0.08); place(whoosh(0.3, up=False), EV['fix1'], 0.12); place(tone(1046.5, 0.3, dec=0.15), EV['fix1'] + 0.35, 0.07)
for j in range(int((S[3] - S[2]) / 0.25)): place(click(0.004, 0.9), S[2] + j * 0.25, 0.05)
for x in [EV['dep2'], EV['min2'], EV['ok2']]: place(tone(1318.5, 0.25, dec=0.12, harm=(1, 0.5)), x, 0.06)
for k in range(3): place(tone(523.3, 0.12, dec=0.06), EV['c3'] + 0.25 + k * 0.35, 0.07)
place(whoosh(0.35, up=True), EV['often3'] - 0.1, 0.12); place(tone(1046.5, 0.3, dec=0.15), EV['stop3'], 0.07)
place(click(0.01, 0.6), EV['work4'] + 0.1, 0.15); place(tone(1318.5, 0.35, dec=0.2), EV['work4'] + 0.25, 0.07)
place(glitch(0.2), EV['holes5'], 0.18); place(clang(0.4), EV['other5'], 0.2)
for k in range(5): place(pop(600 + k * 120), EV['slash'] + 0.1 + k * 0.1, 0.1)
for f in [523.3, 659.3, 784, 1046.5]: place(tone(f, 1.2, dec=0.6, harm=(1, 0.3)), EV['team'], 0.05)
place(shimmer(1.2), EV['team'], 0.05); place(boom(0.6), EV['team'], 0.18)
place(pop(900), EV['sub'] + 0.5, 0.2); place(whoosh(0.3, up=True), TT - 1.0, 0.15); place(whoosh(0.3, up=True), TT - 0.8, 0.15)
VW = HERE / 'voice' / 'voice.wav'
if os.path.exists(VW):
    mix *= 0.32 / max(1e-9, np.max(np.abs(mix)))
    with wave.open(str(VW)) as w:
        v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767
        if w.getnchannels() == 2: v = v.reshape(-1, 2).mean(axis=1)
    v = v[:len(mix)] * (0.95 / max(1e-9, np.max(np.abs(v))))
    mix[:len(v), 0] += v; mix[:len(v), 1] += v
mix *= 0.89 / np.max(np.abs(mix))
mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.85 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
