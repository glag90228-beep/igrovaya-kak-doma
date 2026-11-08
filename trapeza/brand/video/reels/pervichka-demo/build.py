"""story.json → out/index.html

Замысел размечен во «времени замысла» (Td), а голос записан в своём темпе. Якоря warp — пары
«когда фраза была задумана → когда она звучит в записи»: между ними время тянется линейно, после
последнего идёт со скоростью 1. Это тянет сцены и подсветку слов, но не длительность отдельных
движений.
"""
import json
from pathlib import Path
S = Path(__file__).resolve().parent
d = json.loads((S / 'story.json').read_text(encoding='utf-8'))
warp = [[0.0, 0.0]]
for (a, b, _), (ra, rb) in zip(d['vo'], d['vo_real']):
    warp += [[a, ra], [b, rb]]
assert all(q[0] > p[0] and q[1] > p[1] for p, q in zip(warp, warp[1:])), 'якоря времени должны расти'
d['warp'] = warp
d['env'] = json.loads((S / 'voice-env.json').read_text(encoding='utf-8'))
html = (S / 'template.html').read_text(encoding='utf-8').replace('__DATA__', json.dumps(d, ensure_ascii=False)).replace('__T__', str(d['T']))
(S / 'out').mkdir(exist_ok=True); (S / 'out' / 'index.html').write_text(html, encoding='utf-8')
print('ok', d['T'], 'якорей', len(warp))
