// Customer logs (roadmap 4.3; stack.md §4.3). Every line a service's containers write reaches us within seconds
// (services.platform.telemetry.subscribe({ onLogs }), infra 8.5 R3); its deploys' build lines are added when a deploy
// ends. This store:
//
//   - gives each line a level: from a JSON line's level field, logfmt's level=, a [LEVEL] tag or a leading LEVEL word;
//     otherwise stderr is an error and stdout is info. Build lines are `build`.
//   - keeps the last RING lines of each service in memory (the live view and recent searches),
//   - writes the lines through core `filing` once a minute as logs/<workspace>/<service>/<YYYY-MM-DDTHH-mm>-<n>.ndjson
//     (filing has no append, so each flush is a new file; the folder stays flat so the sweep needs no folder delete),
//   - searches a window by reading the ring and the files that can hold it (no search index in v1: an hour is at most
//     sixty small files; stack.md §8, decided 2026-11-21),
//   - deletes files older than the service's plan keeps them (catalog PLANS[].logDays).

const RING = 5000;
const MAX_LINE = 16_384;
export const LEVELS = ['debug', 'info', 'warn', 'error', 'build'];
const WORDS = { trace: 'debug', debug: 'debug', info: 'info', notice: 'info', warn: 'warn', warning: 'warn', err: 'error', error: 'error', crit: 'error', critical: 'error', fatal: 'error', panic: 'error' };
const PINO = (n) => (n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : 'debug');
const LEVEL_WORD = 'TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERR(?:OR)?|CRIT(?:ICAL)?|FATAL|PANIC';
const TAGGED = new RegExp(`\\[(${LEVEL_WORD})\\]`, 'i');
const LEADING = new RegExp(`^\\W{0,3}(${LEVEL_WORD})\\b`, 'i');
const LOGFMT = /(?:^|\s)level=("?)(\w+)\1(?:\s|$)/i;

/** A line's level, in our five words. */
export function levelOf(line, stream = 'stdout') {
  const text = String(line ?? '');
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const v = j.level ?? j.severity ?? j.lvl ?? j.loglevel;
      if (typeof v === 'number') return PINO(v);
      if (typeof v === 'string' && WORDS[v.toLowerCase()]) return WORDS[v.toLowerCase()];
    } catch { /* not JSON after all */ }
  }
  const m = LOGFMT.exec(text) ?? null;
  if (m && WORDS[m[2].toLowerCase()]) return WORDS[m[2].toLowerCase()];
  const tag = TAGGED.exec(text) ?? LEADING.exec(text);
  if (tag) return WORDS[tag[1].toLowerCase()] ?? 'info';
  return stream === 'stderr' ? 'error' : 'info';
}

const fileStamp = (t) => new Date(t).toISOString().slice(0, 16).replace(':', '-');
const stampTime = (name) => Date.parse(`${name.slice(0, 13)}:${name.slice(14, 16)}:00Z`);

/**
 * @param {object} o
 * @param {object} [o.filing]   core filing (memory only without it)
 * @param {(ws: string, svc: string) => Promise<number>} [o.retentionDays]
 * @param {() => number} [o.now]
 * @param {{ warn?: Function }} [o.log]
 */
