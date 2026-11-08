<?php
/**
 * Панель меню «Трапеза» — редактор блюд для калькулятора.
 *
 * Кладётся в корень сайта рядом с kalkulyator.html и menu.json.
 * Открывается по адресу https://трапеза18.рф/admin.php
 *
 * Пароль хранится не текстом, а хэшем. Сменить:
 *   php -r 'echo password_hash("новый-пароль", PASSWORD_DEFAULT);'
 * и подставить результат в ADMIN_HASH ниже.
 *
 * Меню сохраняется одним JSON-запросом (не обычной формой) — иначе на длинном
 * списке PHP молча обрезает поля по max_input_vars и часть блюд теряется.
 */

declare(strict_types=1);

const ADMIN_HASH = '$2y$12$B7pkHuaC0KTclRG1DLkaEuphNQUDNawkq9EdFM7ntwZXW3lEzp2OW';
const MENU_FILE  = __DIR__ . '/menu.json';
const BACKUP_DIR = __DIR__ . '/menu-backup';
const PHOTO_DIR  = __DIR__ . '/img/menu';
const PHOTO_URL  = 'img/menu';
const MAX_PHOTO  = 4 * 1024 * 1024;          // 4 МБ на файл
const TRIES_MAX  = 8;                         // попыток входа за 15 минут
const TRIES_FILE = __DIR__ . '/menu-backup/.login';   // счётчик по адресу, не по сессии

session_start([
  'cookie_httponly' => true,
  'cookie_samesite' => 'Lax',
  'cookie_secure'   => !empty($_SERVER['HTTPS']),
]);

// ─────────────────────────────────────────────── меню на диске

function menu_load(): array {
  if (!is_file(MENU_FILE)) return ['transport' => 1000, 'items' => []];
  $raw = json_decode((string)file_get_contents(MENU_FILE), true);
  if (!is_array($raw) || !isset($raw['items'])) return ['transport' => 1000, 'items' => []];
  return $raw;
}

