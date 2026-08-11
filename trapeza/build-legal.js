'use strict';

/**
 * Собирает оферту и политику в две страницы для сайта.
 *
 *   node build-legal.js ../путь/к/папке/сайта
 *
 * Пока в lib/legal.js остались незаполненные реквизиты — сборка
 * останавливается: страница с «ЗАПОЛНИТЬ» вместо ИНН хуже, чем её отсутствие.
 * Чтобы посмотреть черновик, добавьте --draft.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG, missing, buildOfertaHtml, buildPolicyHtml } = require('./lib/legal');

const draft = process.argv.includes('--draft');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'legal-out'));

const gaps = missing();
if (gaps.length && !draft) {
  console.error('Не заполнено в lib/legal.js → CONFIG:');
  gaps.forEach((k) => console.error(`  • ${k}`));
  console.error('\nЗаполните и запустите снова, либо посмотрите черновик: --draft');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'oferta.html'), buildOfertaHtml(CONFIG));
fs.writeFileSync(path.join(out, 'politika.html'), buildPolicyHtml(CONFIG));

console.log(`Готово: ${path.join(out, 'oferta.html')}`);
console.log(`        ${path.join(out, 'politika.html')}`);
if (gaps.length) console.log(`\n⚠️  Это черновик: не заполнено — ${gaps.join(', ')}`);
console.log('\nПоложите обе страницы в корень сайта и укажите адреса в lib/bot-support.js.');
