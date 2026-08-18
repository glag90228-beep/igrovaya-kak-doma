'use strict';

/**
 * Свежая база на каждый прогон тестов.
 *
 * Подключать первой строкой в каждом самотесте — до всего, что тянет db.js.
 *
 * Зачем. Без TRAPEZA_DB база берётся по умолчанию: `<папка проекта>/data/
 * trapeza.db`. Отсюда две беды.
 *
 * Первая: прогоны перестают быть независимыми. Второй `npm test` подряд
 * падает — нумерация документов продолжается с прошлого раза, и проверка
 * «номер присвоен сам → 1» видит 15.
 *
 * Вторая тяжелее. На сервере приложение развёрнуто в /opt/trapeza, и боевая
 * база клиентов лежит ровно по этому пути. `npm test`, запущенный там, залил
 * бы в неё тестовых пользователей, организации и документы. README при этом
 * прямо советует `cd trapeza && npm test`.
 *
 * Поэтому: своя временная база, если путь не задан явно. Задан — уважаем,
 * это осознанное решение запускающего.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.TRAPEZA_DB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trapeza-selftest-'));
  process.env.TRAPEZA_DB = path.join(dir, 'test.db');
}

module.exports = process.env.TRAPEZA_DB;