function menu_save(array $menu): string {
  $menu['updated'] = date('c');
  $json = json_encode($menu, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
  if ($json === false) return 'Не удалось собрать JSON';

  // копия предыдущей версии — на случай ошибки, храним последние 20
  if (is_file(MENU_FILE)) {
    @mkdir(BACKUP_DIR, 0755, true);
    @copy(MENU_FILE, BACKUP_DIR . '/menu-' . date('Y-m-d_His') . '.json');
    $old = glob(BACKUP_DIR . '/menu-*.json') ?: [];
    rsort($old);
    foreach (array_slice($old, 20) as $f) @unlink($f);
  }

  $tmp = MENU_FILE . '.tmp';
  if (file_put_contents($tmp, $json, LOCK_EX) === false) return 'Нет прав на запись в папку сайта';
  if (!rename($tmp, MENU_FILE)) { @unlink($tmp); return 'Не удалось заменить menu.json'; }
  return '';
}

function plural(int $n, string $one, string $few, string $many): string {
  $m100 = abs($n) % 100; $m10 = abs($n) % 10;
  if ($m100 >= 11 && $m100 <= 14) return $many;
  if ($m10 === 1) return $one;
  if ($m10 >= 2 && $m10 <= 4) return $few;
  return $many;
}
function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function num($v): float { return (float)str_replace([' ', ',', "\u{A0}"], ['', '.', ''], (string)$v); }
function reply(array $data, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}

// ─────────────────────────────────────────────── вход

$error = '';
$authorized = !empty($_SESSION['ok']);

/**
 * Счётчик неудачных входов держим на диске и по адресу: если считать в сессии,
 * достаточно удалить cookie — и перебор снова разрешён.
 */
function login_tries(?bool $add = null): int {
  @mkdir(dirname(TRIES_FILE), 0755, true);
  $all = is_file(TRIES_FILE)
    ? (json_decode((string)file_get_contents(TRIES_FILE), true) ?: []) : [];
  $now = time();
  foreach ($all as $k => $list) {
    $all[$k] = array_values(array_filter($list, fn($t) => $t > $now - 900));
    if (!$all[$k]) unset($all[$k]);
  }
  $ip = md5((string)($_SERVER['REMOTE_ADDR'] ?? 'x'));
  if ($add === true) {
    $all[$ip][] = $now;
    @file_put_contents(TRIES_FILE, json_encode($all), LOCK_EX);
  } elseif ($add === false) {
    unset($all[$ip]);
    @file_put_contents(TRIES_FILE, json_encode($all), LOCK_EX);
  }
  return count($all[$ip] ?? []);
}

if (($_POST['action'] ?? '') === 'login') {
  if (login_tries() >= TRIES_MAX) {
    $error = 'Слишком много попыток. Подождите 15 минут.';
    usleep(400000);
  } elseif (password_verify((string)($_POST['password'] ?? ''), ADMIN_HASH)) {
    session_regenerate_id(true);
    $_SESSION['ok'] = true;
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
    login_tries(false);
    $authorized = true;
  } else {
    login_tries(true);
    usleep(400000);                       // чуть замедляем перебор
    $error = 'Неверный пароль';
  }
}

if (isset($_GET['logout'])) { session_destroy(); header('Location: admin.php'); exit; }

$api = $_GET['api'] ?? '';

if (!$authorized) {
  if ($api !== '') reply(['error' => 'Сессия закончилась — войдите заново'], 403);
  http_response_code($error !== '' ? 403 : 200);
  render_login($error);
  exit;
}

if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
$csrf = $_SESSION['csrf'];

// ─────────────────────────────────────────────── API: сохранение меню

if ($api === 'save') {
  $in = json_decode((string)file_get_contents('php://input'), true);
  if (!is_array($in)) reply(['error' => 'Не разобрал данные'], 400);
  if (!hash_equals($csrf, (string)($in['csrf'] ?? ''))) reply(['error' => 'Сессия устарела — обновите страницу'], 403);

  $rows = $in['items'] ?? [];
  if (!is_array($rows) || count($rows) === 0) reply(['error' => 'Пустой список — сохранять нечего'], 400);

  $items = [];
  foreach ($rows as $r) {
    $name = trim((string)($r['n'] ?? ''));
    if ($name === '') continue;
    $items[] = [
      'n'    => mb_substr($name, 0, 200),
      'd'    => mb_substr(trim((string)($r['d'] ?? '')), 0, 600),
      'u'    => mb_substr(trim((string)($r['u'] ?? '')), 0, 40),
      'p'    => round(num($r['p'] ?? 0), 2),
      't'    => !empty($r['t']) ? 1 : 0,
      'c'    => mb_substr(trim((string)($r['c'] ?? '')), 0, 80) ?: 'Разное',
      'mt'   => (($r['mt'] ?? 'furshet') === 'banket') ? 'banket' : 'furshet',
      'ph'   => (preg_match('~^(img/[\w-]+(/[\w-]+)*\.(jpe?g|png|webp))?$~i', (string)($r['ph'] ?? ''))
                  && strpos((string)($r['ph'] ?? ''), '..') === false)
                 ? (string)($r['ph'] ?? '') : '',
      'off'  => !empty($r['off']) ? 1 : 0,
      'sort' => count($items),
    ];
  }
  if (!$items) reply(['error' => 'Ни у одной строки нет названия'], 400);

  // страховка от случайной потери: резкое сокращение списка подтверждаем отдельно
  $was = count(menu_load()['items'] ?? []);
  if ($was > 10 && count($items) < $was / 2 && empty($in['confirm'])) {
    reply(['need' => true,
           'message' => 'Было ' . $was . ' позиций, станет ' . count($items) . '. Сохранить?'], 409);
  }

  $err = menu_save(['transport' => round(num($in['transport'] ?? 1000), 2), 'items' => $items]);
  if ($err !== '') reply(['error' => $err], 500);

  reply(['ok' => true, 'count' => count($items),
         'message' => 'Сохранено: ' . count($items) . ' ' . plural(count($items), 'позиция', 'позиции', 'позиций')]);
}

// ─────────────────────────────────────────────── API: фотография блюда

if ($api === 'photo') {
  if (!hash_equals($csrf, (string)($_POST['csrf'] ?? ''))) reply(['error' => 'Сессия устарела — обновите страницу'], 403);
  if (empty($_FILES['photo']['name'])) reply(['error' => 'Файл не выбран'], 400);

  $f = $_FILES['photo'];
  if ($f['error'] !== UPLOAD_ERR_OK) reply(['error' => 'Файл не загрузился (код ' . $f['error'] . ')'], 400);
  if ($f['size'] > MAX_PHOTO) reply(['error' => 'Фото больше 4 МБ'], 400);

  $info = @getimagesize($f['tmp_name']);
  $ext = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? '';
  if ($ext === '') reply(['error' => 'Подойдут только JPG, PNG или WEBP'], 400);

  @mkdir(PHOTO_DIR, 0755, true);
  // Загруженное фото должно оставаться картинкой: запрещаем выполнять
  // что-либо в этой папке, даже если внутрь файла зашит код.
  $guard = PHOTO_DIR . '/.htaccess';
  if (!is_file($guard)) {
    @file_put_contents($guard,
      "php_flag engine off\n"
      . "<IfModule mod_php.c>\n  php_admin_flag engine off\n</IfModule>\n"
      . "RemoveHandler .php .phtml .php3 .php4 .php5 .php7 .php8 .pl .py .cgi\n"
      . "AddType text/plain .php .phtml .php3 .php4 .php5 .php7 .php8\n");
  }
  $name = bin2hex(random_bytes(6)) . '.' . $ext;
  if (!move_uploaded_file($f['tmp_name'], PHOTO_DIR . '/' . $name)) {
    reply(['error' => 'Не удалось сохранить фото — нет прав на папку img/menu'], 500);
  }
  reply(['ok' => true, 'url' => PHOTO_URL . '/' . $name]);
}

// ─────────────────────────────────────────────── разметка

function head(string $title): void { ?>
<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title><?= h($title) ?></title>
<link rel="icon" href="favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#FBF8F3;--bg2:#F4EEE3;--surface:#fff;--ink:#2A2520;--ink2:#5C5349;--muted:#756A5B;
 --line:#E5DBCB;--accent:#8A6038;--accent-d:#6F4C2B;--gold:#C9A86A;--dark:#241F1A;
 --serif:'Cormorant Garamond',Georgia,serif;--sans:'Manrope',system-ui,sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--sans);background:var(--bg);color:var(--ink);font-size:15px;line-height:1.55}
