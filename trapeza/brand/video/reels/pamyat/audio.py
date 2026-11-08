"""Звук «Память Claude»: тихий бит, звон на «забыл», щелчки печати, «дзинь» лампочки, волшебство /init. Голос — из voice/voice.wav, если есть."""
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
place(glitch(0.2), EV['forgot'], 0.25); place(boom(0.7), EV['forgot'], 0.3)
for k in range(5): place(tone([1568, 1318.5, 1046.5, 880, 698.5][k], 0.25, dec=0.15), EV['forgot'] + 0.1 + k * 0.07, 0.05)
place(whoosh(0.35, up=True), S[1] - 0.1, 0.15); place(shimmer(1.0), EV['foryou'] - 0.2, 0.05)
place(whoosh(0.35, up=False), S[2], 0.15); place(pop(1100), EV['fname'] - 0.1, 0.25); place(whoosh(0.4, up=True), EV['folder'] + 0.3, 0.2)
for k in range(3):
    t0 = EV['each'] - 0.15 + k * 0.6
    place(pop(800), t0, 0.15); place(tone(1318.5, 0.35, dec=0.2, harm=(1, 0.5)), t0 + 0.4, 0.07)
for key in ['style', 'ban', 'cmds', 'r1', 'r2']:
    for j in range(6): place(click(0.008, 0.6), EV[key] + j * 0.06, 0.05)
for f, dt in [(880, 0), (1318.5, 0.07)]: place(tone(f, 0.4, dec=0.2), EV['norep'] + dt, 0.07)
place(clang(0.4), EV['no'], 0.25)
for j in range(6): place(click(0.008, 0.7), EV['slash'] - 0.15 + j * 0.06, 0.07)
place(shimmer(1.2), EV['study'], 0.05)
w0 = EV['study'] + 7 * 0.12 + 0.05
for k in range(5): place(tone([1046.5, 1174.7, 1318.5, 1568, 1760][k], 0.3, dec=0.15), w0 + k * 0.17 + 0.15, 0.05)
place(boom(0.6), EV['self'], 0.2)
place(pop(900), S[7], 0.25); place(whoosh(0.3, up=True), TT - 1.0, 0.2); place(whoosh(0.3, up=True), TT - 0.8, 0.2)
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
