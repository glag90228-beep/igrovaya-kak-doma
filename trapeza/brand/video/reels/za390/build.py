"""Рилс Первички «За 390 рублей» — хук-сравнение цен: кофе, шаурма, все документы на месяц.
Движок «5 скиллов»: голос по кускам (voice/timing.json с SEG), субтитры строкой сверху.
Всё, что обещаем, сверено с ботом: голосовое → счёт, QR, акт и УПД, «Напомнить», 5 документов в месяц бесплатно."""
import json, re, sys
from pathlib import Path

S = Path(__file__).resolve().parent
OUT = Path(__import__('os').environ.get('REEL_OUT', S / 'out' / 'index.html'))
LINES = [
    'За двести рублей — кофе. За триста — шаурма.',
    'А за триста девяносто — ~все счета, акты и УПД на целый месяц.',
    'Смотри. Говорю боту голосом: «счёт Вектору на сорок пять тысяч».',
    'Через минуту — готовый PDF. С ~QR-кодом: клиент платит камерой банка.',
    'Акт и УПД — тут же, по нужной форме.',
    'Кто не заплатил — видно сразу, и бот подскажет, кому +напомнить.',
    'Не хочешь платить? Пять документов в месяц — +бесплатно.',
    'Напиши ~«СЧЁТ» — пришлю ссылку на бота.',
]
WPS, STOP, GAP = 3.8, 6, 0.3
plain = lambda s: re.sub(r'(^|\s)[*+~]', r'\1', s)

TIMING = json.loads((S / 'voice' / 'timing.json').read_text()) if (S / 'voice' / 'timing.json').exists() else None
SEG = TIMING.get('SEG') if isinstance(TIMING, dict) else None
if SEG:
    # запись разрезана по паузам: у каждого куска фразы своё начало и конец
    for segs, line in zip(SEG, LINES):
        assert ' '.join(x[0] for x in segs) == line, (line, segs)
    CH = [[segs[0][1], segs[-1][2]] for segs in SEG]
elif TIMING:
    CH = TIMING
else:
    CH, t = [], 0.12
    for s in LINES:
        words = [w for w in plain(s).split() if w != '—']
        d = len(words) / WPS + 0.18 * len(re.findall(r'[.?:!—]\s', plain(s)))
        CH.append([round(t, 3), round(t + d, 3)])
        t += d + GAP
T = round(CH[-1][1] + 1.0, 2)

def spread(text, t0, t1):
    toks, wt, acc = text.split(' '), [], 0
    for tok in toks:
        wt.append(acc)
        acc += len(tok) + 1 + (STOP if re.search(r'[.?!,:—»]$', tok) or tok == '—' else 0)
    out = []
    for tok, a in zip(toks, wt):
        mark = tok[0] if tok[0] in '*+~' else ''
        out.append({'w': tok[1:] if mark else tok, 'm': mark, 't': round(t0 + (t1 - t0) * a / acc, 3)})
    return out


WORDS = []
if SEG:
    for segs in SEG:
        WORDS.append([w for text, a, b in segs for w in spread(text, a, b)])
for (t0, t1), s in ([] if SEG else zip(CH, LINES)):
    toks, wt, acc = s.split(' '), [], 0
    for tok in toks:
        wt.append(acc)
        acc += len(tok) + 1 + (STOP if re.search(r'[.?!,:—»]$', tok) or tok == '—' else 0)
    ws = []
    for tok, a in zip(toks, wt):
        mark = tok[0] if tok[0] in '*+~' else ''
        ws.append({'w': tok[1:] if mark else tok, 'm': mark, 't': round(t0 + (t1 - t0) * a / acc, 3)})
    WORDS.append(ws)


def W(i, key):
    for x in WORDS[i]:
        if re.sub(r'[«»!?,.:—]', '', x['w']).lower().startswith(key):
            return x['t']
    raise KeyError((i, key))


