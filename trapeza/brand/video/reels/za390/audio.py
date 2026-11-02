"""Звук «За 390»: лёгкий бит, ценники падают, голосовое, звон оплаты, штампы, аккорд на «бесплатно». Голос — из voice/voice.wav, если есть."""
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
for x in ['p200', 'p300']: place(whoosh(0.3, up=False), EV[x] - 0.2, 0.12); place(pop(800), EV[x] + 0.1, 0.15)
place(whoosh(0.35, up=False), EV['p390'] - 0.2, 0.15); place(boom(0.5), EV['p390'] + 0.15, 0.2)
for k in range(3): place(pop(900 + k * 150), EV['all'] + k * 0.12, 0.14)
for f in [659.3, 880, 1318.5]: place(tone(f, 0.6, dec=0.3), EV['all'], 0.05)
place(whoosh(0.35, up=True), S[2] - 0.15, 0.12); place(pop(700), EV['voice'], 0.15)
for j in range(10): place(tone(300 + (j * 53) % 200, 0.06, dec=0.04), EV['voice'] + 0.1 + j * 0.07, 0.03)
place(tone(1318.5, 0.3, dec=0.15, harm=(1, 0.5)), EV['min'] - 0.15, 0.07); place(whoosh(0.35, up=True), EV['pdf'], 0.14)
place(shimmer(0.6), EV['qr'], 0.05)
for j in range(5): place(click(0.006, 0.8), EV['cam'] + 0.5 + j * 0.1, 0.06)
for f, dt in [(880, 0), (1318.5, 0.07)]: place(tone(f, 0.4, dec=0.2), EV['cam'] + 1.1 + dt, 0.07)
place(whoosh(0.3, up=True), EV['act'] - 0.1, 0.12); place(clang(0.3), EV['act'] + 0.4, 0.15)
place(whoosh(0.3, up=True), EV['upd'] - 0.1, 0.12); place(clang(0.3), EV['upd'] + 0.4, 0.15)
place(tone(1046.5, 0.3, dec=0.15), EV['form'], 0.07)
for k in range(3): place(pop(700 + k * 100), EV['see'] - 0.2 + k * 0.15, 0.1)
place(tone(784, 0.5, dec=0.3, harm=(1, 0.6, 0.3)), EV['remind'], 0.08)
for k in range(5): place(pop(800 + k * 120), EV['five'] + 0.1 + k * 0.1, 0.1)
for f in [523.3, 659.3, 784, 1046.5]: place(tone(f, 1.0, dec=0.5, harm=(1, 0.3)), EV['free'], 0.05)
place(boom(0.5), EV['free'], 0.15)
place(pop(900), S[7], 0.2); place(whoosh(0.3, up=True), TT - 1.0, 0.15); place(whoosh(0.3, up=True), TT - 0.8, 0.15)
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