a{color:var(--accent)}
.top{background:var(--dark);color:#fff;padding:14px 20px;display:flex;align-items:center;
 justify-content:space-between;gap:14px;flex-wrap:wrap;position:sticky;top:0;z-index:20}
.top b{font-family:var(--serif);font-size:22px;font-weight:700}
.top .sub{color:rgba(255,255,255,.6);font-size:13px}
.top a{color:var(--gold)}
.wrap{max-width:1180px;margin:0 auto;padding:22px 18px 120px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
h2{font-family:var(--serif);font-weight:700;font-size:26px;margin-bottom:6px}
.muted{color:var(--muted);font-size:13.5px}
label{display:block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
 color:var(--ink2);margin-bottom:5px}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;
 font:400 14px var(--sans);color:var(--ink);background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
.btn{display:inline-block;padding:11px 20px;border:none;border-radius:9px;background:var(--accent);
 color:#fff;font:600 14px var(--sans);cursor:pointer}
.btn:hover{background:var(--accent-d)}
.btn.ghost{background:#fff;color:var(--ink2);border:1px solid var(--line)}
.btn[disabled]{opacity:.5;cursor:default}
.ok{background:#F2F8F1;border:1px solid #CFE3CF;border-left:4px solid #4F8A52;color:#2F5A2C;
 padding:12px 14px;border-radius:9px;margin-bottom:14px}
.err{background:#FBF2F2;border:1px solid #E7CFCF;border-left:4px solid #A65454;color:#7A2F2F;
 padding:12px 14px;border-radius:9px;margin-bottom:14px}
.grid{display:grid;gap:12px}
.g4{grid-template-columns:2fr 1fr 1fr 1fr}
.cat{font-family:var(--serif);font-size:21px;font-weight:700;margin:22px 0 10px;
 display:flex;align-items:baseline;gap:10px}
.cat span{font-family:var(--sans);font-size:12px;font-weight:600;letter-spacing:.1em;
 text-transform:uppercase;color:var(--muted)}
.cat .tools{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap}
.cat .tools button{font:600 12px var(--sans);padding:5px 10px;border:1px solid var(--line);
 border-radius:8px;background:#fff;color:var(--ink2);cursor:pointer}
.cat .tools button:hover{border-color:var(--accent);color:var(--accent)}
.cat .tools .ico{padding:5px 9px;font-size:13px;line-height:1}
.dirty{position:fixed;left:0;right:0;bottom:56px;background:#FBF2F2;border-top:1px solid #E7CFCF;
 color:#7A2F2F;padding:8px 20px;font-size:13px;z-index:29;display:none}
.dirty.on{display:block}
@media(max-width:900px){.cat{flex-wrap:wrap}.cat .tools{margin-left:0;width:100%}}
.row{display:grid;grid-template-columns:30px 1.5fr 1.8fr 68px 88px 168px 120px;gap:9px;align-items:start;
 padding:11px;border:1px solid var(--line);border-radius:11px;background:#fff;margin-bottom:8px}
.row.hidden-item{opacity:.55;background:var(--bg2)}
.row.to-delete{opacity:.4;background:#FBF2F2;border-color:#E7CFCF}
.row .idx{color:var(--muted);font-size:12px;padding-top:10px;text-align:center}
.row textarea{height:64px;resize:vertical}
.chk{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink2);margin-top:6px}
.chk input{width:16px;height:16px;accent-color:var(--accent)}
.thumb{width:100%;height:56px;object-fit:cover;border-radius:7px;border:1px solid var(--line);margin-bottom:5px;display:block}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--dark);color:#fff;padding:12px 20px;
 display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;z-index:30}
.bar .btn{background:var(--gold);color:var(--dark)}
.bar .state{font-size:13.5px;color:rgba(255,255,255,.75)}
.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.tools>div{flex:0 1 200px}
@media(max-width:900px){
  .row{grid-template-columns:1fr 1fr;gap:8px}
  .row .idx{display:none}
  .g4{grid-template-columns:1fr 1fr}
}
</style></head><body>
<?php }

function render_login(string $error): void {
  head('Панель меню — Трапеза'); ?>
  <div class="top"><b>Трапеза</b><span class="sub">панель меню</span></div>
  <div class="wrap" style="max-width:420px">
    <div class="card">
      <h2>Вход</h2>
      <p class="muted" style="margin-bottom:16px">Панель для редактирования блюд калькулятора.</p>
      <?php if ($error !== ''): ?><div class="err"><?= h($error) ?></div><?php endif; ?>
      <form method="post" autocomplete="off">
        <input type="hidden" name="action" value="login">
        <label for="p">Пароль</label>
        <input id="p" type="password" name="password" autofocus required>
        <button class="btn" style="margin-top:14px;width:100%" type="submit">Войти</button>
      </form>
    </div>
  </div></body></html>
<?php }

// ─────────────────────────────────────────────── редактор

$menu = menu_load();
$items = $menu['items'] ?? [];
usort($items, fn($a, $b) => (($a['sort'] ?? 0) <=> ($b['sort'] ?? 0)));

$counts = [];
foreach ($items as $it) {
  $key = ($it['mt'] ?? 'furshet') . '|' . ($it['c'] ?? '');
  $counts[$key] = ($counts[$key] ?? 0) + 1;
}
$allCats = array_values(array_unique(array_map(fn($it) => $it['c'] ?? '', $items)));
sort($allCats);

head('Панель меню — Трапеза');
?>
<div class="top">
  <div><b>Трапеза</b> <span class="sub">панель меню</span></div>
  <div class="sub">
    <a href="kalkulyator.html" target="_blank">Открыть калькулятор ↗</a> ·
    <a href="?logout=1">Выйти</a>
  </div>
</div>

<div class="wrap">
  <div id="msg"></div>

  <div class="card">
    <h2>Добавить блюдо</h2>
    <p class="muted" style="margin-bottom:14px">Строка появится внизу списка — состав и фото допишете в ней.</p>
    <div class="grid g4">
      <div><label>Название</label><input id="new_n" placeholder="Канапе с креветкой и черри"></div>
      <div><label>Выход</label><input id="new_u" placeholder="30 гр"></div>
      <div><label>Цена, ₽</label><input id="new_p" inputmode="decimal" placeholder="120"></div>
      <div><label>Меню</label><select id="new_mt">
        <option value="furshet">Фуршетное</option><option value="banket">Банкетное</option></select></div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-end;margin-top:12px;flex-wrap:wrap">
      <div style="flex:0 1 320px"><label>Категория</label>
        <select id="new_c"></select>
      </div>
      <button class="btn ghost" type="button" id="add">Добавить в список</button>
    </div>
  </div>

  <div class="card tools">
    <div><label>Транспортные расходы, ₽</label>
      <input id="transport" inputmode="decimal" value="<?= h($menu['transport'] ?? 1000) ?>"></div>
    <div style="flex:1 1 260px"><label>Поиск по списку</label>
      <input id="q" type="search" placeholder="сёмга, перепечи, десерт…"></div>
    <div><label>Показывать</label><select id="mt">
      <option value="">оба меню</option>
      <option value="furshet">только фуршетное</option>
      <option value="banket">только банкетное</option></select></div>
  </div>

  <div id="list">
  <?php
  foreach ($items as $i => $it): ?>
    <div class="row<?= !empty($it['off']) ? ' hidden-item' : '' ?>" data-i="<?= $i ?>"
         data-search="<?= h(mb_strtolower(($it['n'] ?? '') . ' ' . ($it['d'] ?? '') . ' ' . ($it['c'] ?? ''))) ?>"
         data-mt="<?= h($it['mt'] ?? 'furshet') ?>">
      <div class="idx"><?= $i + 1 ?></div>

      <div>
        <input data-f="n" value="<?= h($it['n'] ?? '') ?>" aria-label="Название">
        <label class="chk"><input type="checkbox" data-f="off" <?= !empty($it['off']) ? 'checked' : '' ?>>
          <span>скрыть с сайта</span></label>
        <label class="chk"><input type="checkbox" data-f="del"><span>удалить</span></label>
      </div>

      <div><textarea data-f="d" placeholder="состав блюда"><?= h($it['d'] ?? '') ?></textarea></div>

      <div><input data-f="u" value="<?= h($it['u'] ?? '') ?>" aria-label="Выход" placeholder="30 гр"></div>

      <div>
        <input data-f="p" inputmode="decimal" aria-label="Цена"
               value="<?= h(rtrim(rtrim(number_format((float)($it['p'] ?? 0), 2, '.', ''), '0'), '.')) ?>">
        <label class="chk"><input type="checkbox" data-f="t" <?= !empty($it['t']) ? 'checked' : '' ?>>
          <span>по запросу</span></label>
      </div>

      <div>
        <select data-f="c" aria-label="Категория" data-value="<?= h($it['c'] ?? '') ?>"></select>
        <select data-f="mt" style="margin-top:6px">
          <option value="furshet" <?= ($it['mt'] ?? '') !== 'banket' ? 'selected' : '' ?>>фуршет</option>
          <option value="banket"  <?= ($it['mt'] ?? '') === 'banket' ? 'selected' : '' ?>>банкет</option>
        </select>
      </div>

      <div>
        <img class="thumb" data-thumb src="<?= h($it['ph'] ?? '') ?>" alt=""
             <?= empty($it['ph']) ? 'style="display:none"' : '' ?>>
        <input type="hidden" data-f="ph" value="<?= h($it['ph'] ?? '') ?>">
        <input type="file" data-photo accept="image/jpeg,image/png,image/webp"
               style="font-size:11.5px;padding:5px" aria-label="Фото блюда">
      </div>
    </div>
  <?php endforeach; ?>
  </div>
</div>

<div class="dirty" id="dirty">Есть несохранённые изменения — не забудьте «Сохранить меню».</div>
<div class="bar">
  <div class="state">Позиций: <b id="cnt"><?= count($items) ?></b> · после сохранения меню на сайте обновится сразу</div>
  <button class="btn" type="button" id="save">Сохранить меню</button>
</div>

<script>
var CSRF = <?= json_encode($csrf) ?>;
var $ = function(id){ return document.getElementById(id); };
var list = $('list'), msg = $('msg');
var dirty = false;

function say(text, bad){
  msg.innerHTML = '<div class="' + (bad ? 'err' : 'ok') + '">' + text.replace(/[<>]/g, '') + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function rows(){ return Array.prototype.slice.call(list.querySelectorAll('.row')); }
function field(row, name){ return row.querySelector('[data-f="' + name + '"]'); }
function esc(t){ return String(t == null ? '' : t).replace(/[&<>"]/g,
  function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]; }); }
function touch(){ dirty = true; $('dirty').classList.add('on'); }

window.addEventListener('beforeunload', function(e){
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ══════════ КАТЕГОРИИ ══════════
   Порядок категорий = порядок строк в списке: при сохранении позиции
   нумеруются сверху вниз, поэтому достаточно двигать сами строки. */

var MENUS = { furshet: 'фуршет', banket: 'банкет' };
var order = [];                       /* ключи «меню|категория» в нужном порядке */

function rowCat(r){ return (field(r, 'c').value || 'Разное').trim() || 'Разное'; }
function rowMt(r){ return field(r, 'mt').value; }
function keyOf(r){ return rowMt(r) + '|' + rowCat(r); }

/** Все категории выбранного меню, в текущем порядке. */
function catsOf(mt){
  var seen = {}, out = [];
  order.forEach(function(k){
    var p = k.split('|');
    if (p[0] === mt && !seen[k]) { seen[k] = 1; out.push(p.slice(1).join('|')); }
  });
  rows().forEach(function(r){
    if (rowMt(r) !== mt) return;
    var c = rowCat(r);
    if (out.indexOf(c) < 0) out.push(c);
  });
  return out;
}

/** Выпадающий список категорий для строки и для формы добавления. */
function fillCatSelect(sel, mt, value){
  var cats = catsOf(mt);
  if (value && cats.indexOf(value) < 0) cats.push(value);
  sel.innerHTML = cats.map(function(c){
    return '<option value="' + esc(c) + '"' + (c === value ? ' selected' : '') + '>' + esc(c) + '</option>';
  }).join('') + '<option value="__new__">➕ новая категория…</option>';
  sel.title = value || ''; /* длинное название не влезает в колонку — покажем подсказкой */
}

function refreshCatSelects(){
  rows().forEach(function(r){ fillCatSelect(field(r, 'c'), rowMt(r), rowCat(r)); });
  var mt = $('new_mt').value;
  fillCatSelect($('new_c'), mt, $('new_c').value && $('new_c').value !== '__new__' ? $('new_c').value : catsOf(mt)[0]);
}

/** Перестраиваем список: строки группируются по категориям в порядке order. */
function regroup(){
  var groups = {}, keys = [];
  rows().forEach(function(r){
    var k = keyOf(r);
    if (!groups[k]) { groups[k] = []; keys.push(k); }
    groups[k].push(r);
  });
  /* сохраняем прежний порядок, новые категории добавляем в конец своего меню */
  var ordered = order.filter(function(k){ return groups[k]; });
  keys.forEach(function(k){
    if (ordered.indexOf(k) >= 0) return;
    var mt = k.split('|')[0];
    var last = -1;
    ordered.forEach(function(o, i){ if (o.split('|')[0] === mt) last = i; });
    ordered.splice(last + 1, 0, k);
  });
  order = ordered;

  Array.prototype.forEach.call(list.querySelectorAll('.cat'), function(h){ h.remove(); });
  order.forEach(function(k){
    var parts = k.split('|'), mt = parts[0], cat = parts.slice(1).join('|');
    var head = document.createElement('h3');
    head.className = 'cat';
    head.dataset.key = k;
    head.innerHTML = esc(cat) + ' <span>' + MENUS[mt] + ' · ' + groups[k].length + '</span>'
      + '<span class="tools">'
      + '<button type="button" class="ico" data-cat="up" title="Выше">↑</button>'
      + '<button type="button" class="ico" data-cat="down" title="Ниже">↓</button>'
      + '<button type="button" data-cat="rename">Переименовать</button>'
      + '<button type="button" data-cat="move">В ' + (mt === 'furshet' ? 'банкетное' : 'фуршетное') + '</button>'
      + '<button type="button" data-cat="merge">Объединить…</button>'
      + '</span>';
    list.appendChild(head);
    groups[k].forEach(function(r){ list.appendChild(r); });
  });
  refreshCatSelects();
  refresh();
}

/** Действия над категорией целиком. */
list.addEventListener('click', function(e){
  var btn = e.target.closest ? e.target.closest('[data-cat]') : null;
  if (!btn) return;
  var head = btn.closest('.cat');
  var key = head.dataset.key;
  var parts = key.split('|'), mt = parts[0], cat = parts.slice(1).join('|');
  var act = btn.dataset.cat;
  var inGroup = rows().filter(function(r){ return keyOf(r) === key; });

  if (act === 'up' || act === 'down') {
    var same = order.filter(function(k){ return k.split('|')[0] === mt; });
    var i = same.indexOf(key), j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= same.length) return;
    var a = order.indexOf(same[i]), b = order.indexOf(same[j]);
    order[a] = same[j]; order[b] = same[i];
    regroup(); touch();
    document.querySelector('.cat[data-key="' + key.replace(/"/g, '\\"') + '"]')
      .scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (act === 'rename') {
    var name = (prompt('Новое название категории:', cat) || '').trim();
    if (!name || name === cat) return;
    var exists = catsOf(mt).indexOf(name) >= 0;
    if (exists && !confirm('Категория «' + name + '» уже есть. Объединить с ней ' 
        + inGroup.length + ' ' + (inGroup.length === 1 ? 'позицию' : 'позиции') + '?')) return;
    inGroup.forEach(function(r){ fillCatSelect(field(r, 'c'), mt, name); });
    var at = order.indexOf(key);
    if (at >= 0) order[at] = mt + '|' + name;
    regroup(); touch();
    say('Категория переименована в «' + name + '». Не забудьте сохранить меню.');
    return;
  }

  if (act === 'move') {
    var to = mt === 'furshet' ? 'banket' : 'furshet';
    if (!confirm('Перенести «' + cat + '» (' + inGroup.length + ') в ' + MENUS[to] + 'ное меню?')) return;
    inGroup.forEach(function(r){
      field(r, 'mt').value = to;
      r.dataset.mt = to;
      fillCatSelect(field(r, 'c'), to, cat);
    });
    regroup(); touch();
    say('Категория «' + cat + '» перенесена в ' + MENUS[to] + 'ное меню.');
    return;
  }

  if (act === 'merge') {
    var others = catsOf(mt).filter(function(c){ return c !== cat; });
    if (!others.length) { say('В этом меню больше нет категорий', true); return; }
    var target = prompt('С какой категорией объединить «' + cat + '»?\n\n'
      + others.map(function(c, i){ return (i + 1) + '. ' + c; }).join('\n')
      + '\n\nВведите номер или название:', '1');
    if (!target) return;
    target = /^\d+$/.test(target.trim()) ? others[parseInt(target, 10) - 1] : target.trim();
    if (!target || others.indexOf(target) < 0) { say('Такой категории нет', true); return; }
    inGroup.forEach(function(r){ fillCatSelect(field(r, 'c'), mt, target); });
    order = order.filter(function(k){ return k !== key; });
    regroup(); touch();
    say('«' + cat + '» объединена с «' + target + '».');
  }
});

/** Смена категории или меню у одной строки. */
list.addEventListener('change', function(e){
  var el = e.target;
  if (el.dataset.f === 'c' && el.value === '__new__') {
    var row = el.closest('.row');
    var name = (prompt('Название новой категории:', '') || '').trim();
    if (!name) { fillCatSelect(el, rowMt(row), rowCat(row)); return; }
    fillCatSelect(el, rowMt(row), name);
    regroup(); touch();
    return;
  }
  if (el.dataset.f === 'c' || el.dataset.f === 'mt') {
    var r2 = el.closest('.row');
    if (el.dataset.f === 'mt') {
      r2.dataset.mt = el.value;
      fillCatSelect(field(r2, 'c'), el.value, rowCat(r2));
    } else {
      el.title = el.value;
    }
    regroup(); touch();
  }
});

$('new_mt').addEventListener('change', refreshCatSelects);
$('new_c').addEventListener('change', function(){
  if (this.value !== '__new__') return;
  var name = (prompt('Название новой категории:', '') || '').trim();
  fillCatSelect(this, $('new_mt').value, name || catsOf($('new_mt').value)[0]);
});

function collect(){
  var out = [];
  rows().forEach(function(r){
    if (field(r, 'del').checked) return;
    var name = field(r, 'n').value.trim();
    if (!name) return;
    out.push({
      n: name,
      d: field(r, 'd').value.trim(),
      u: field(r, 'u').value.trim(),
      p: field(r, 'p').value,
      t: field(r, 't').checked ? 1 : 0,
      c: rowCat(r),
      mt: field(r, 'mt').value,
      ph: field(r, 'ph').value,
      off: field(r, 'off').checked ? 1 : 0
    });
  });
  return out;
}

function refresh(){
  var q = $('q').value.trim().toLowerCase(), t = $('mt').value, n = 0;
  rows().forEach(function(r){
    var text = (field(r, 'n').value + ' ' + field(r, 'd').value + ' ' + field(r, 'c').value).toLowerCase();
    var show = (!q || text.indexOf(q) >= 0) && (!t || field(r, 'mt').value === t);
    r.style.display = show ? '' : 'none';
    r.classList.toggle('hidden-item', field(r, 'off').checked);
    r.classList.toggle('to-delete', field(r, 'del').checked);
    if (show && !field(r, 'del').checked) n++;
  });
  Array.prototype.forEach.call(document.querySelectorAll('.cat'), function(head){
    var vis = false, el = head.nextElementSibling;
    while (el && el.classList.contains('row')) { if (el.style.display !== 'none') vis = true; el = el.nextElementSibling; }
    head.style.display = vis ? '' : 'none';
  });
  $('cnt').textContent = n;
}

$('q').addEventListener('input', refresh);
$('mt').addEventListener('change', refresh);
list.addEventListener('change', function(){ refresh(); touch(); });
list.addEventListener('input', function(e){ touch(); if (e.target.dataset.f === 'n') refresh(); });
$('transport').addEventListener('input', touch);

/* добавление строки */
$('add').addEventListener('click', function(){
  var name = $('new_n').value.trim();
  if (!name) { say('Впишите название блюда', true); return; }
  var tpl = rows()[0];
  var row = tpl.cloneNode(true);
  row.querySelector('.idx').textContent = rows().length + 1;
  field(row, 'n').value = name;
  field(row, 'd').value = '';
  field(row, 'u').value = $('new_u').value.trim();
  field(row, 'p').value = $('new_p').value.trim() || '0';
  field(row, 'mt').value = $('new_mt').value;
  row.dataset.mt = $('new_mt').value;
  fillCatSelect(field(row, 'c'), $('new_mt').value,
    ($('new_c').value && $('new_c').value !== '__new__') ? $('new_c').value : 'Разное');
  field(row, 'ph').value = '';
  field(row, 't').checked = false;
  field(row, 'off').checked = false;
  field(row, 'del').checked = false;
  row.classList.remove('hidden-item', 'to-delete');
  var th = row.querySelector('[data-thumb]');
  th.src = ''; th.style.display = 'none';
  list.appendChild(row);
  ['new_n', 'new_u', 'new_p'].forEach(function(id){ $(id).value = ''; });
  regroup();
  touch();
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  say('Блюдо «' + name + '» добавлено в список. Не забудьте сохранить меню.');
});

/* фотография */
list.addEventListener('change', function(e){
  var inp = e.target;
  if (!inp.hasAttribute || !inp.hasAttribute('data-photo') || !inp.files || !inp.files[0]) return;
  var row = inp.closest('.row');
  var fd = new FormData();
  fd.append('csrf', CSRF);
  fd.append('photo', inp.files[0]);
  inp.disabled = true;
  fetch('admin.php?api=photo', { method: 'POST', body: fd })
    .then(function(r){ return r.json(); })
    .then(function(j){
      inp.disabled = false;
      if (!j.ok) { say(j.error || 'Не удалось загрузить фото', true); return; }
      field(row, 'ph').value = j.url;
      var th = row.querySelector('[data-thumb]');
      th.src = j.url + '?v=' + Date.now();
      th.style.display = '';
      say('Фото загружено. Не забудьте сохранить меню.');
    })
    .catch(function(){ inp.disabled = false; say('Не удалось загрузить фото', true); });
});

/* сохранение */
function save(confirmed){
  var btn = $('save');
  var items = collect();
  var deleting = rows().filter(function(r){ return field(r, 'del').checked; }).length;
  if (deleting && !confirmed && !confirm('Удалить отмеченные позиции: ' + deleting + '?')) return;

  btn.disabled = true;
  btn.textContent = 'Сохраняем…';
  fetch('admin.php?api=save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrf: CSRF, transport: $('transport').value, items: items, confirm: !!confirmed })
  })
    .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })
    .then(function(res){
      btn.disabled = false;
      btn.textContent = 'Сохранить меню';
      if (res.s === 409 && res.j.need) {
        if (confirm(res.j.message)) save(true);
        return;
      }
      if (!res.j.ok) { say(res.j.error || 'Не удалось сохранить', true); return; }
      /* Проверяем, что сайт действительно отдаёт menu.json — иначе калькулятор
         останется на старом меню, зашитом в страницу. */
      fetch('menu.json?v=' + Date.now(), { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          if (j && j.items && j.items.length) {
            dirty = false;
            $('dirty').classList.remove('on');
            say(res.j.message + '. Обновляю список…');
            setTimeout(function(){ location.href = 'admin.php'; }, 700);
          } else {
            say(res.j.message + ', но сайт не отдаёт файл menu.json — калькулятор останется '
              + 'на прежнем меню. Проверьте в .htaccess, что menu.json разрешён к отдаче.', true);
          }
        })
        .catch(function(){
          say(res.j.message + ', но проверить menu.json не удалось. Откройте калькулятор '
            + 'и убедитесь, что правки видны.', true);
        });
    })
    .catch(function(){
      btn.disabled = false;
      btn.textContent = 'Сохранить меню';
      say('Сервер не ответил. Проверьте связь и попробуйте ещё раз — введённое не потеряется.', true);
    });
}
$('save').addEventListener('click', function(){ save(false); });

/* стартовый порядок категорий берём из того, как сервер отдал строки */
rows().forEach(function(r){
  fillCatSelect(field(r, 'c'), field(r, 'mt').value, field(r, 'c').dataset.value || 'Разное');
});
rows().forEach(function(r){
  var k = keyOf(r);
  if (order.indexOf(k) < 0) order.push(k);
});
regroup();
</script>
</body></html>
