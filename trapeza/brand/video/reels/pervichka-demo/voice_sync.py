"""Запись голоса → огибающая громкости для рта героя (voice-env.json).

Рот героя раньше двигался по оценке времени слов, теперь — по настоящей громкости записи:
открыт, когда голос звучит, закрыт в паузах. Запуск: python3 voice_sync.py (нужны numpy и ffmpeg).
"""
import json, subprocess
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
FPS = 50
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(HERE / 'voice.m4a'), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'],
                     capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
hop = 16000 // FPS
n = len(x) // hop
rms = np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1))
# Лёгкое сглаживание: рот не должен дрожать на каждом отсчёте, но и не запаздывать за слогом.
sm = np.copy(rms)
for i in range(1, n):
    sm[i] = max(rms[i], sm[i - 1] * 0.55) if rms[i] > sm[i - 1] else sm[i - 1] * 0.55 + rms[i] * 0.45
ref = np.percentile(sm[sm > np.percentile(sm, 30)], 90)
v = np.clip(sm / ref, 0, 1) ** 0.75
v[sm < ref * 0.07] = 0                         # паузы — рот закрыт
out = {'fps': FPS, 'dur': round(len(x) / 16000, 3), 'v': [round(float(a), 2) for a in v]}
(HERE / 'voice-env.json').write_text(json.dumps(out), encoding='utf-8')
print('ok', out['dur'], 'с,', n, 'кадров, открыт', f"{(v > 0.1).mean():.0%} времени")
