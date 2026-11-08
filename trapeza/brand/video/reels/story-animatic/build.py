"""Собирает аниматик: story.json → out/index.html (+ копия персонажа)."""
import json, shutil
from pathlib import Path
S = Path(__file__).resolve().parent
d = json.loads((S / 'story.json').read_text(encoding='utf-8'))
html = (S / 'template.html').read_text(encoding='utf-8').replace('__DATA__', json.dumps(d, ensure_ascii=False)).replace('__T__', str(d['T']))
(S / 'out').mkdir(exist_ok=True); (S / 'out' / 'index.html').write_text(html, encoding='utf-8')
shutil.copy(S.parent / 'engine' / 'mascot3d.js', S / 'out' / 'mascot3d.js')
print('ok', d['T'])
