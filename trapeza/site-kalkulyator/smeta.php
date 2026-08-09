<?php
/**
 * Сохранение сметы отдельной страницей.
 *
 * Калькулятор присылает сюда данные заказа (не готовый HTML — иначе кто угодно
 * мог бы разместить на сайте свою страницу), здесь они проверяются и
 * превращаются в аккуратный документ smeta/<код>.html. Ссылка на него
 * уходит менеджеру вместе с заявкой: открыл — и сразу видно, что заказали,
 * можно распечатать или сохранить в PDF.
 */

declare(strict_types=1);

const DIR      = __DIR__ . '/smeta';
const KEEP_DAYS = 180;         // сколько храним сметы
const MAX_ITEMS = 300;
const RATE_MAX  = 30;          // сколько смет с одного адреса в час
const MAX_FILES = 5000;        // общий потолок, чтобы папку нельзя было раздуть

header('Content-Type: application/json; charset=utf-8');

function reply(array $d, int $code = 200): void {
  http_response_code($code);
  echo json_encode($d, JSON_UNESCAPED_UNICODE);
  exit;
}
function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function cut($s, int $n): string { return mb_substr(trim((string)$s), 0, $n); }
function money($n): string {
  $v = number_format((float)$n, 2, ',', ' ');
  return str_replace(' ', "\u{A0}", $v);        // неразрывный пробел в разрядах
}
function plural(int $n, string $one, string $few, string $many): string {
  $m100 = abs($n) % 100; $m10 = abs($n) % 10;
  if ($m100 >= 11 && $m100 <= 14) return $many;
  if ($m10 === 1) return $one;
  if ($m10 >= 2 && $m10 <= 4) return $few;
  return $many;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') reply(['error' => 'Только POST'], 405);

// ---------- ограничение частоты ----------
@mkdir(DIR, 0755, true);
$ipKey = DIR . '/.rate-' . md5($_SERVER['REMOTE_ADDR'] ?? 'x') . '.txt';
$hits = is_file($ipKey) ? array_filter(explode(',', (string)file_get_contents($ipKey)),
  fn($t) => (int)$t > time() - 3600) : [];
if (count($hits) >= RATE_MAX) reply(['error' => 'Слишком много смет подряд, попробуйте позже'], 429);
$hits[] = time();
@file_put_contents($ipKey, implode(',', $hits));

// ---------- данные заказа ----------
$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) reply(['error' => 'Не разобрал данные'], 400);

$rows = is_array($in['items'] ?? null) ? array_slice($in['items'], 0, MAX_ITEMS) : [];
$items = [];
foreach ($rows as $r) {
  $n = cut($r['n'] ?? '', 200);
  if ($n === '') continue;
  $items[] = [
    'n' => $n,
    'u' => cut($r['u'] ?? '', 40),
    'q' => max(0, min(9999, (int)($r['q'] ?? 0))),
    'p' => round((float)($r['p'] ?? 0), 2),
    't' => !empty($r['t']),
  ];
}
if (!$items) reply(['error' => 'Пустой заказ'], 400);

$guests    = max(1, min(5000, (int)($in['guests'] ?? 1)));
$transport = max(0, round((float)($in['transport'] ?? 0), 2));
$name      = cut($in['name'] ?? '', 120);
$phone     = cut($in['phone'] ?? '', 40);
$place     = cut($in['place'] ?? '', 200);
$comment   = cut($in['comment'] ?? '', 600);
$eventDate = preg_match('~^\d{2}\.\d{2}\.\d{4}$~', (string)($in['date'] ?? '')) ? $in['date'] : '';

$menuSum = 0; $tbd = 0;
foreach ($items as $it) { if ($it['t']) $tbd++; else $menuSum += $it['q'] * $it['p']; }
$total = $menuSum + $transport;

// ---------- документ ----------
$today = date('d.m.Y');
$rowsHtml = '';
$i = 0;
foreach ($items as $it) {
  $i++;
  $rowsHtml .= '<tr><td class="c">' . $i . '</td><td><b>' . h($it['n']) . '</b></td>'
    . '<td class="c">' . h($it['u']) . '</td><td class="c">' . $it['q'] . '</td>'
    . '<td class="m">' . ($it['t'] ? 'уточн.' : money($it['p'])) . '</td>'
    . '<td class="m">' . ($it['t'] ? '—' : money($it['q'] * $it['p'])) . '</td></tr>';
}

