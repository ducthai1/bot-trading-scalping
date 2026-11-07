// Crash-safe persistence (Linux + macOS): state.json is replaced atomically (write temp, fsync,
// rename); history tables are append-only JSONL. A lock file keeps a second instance from writing.
import { mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, appendFileSync, existsSync, unlinkSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (f) => path.join(dir, f);
  const lockFile = file('bot.lock');

  function writeAtomic(name, text) {
    const tmp = file(`${name}.${process.pid}.tmp`);
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file(name));
  }

  function readJSON(name) {
    for (const n of [name, `${name}.bak`]) {
      try {
        return JSON.parse(readFileSync(file(n), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT' && n === name) console.error(`⚠️ ${name} hỏng (${e.message}), thử bản .bak`);
      }
    }
    return null;
  }

  return {
    dir,
    file,
    loadState: () => readJSON('state.json'),
    saveState(state) {
      if (existsSync(file('state.json'))) copyFileSync(file('state.json'), file('state.json.bak'));
      writeAtomic('state.json', JSON.stringify(state));
    },
    append(name, rows) {
      if (!rows.length) return;
      appendFileSync(file(name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
    // Tolerates a torn last line (power loss mid-append) and any corrupted line.
    readJSONL(name) {
      if (!existsSync(file(name))) return [];
      const out = [];
      for (const line of readFileSync(file(name), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* skip corrupted line */
        }
      }
      return out;
    },
    // Keep the event log bounded.
    rotate(name, maxBytes = 5e6) {
      try {
        if (statSync(file(name)).size > maxBytes) renameSync(file(name), file(`${name}.1`));
      } catch {
        /* missing file is fine */
      }
    },
    acquireLock() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = openSync(lockFile, 'wx');
          writeSync(fd, String(process.pid));
          closeSync(fd);
          return true;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const pid = Number(readFileSync(lockFile, 'utf8').trim());
          if (pid && pid !== process.pid && isAlive(pid)) return false;
          unlinkSync(lockFile); // stale lock from a crashed / killed process
        }
      }
      return false;
    },
    releaseLock() {
      try {
        if (Number(readFileSync(lockFile, 'utf8').trim()) === process.pid) unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    },
    writeAtomic,
  };
}

