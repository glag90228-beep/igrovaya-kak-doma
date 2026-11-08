'use strict';

/**
 * Замок на один экземпляр.
 *
 * Telegram отдаёт входящие сообщения ровно одному читателю: если запустить
 * бота дважды (служба + руками в терминале), они начинают отбирать друг у
 * друга обновления, и на каждый вызов прилетает «Conflict: terminated by
 * other getUpdates request». Со стороны это выглядит как «бот отвечает
 * через раз», а лог забивается сотнями одинаковых строк.
 *
 * Дешевле не допустить, чем объяснять. Перед стартом кладём файл с номером
 * процесса; если файл уже есть и тот процесс жив — не запускаемся и прямо
 * говорим, кто занял место.
 *
 * Осознанные ограничения: замок работает в пределах одной машины и не
 * спасёт от копии бота на другом сервере — там поможет только сообщение
 * об ошибке в логе, которое мы тоже сделали внятным.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Жив ли процесс с таким номером. Сигнал 0 ничего не делает, только проверяет. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Занимает замок.
 * @returns {{ok:true, release:Function}|{ok:false, pid:number, file:string}}
 */
function acquire(name, dir) {
  const folder = dir || path.join(__dirname, '..', 'data');
  const file = path.join(folder, `${name}.lock`);
  fs.mkdirSync(folder, { recursive: true });

  const take = () => {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      // Снимаем только свой замок: чужой мог занять место, пока мы падали.
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
      } catch (_) { /* уже убран */ }
    };
    process.once('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => { release(); process.exit(0); });
    }
    return { ok: true, release, file };
  };

  try {
    return take();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (alive(pid)) return { ok: false, pid, file };
    // Остался от упавшего процесса — забираем.
    fs.unlinkSync(file);
    return take();
  }
}

module.exports = { acquire, alive };
