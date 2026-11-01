"""Рилс «Claude всё забывает» (аккаунт про Claude): CLAUDE.md — память проекта, раскрытие в конце — /init.
Движок тот же, что у «Дыр»: голос по кускам (voice/timing.json с SEG), субтитры-караоке.
Старое описание движка: «Дыры» (~20 с, кольцо) для аккаунта про Claude: код от ИИ дырявый → /security-review → 70 атак.
Голоса пока нет — тайминг оценочный (3,8 слова/с, быстрый разговорный темп, как в образце).
Запись кладём в voice/voice.wav + voice/timing.json ([[начало, конец], …] по фразам) и пересобираем."""
import json, re, sys
from pathlib import Path

S = Path(__file__).resolve().parent
OUT = Path(__import__('os').environ.get('REEL_OUT', S / 'out' / 'index.html'))
LINES = [
    'Claude опять всё *забыл? Это не баг — ты просто не дал ему ~память.',
    'А в конце покажу команду, которая напишет её ~за ~тебя.',
    'Память Claude — это файл ~CLAUDE.md в папке проекта.',
    'Он читает его в начале ~каждой сессии: стиль, запреты, команды.',
    'Написал один раз — «коммиты по-русски, тесты перед коммитом» — и больше не повторяешь.',
    'У нас там даже записано: ключи и базы в Git *не *коммитить.',
    'А писать его самому не нужно. Команда ~/init — Claude изучит проект и составит файл +сам.',
    'Напиши ~«ПАМЯТЬ» — скину наш шаблон.',
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
    's': S0, 'forgot': W(0, 'забыл'), 'notbug': W(0, 'это'), 'mem': W(0, 'память'),
    'cmdT': W(1, 'команду'), 'foryou': W(1, 'за'),
    'fname': W(2, 'claudem'), 'folder': W(2, 'папке'),
    'each': W(3, 'каждой'), 'style': W(3, 'стиль'), 'ban': W(3, 'запреты'), 'cmds': W(3, 'команды'),
    'r1': W(4, 'коммиты'), 'r2': W(4, 'тесты'), 'norep': W(4, 'больше'),
    'keys': W(5, 'ключи'), 'no': W(5, 'не'),
    'noneed': W(6, 'писать'), 'slash': W(6, '/init'), 'study': W(6, 'изучит'), 'self': WORDS[6][-1]['t'],
    'word': W(7, 'память'), 'tmpl': W(7, 'шаблон'), 'T': T,
}

# субтитры: порции по 1–3 слова, текущее слово подсвечивается (караоке)
GROUPS = []
for i, ws in enumerate(WORDS):
    cur = []
    for x in [x for x in ws if x['w'] != '—']:
        cur.append(x)
        txt = ' '.join(y['w'] for y in cur)
        if len(cur) >= 3 or (len(cur) == 2 and len(txt) > 11) or re.search(r'[.?!,:»]$', x['w']):
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
        cls = {'*': 'r', '+': 'g', '~': 'a', '': ''}[x['m']] + (' nc' if x['w'].startswith('/') else '')
        spans.append(f'<span class="kw {cls.strip()}" id="kw{k}_{j}">{x["w"]}</span>')
        KW.append([f'kw{k}_{j}', x['t']])
    CAPS.append(f'<div class="cp" id="cp{k}">{" ".join(spans)}</div>')
    CAPT.append([round(t0, 3), round(t1, 3)])

html = (S / 'template.html').read_text()
rep = {'__T__': str(T), '__EV__': json.dumps(EV), '__CAPT__': json.dumps(CAPT), '__KW__': json.dumps(KW), '__CAPS__': '\n'.join(CAPS)}
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