$doc = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
  . '<meta name="viewport" content="width=device-width,initial-scale=1">'
  . '<meta name="robots" content="noindex,nofollow">'
  . '<title>Смета' . ($name !== '' ? ' — ' . h($name) : '') . ' | Трапеза</title>'
  . '<link rel="icon" href="/favicon.ico" sizes="any">'
  . '<link rel="preconnect" href="https://fonts.googleapis.com">'
  . '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  . '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">'
  . '<style>'
  . ':root{--ink:#2A2520;--muted:#756A5B;--line:#E5DBCB;--accent:#8A6038;--bg2:#F4EEE3;--dark:#241F1A}'
  . '*{margin:0;padding:0;box-sizing:border-box}'
  . 'body{font:400 15px/1.55 "Manrope",system-ui,sans-serif;color:var(--ink);background:#FBF8F3;padding:20px}'
  . '.sheet{max-width:900px;margin:0 auto;background:#fff;border:1px solid var(--line);'
  . 'border-radius:14px;padding:clamp(1.2rem,2.6vw,2rem)}'
  . '.head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-end}'
  . '.brand{font:700 1.7rem "Cormorant Garamond",Georgia,serif;color:var(--accent)}'
  . '.sub{font-size:.85rem;color:var(--muted)}'
  . '.rule{height:2px;background:var(--accent);margin:.8rem 0 1.4rem}'
  . 'h1{font:700 1.9rem "Cormorant Garamond",Georgia,serif;text-align:center;letter-spacing:.06em}'
  . '.lead{text-align:center;color:var(--muted);font-size:.9rem;margin-bottom:1.3rem}'
  . 'table{width:100%;border-collapse:collapse;font-size:.86rem}'
  . '.info td{border:1px solid var(--line);padding:.5rem .7rem}'
  . '.info .k{background:var(--bg2);font-weight:600;width:23%}'
  . '.info{margin-bottom:1.2rem}'
  . '.bill th{background:var(--accent);color:#fff;padding:.55rem .6rem;text-align:left;font-size:.78rem}'
  . '.bill td{border:1px solid var(--line);padding:.5rem .6rem}'
  . '.bill tbody tr:nth-child(even) td{background:#FBF8F3}'
  . '.bill .c{text-align:center}.bill .m{text-align:right;white-space:nowrap}'
  . '.bill tr.sub td{background:var(--bg2)!important;font-weight:600}'
  . '.bill tr.grand td{background:var(--dark)!important;color:#fff;font-weight:700}'
  . '.note{font-size:.8rem;color:var(--muted);margin-top:.9rem;line-height:1.6}'
  . '.signs{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;margin-top:2.2rem}'
  . '.signs .role{font-weight:700;margin-bottom:1.7rem;font-size:.9rem}'
  . '.signs .line{border-bottom:1px solid #5C5349}'
  . '.signs .hint{font-size:.7rem;color:var(--muted);margin-top:.25rem}'
  . '.signs .who{font-size:.84rem;margin-top:.45rem;min-height:1.1rem}'
  . '.signs .date{font-size:.78rem;color:var(--muted);margin-top:.6rem}'
  . '.acts{max-width:900px;margin:1.2rem auto 0;display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center}'
  . '.acts button,.acts a{padding:.8rem 1.5rem;border-radius:10px;border:1px solid var(--line);'
  . 'background:#fff;color:var(--ink);font:600 .9rem "Manrope",sans-serif;cursor:pointer;text-decoration:none}'
  . '.acts .main{background:var(--accent);color:#fff;border-color:var(--accent)}'
  . '@media(max-width:560px){.signs{grid-template-columns:1fr;gap:1.6rem}'
  . 'table.bill{font-size:.72rem;table-layout:fixed}'
  . '.bill th{font-size:.62rem;padding:.4rem .22rem}.bill td{padding:.4rem .22rem}'
  . '.info .k{width:42%}}'
  . '@media print{@page{size:A4;margin:0}body{background:#fff;padding:0}'
  . '.acts{display:none}.sheet{border:0;border-radius:0;max-width:none;padding:12mm}'
  . '.bill th,.bill tr.sub td,.bill tr.grand td,.bill tbody tr:nth-child(even) td'
  . '{-webkit-print-color-adjust:exact;print-color-adjust:exact}tr{break-inside:avoid}}'
  . '</style></head><body><div class="sheet">'
  . '<div class="head"><div><div class="brand">Трапеза</div>'
  . '<div class="sub">ИП Сарычева Мария Витальевна</div></div>'
  . '<div style="text-align:right"><div style="font-weight:700">+7 912 454-14-81</div>'
  . '<div class="sub">Кейтеринг · банкеты · фуршеты</div></div></div><div class="rule"></div>'
  . '<h1>СМЕТА</h1>'
  . '<p class="lead">Заказ на ' . $guests . ' ' . plural($guests, 'человека', 'человек', 'человек') . '</p>'
  . '<table class="info">'
  . '<tr><td class="k">Заказчик:</td><td>' . ($name !== '' ? h($name) : '—') . '</td>'
  . '<td class="k">Телефон:</td><td>' . ($phone !== '' ? h($phone) : '—') . '</td></tr>'
  . '<tr><td class="k">Дата мероприятия:</td><td>' . ($eventDate !== '' ? h($eventDate) : '—') . '</td>'
  . '<td class="k">Смета составлена:</td><td>' . $today . '</td></tr>'
  . '<tr><td class="k">Место проведения:</td><td colspan="3">' . ($place !== '' ? h($place) : '—') . '</td></tr>'
  . '</table>'
  . '<table class="bill"><thead><tr><th style="width:34px">№</th><th>Наименование</th>'
  . '<th style="width:62px">Выход</th><th style="width:56px">Кол-во</th>'
  . '<th style="width:84px">Цена, ₽</th><th style="width:96px">Сумма, ₽</th></tr></thead><tbody>'
  . $rowsHtml
  . '<tr class="sub"><td colspan="5" style="text-align:right">ИТОГО по меню:</td>'
  . '<td class="m">' . money($menuSum) . '</td></tr>'
  . ($transport > 0
     ? '<tr class="sub"><td colspan="5" style="text-align:right">Транспортные расходы:</td>'
       . '<td class="m">' . money($transport) . '</td></tr>' : '')
  . '<tr class="grand"><td colspan="5" style="text-align:right">ВСЕГО К ОПЛАТЕ:</td>'
  . '<td class="m">' . money($total) . '</td></tr></tbody></table>'
  . ($tbd ? '<p class="note">* Позиции с пометкой «уточн.» считаем отдельно — в итог они пока не входят.</p>' : '')
  . ($comment !== '' ? '<p class="note"><b>Комментарий заказчика:</b> ' . h($comment) . '</p>' : '')
  . '<p class="note">Срок действия сметы — 7 дней. Цены указаны в рублях с учётом сервировки. '
  . 'Количество и состав меню согласовываются с заказчиком.</p>'
  . '<div class="signs"><div><div class="role">Исполнитель</div><div class="line"></div>'
  . '<div class="hint">подпись</div><div class="who">М. В. Сарычева</div></div>'
  . '<div><div class="role">Заказчик</div><div class="line"></div><div class="hint">подпись</div>'
  . '<div class="who">' . h($name) . '</div>'
  . ($name === '' ? '<div class="hint">Ф. И. О.</div>' : '')
  . '<div class="date">«____» ______________ ' . date('Y') . ' г.</div></div></div>'
  . '</div><div class="acts">'
  . '<button class="main" type="button" onclick="window.print()">Скачать PDF / печать</button>'
  . '<a href="/kalkulyator.html">Открыть калькулятор</a>'
  . '<a href="tel:+79124541481">Позвонить</a>'
  . '</div></body></html>';

// ---------- сохраняем ----------
# 8 случайных байт: ссылку не подобрать перебором, а в смете лежат
# имя и телефон заказчика — это персональные данные.
$code = date('ymd') . '-' . bin2hex(random_bytes(8));
if (file_put_contents(DIR . '/' . $code . '.html', $doc, LOCK_EX) === false) {
  reply(['error' => 'Не удалось сохранить смету'], 500);
}

// старые сметы подчищаем, чтобы папка не росла бесконечно
foreach (glob(DIR . '/*.html') ?: [] as $f) {
  if (filemtime($f) < time() - KEEP_DAYS * 86400) @unlink($f);
}
// и держим общий потолок: самые старые уходят первыми
$all = glob(DIR . '/*.html') ?: [];
if (count($all) > MAX_FILES) {
  usort($all, fn($a, $b) => filemtime($a) <=> filemtime($b));
  foreach (array_slice($all, 0, count($all) - MAX_FILES) as $f) @unlink($f);
}

# Отдаём относительный адрес: абсолютный соберёт браузер из своего origin.
# Если брать HTTP_HOST, подменённый заголовок увёл бы ссылку на чужой домен.
reply(['ok' => true, 'url' => '/smeta/' . $code . '.html']);
