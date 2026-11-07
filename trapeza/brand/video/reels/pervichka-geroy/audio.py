"""Звук «Первичка — герой»: бит на 120 ударов, хлопок на каждое появление, звон на оплате, аккорд на цене.
Времена — те же, что в template.html (тайминг записан там же вручную, ролик без голоса)."""
import sys, wave
import numpy as np
from pathlib import Path
ENGINE = Path(__file__).resolve().parent.parent / 'engine'
TT = 20.9
exec(open(ENGINE / 'synth.py').read().replace('T = 12.0', f'T = {TT}'))
t = 0.0
while t < TT - 0.7:
    place(kick(), t, 0.16); place(hat(), t + 0.25, 0.04, 0.3); t += 0.5
place(tone(55, TT, a=0.05, dec=4, harm=(1.0, 0.4, 0.15)), 0, 0.06)
# телефон влетает, сообщения
place(whoosh(0.4, up=True), 0.0, 0.14)
for x in (0.8, 1.75, 2.5): place(pop(850), x, 0.14)
place(tone(1318.5, 0.3, dec=0.15, harm=(1, 0.5)), 1.78, 0.07)
place(whoosh(0.3, up=False), 3.0, 0.12); place(boom(0.5), 3.1, 0.1)
# слова «Документы внутри Telegram»
for x in (3.45, 3.95, 4.45): place(pop(700 + int((x - 3.45) * 200)), x, 0.15)
place(boom(0.5), 4.45, 0.18); place(shimmer(0.5), 4.85, 0.06)
place(whoosh(0.3, up=False), 5.7, 0.12)
# шаги
for x in (6.05, 6.95, 7.85): place(pop(900), x, 0.15); place(whoosh(0.25, up=True), x - 0.1, 0.1)
place(whoosh(0.3, up=False), 8.9, 0.12)
# счёт с QR, оплата
place(whoosh(0.4, up=True), 9.2, 0.14); place(pop(800), 9.15, 0.12)
place(shimmer(0.6), 10.0, 0.05)
for k in range(3): place(pop(1000 + k * 150), 10.9 + k * 0.1, 0.14)
place(clang(0.4), 10.85, 0.18)
for f in (659.3, 880, 1318.5): place(tone(f, 0.6, dec=0.3), 10.85, 0.05)
for j in range(8): place(click(0.006, 0.8), 10.95 + j * 0.1, 0.05)
place(whoosh(0.3, up=False), 12.0, 0.12)
# список
for k in range(4): place(pop(760 + k * 90), 12.35 + k * 0.5, 0.14); place(whoosh(0.2, up=True), 12.25 + k * 0.5, 0.09)
place(whoosh(0.3, up=False), 15.2, 0.12)
# цена и призыв
place(pop(700), 15.55, 0.15); place(boom(0.6), 16.0, 0.2)
place(whoosh(0.45, up=True), 16.1, 0.14)
for f in (523.3, 659.3, 784, 1046.5): place(tone(f, 1.0, dec=0.5, harm=(1, 0.3)), 16.2, 0.05)
for k in range(3): place(pop(900 + k * 120), 17.2 + k * 0.18, 0.12)
place(pop(1000), 18.0, 0.18); place(tone(1568, 0.4, dec=0.2), 18.05, 0.06)
mix *= 0.89 / np.max(np.abs(mix))
mix = np.tanh(mix * 1.1) / np.tanh(1.1); mix *= 0.85 / np.max(np.abs(mix))
with wave.open(sys.argv[1], 'wb') as o:
    o.setnchannels(2); o.setsampwidth(2); o.setframerate(SR); o.writeframes((mix * 32767).astype(np.int16).tobytes())
print('ok')