c0 = lambda i: round(CH[i][0] - 0.12, 3)
S0 = [0] + [c0(i) for i in range(1, len(CH))]
EV = {
    's': S0, 'p200': W(0, 'двести'), 'coffee': W(0, 'кофе'), 'p300': W(0, 'триста'), 'shaw': W(0, 'шаурма'),
    'p390': W(1, 'триста'), 'all': W(1, 'все'), 'akt': W(1, 'акты'), 'month': W(1, 'месяц'),
    'look': W(2, 'смотри'), 'voice': W(2, 'голосом'), 'say': W(2, 'счёт'), 'sum': W(2, 'сорок'),
    'min': W(3, 'минуту'), 'pdf': W(3, 'pdf'), 'qr': W(3, 'qr-кодом'), 'cam': W(3, 'камерой'),
    'act': W(4, 'акт'), 'upd': W(4, 'упд'), 'form': W(4, 'нужной'),
    'unpaid': W(5, 'не'), 'see': W(5, 'видно'), 'hint': W(5, 'подскажет'), 'remind': W(5, 'напомнить'),
    'nopay': W(6, 'платить'), 'five': W(6, 'пять'), 'free': W(6, 'бесплатно'),
    'word': W(7, 'счёт'), 'link': W(7, 'ссылку'), 'T': T,
}

# субтитры: порции по 1–3 слова, текущее слово подсвечивается (караоке)
GROUPS = []
for i, ws in enumerate(WORDS):
    cur = []
    for x in [x for x in ws if x['w'] != '—']:
        cur.append(x)
        txt = ' '.join(y['w'] for y in cur)
        if len(cur) >= 5 or len(txt) > 24 or re.search(r'[.?!:»]$', x['w']):
            GROUPS.append((i, cur)); cur = []
    if cur:
        GROUPS.append((i, cur))
CAPS, CAPT, KW = [], [], []
for k, (i, g) in enumerate(GROUPS):
    t0 = 0 if k == 0 else g[0]['t']
    nxt = GROUPS[k + 1] if k + 1 < len(GROUPS) else None
    t1 = nxt[1][0]['t'] if nxt and nxt[0] == i else (CH[i + 1][0] - 0.05 if i + 1 < len(CH) else T - 0.8)
    spans = []
    for j, x in enumerate(g):
        cls = {'*': 'r', '+': 'g', '~': 'a', '': ''}[x['m']] + (' nc' if x['w'].startswith(('/', '--')) else '')
        spans.append(f'<span class="kw {cls.strip()}" id="kw{k}_{j}">{x["w"]}</span>')
        KW.append([f'kw{k}_{j}', x['t']])
    CAPS.append(f'<div class="cp" id="cp{k}">{" ".join(spans)}</div>')
    CAPT.append([round(t0, 3), round(t1, 3)])

html = (S / 'template.html').read_text()
# лучи звезды в центре графа — своя «звёздочка», не чужой логотип
RAYS = ''.join(f'<rect x="-5" y="-46" width="10" height="32" rx="5" transform="rotate({k * 36 + (k % 2) * 4})"/>' for k in range(10)) + '<circle r="11"/>'
rep = {'__QR__': (S / 'qr.svg').read_text(), '__RAYS__': RAYS, '__T__': str(T), '__EV__': json.dumps(EV), '__CAPT__': json.dumps(CAPT), '__KW__': json.dumps(KW), '__CAPS__': '\n'.join(CAPS)}
for a, b in rep.items():
    html = html.replace(a, b)
left = re.findall(r'__[A-Z]+__', html.replace('__timelines', ''))
assert not left, left
ids = re.findall(r'id="([^"]+)"', html)
assert len(ids) == len(set(ids)), sorted({i for i in ids if ids.count(i) > 1})
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html)
(OUT.parent.parent / 'events.json').write_text(json.dumps({'T': T, 'CH': CH, 'EV': EV, 'lines': [plain(s) for s in LINES]}, ensure_ascii=False, indent=1))
print('T =', T, 'порций субтитров:', len(GROUPS))
for i, (a, b) in enumerate(CH):
    print(f'{i} {a:6.2f}–{b:6.2f}  {plain(LINES[i])}')