export function createLogStore({ filing = null, retentionDays = async () => 7, now = () => Date.now(), log = {} } = {}) {
  const services = new Map(); // `${ws}/${svc}` → { ring: [], pending: [], seq }
  let seq = 0;
  let chunk = 0;
  const stateOf = (ws, svc) => {
    const key = `${ws}/${svc}`;
    if (!services.has(key)) services.set(key, { ws, svc, ring: [], pending: [] });
    return services.get(key);
  };
  const dirOf = (ws, svc) => `logs/${ws}/${svc}`;

  /** A test for a query's window, levels and text. */
  const matcher = ({ level, q, since, until }) => {
    const query = q ? String(q).toLowerCase() : '';
    const from = since ? Date.parse(since) : -Infinity;
    const to = until ? Date.parse(until) : Infinity;
    const levels = level ? new Set(String(level).split(',')) : null;
    return (l) => {
      const t = Date.parse(l.at);
      return t >= from && t < to && (!levels || levels.has(l.level)) && (!query || l.line.toLowerCase().includes(query) || String(l.instance ?? '').includes(query));
    };
  };

  async function readFiles(ws, svc, { since, until }, before) {
    if (!filing) return [];
    let names;
    try {
      names = (await filing.list(dirOf(ws, svc))).filter((e) => e.isFile && e.name.endsWith('.ndjson')).map((e) => e.name);
    } catch {
      return [];
    }
    const from = since ? Date.parse(since) : -Infinity;
    const to = Math.min(until ? Date.parse(until) : Infinity, before ?? Infinity);
    // A file named for minute m holds lines from m up to its flush, a minute or so later.
    const wanted = names.filter((n) => {
      const t = stampTime(n);
      return t <= to && t >= from - 3 * 60_000;
    }).sort();
    const out = [];
    for (const name of wanted) {
      try {
        const text = String(await filing.read(`${dirOf(ws, svc)}/${name}`, 'utf8'));
        for (const row of text.split('\n')) {
          if (!row) continue;
          const l = JSON.parse(row);
          if (Date.parse(l.at) < (before ?? Infinity)) out.push({ ...l, service: svc });
        }
      } catch (err) {
        log.warn?.(`[hero-co] could not read ${name}: ${err.message}`);
      }
    }
    return out;
  }

  return {
    /**
     * Adds a service's lines: [{ at, instance, stream, line, level? }]. → the lines as stored, with id and level.
     */
    add(ws, svc, lines) {
      const s = stateOf(ws, svc);
      const added = lines.map((l) => {
        const text = String(l.line ?? '');
        const cut = text.length > MAX_LINE;
        const line = cut ? `${text.slice(0, MAX_LINE)} … (cut: the line was ${text.length.toLocaleString('en')} characters)` : text;
        return {
          id: `${Date.now().toString(36)}-${(seq += 1).toString(36)}`,
          at: l.at ?? new Date(now()).toISOString(),
          instance: l.instance ?? null,
          stream: l.stream ?? 'stdout',
          level: l.level && LEVELS.includes(l.level) ? l.level : levelOf(line, l.stream),
          line,
        };
      });
      s.ring.push(...added);
      // Build lines arrive after the fact: keep the ring in time order.
      if (added.some((l) => l.level === 'build')) s.ring.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (s.ring.length > RING) s.ring.splice(0, s.ring.length - RING);
      s.pending.push(...added);
      return added;
    },

    /**
     * Lines of one or more services in a window, newest `limit` of them, oldest first.
     * @param {string} ws
     * @param {{ services: string[], level?: string, q?: string, since?: string, until?: string, limit?: number, cap?: number }} o
     *   cap: the most `limit` may ask for (2,000 for a page; a download asks for more)
     * @returns {Promise<{ lines: object[], more: boolean }>}
     */
    async query(ws, { services: names, level, q, since, until, limit = 500, cap: most = 2000 }) {
      const match = matcher({ level, q, since, until });
      const found = [];
      for (const svc of names) {
        const s = stateOf(ws, svc);
        const ringFrom = s.ring.length ? Date.parse(s.ring[0].at) : Infinity;
        const older = ringFrom === Infinity ? await readFiles(ws, svc, { since, until }) : (since && Date.parse(since) >= ringFrom ? [] : await readFiles(ws, svc, { since, until }, ringFrom));
        found.push(...older.filter(match), ...s.ring.filter(match).map((l) => ({ ...l, service: svc })));
      }
      found.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const cap = Math.min(Math.max(1, Number(limit) || 500), most);
      return { lines: found.slice(-cap), more: found.length > cap };
    },

    /** Writes every service's new lines (one file per service per flush). */
    async flush() {
      if (!filing) {
        for (const s of services.values()) s.pending = [];
        return;
      }
      for (const s of services.values()) {
        if (!s.pending.length) continue;
        const lines = s.pending.splice(0);
        lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const name = `${fileStamp(Date.parse(lines[0].at) || now())}-${(chunk += 1).toString(36)}${Date.now().toString(36).slice(-4)}.ndjson`;
        try {
          await filing.create(`${dirOf(s.ws, s.svc)}/${name}`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
        } catch (err) {
          s.pending.unshift(...lines);
          log.warn?.(`[hero-co] could not save logs for ${s.ws}/${s.svc}: ${err.message}`);
        }
      }
    },

    /** Deletes the files older than each service keeps them. → how many went. */
    async sweep(workspaces) {
      if (!filing) return 0;
      let gone = 0;
      for (const ws of workspaces) {
        let dirs;
        try {
          dirs = (await filing.list(`logs/${ws}`)).filter((e) => e.isDirectory).map((e) => e.name);
        } catch {
          continue;
        }
        for (const svc of dirs) {
          const days = await retentionDays(ws, svc);
          const cutoff = now() - days * 86_400_000;
          let files;
          try {
            files = (await filing.list(dirOf(ws, svc))).filter((e) => e.isFile && e.name.endsWith('.ndjson'));
          } catch {
            continue;
          }
          for (const f of files) {
            // A file's newest line is at most a few minutes after the minute it is named for.
            if (stampTime(f.name) + 5 * 60_000 >= cutoff) continue;
            await filing.delete(`${dirOf(ws, svc)}/${f.name}`).catch(() => {});
            gone += 1;
          }
        }
      }
      return gone;
    },

    /** Forgets a service's lines in memory. */
    forget(ws, svc) {
      services.delete(`${ws}/${svc}`);
    },
  };
}
