"""Режет анимированные стикеры (webp) в спрайт-листы: 8 кадров в ряд, ячейка 192 px.

    python make-sprites.py mody/out

Берёт <папка>/anim-src/*.webp, кладёт <папка>/an-<имя>.webp и anim.json
({имя: {n, cols, cell, dur}}). Нужен Pillow — только для этой подготовки,
в сам ролик он не попадает.

Почему листы, а не живой webp: браузер крутит анимированную картинку по своим
часам, и при покадровом рендере кадры стикера выходили бы случайными. Кадр
спрайта считается от времени таймлайна — рендер повторяется один в один.
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageSequence

COLS, CELL = 8, 192
root = Path(sys.argv[1])
meta = {}
for src in sorted((root / 'anim-src').glob('*.webp')):
    im = Image.open(src)
    frames, dur = [], 0
    for fr in ImageSequence.Iterator(im):
        frames.append(fr.convert('RGBA').resize((CELL, CELL), Image.LANCZOS))
        dur += fr.info.get('duration', 42)
    rows = -(-len(frames) // COLS)
    sheet = Image.new('RGBA', (COLS * CELL, rows * CELL), (0, 0, 0, 0))
    for k, fr in enumerate(frames):
        sheet.paste(fr, ((k % COLS) * CELL, (k // COLS) * CELL))
    sheet.save(root / f'an-{src.stem}.webp', quality=88, method=6)
    meta[src.stem] = {'n': len(frames), 'cols': COLS, 'cell': CELL, 'dur': round(dur / 1000, 3)}
    print(src.stem, meta[src.stem])
(root / 'anim.json').write_text(json.dumps(meta))
