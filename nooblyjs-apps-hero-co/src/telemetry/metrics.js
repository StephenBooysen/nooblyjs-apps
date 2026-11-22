// Metric history (roadmap 4.2; stack.md §4.2). The platform sends one sample per instance every 10 s
// (services.platform.telemetry.subscribe({ onMetrics }), infra 8.5); the proxy in front of Local network services
// counts their requests and bytes (src/routes/proxy.js). This keeps, per service:
//
//   - 10 s points for the last hour (memory only: a restart leaves a gap),
//   - 1 minute roll-ups for 24 hours and 1 hour roll-ups for 30 days, saved through core `filing` as
//     metrics/<workspace>/<service>.json every minute and at shutdown,
//   - month totals of requests and bytes out (the dashboard's "Bandwidth this month"),
//   - each instance's latest sample (the instance tiles).
//
// nooblyjs-core's `measuring` keeps raw values in memory with no roll-ups, retention or persistence, so it is not used
// for this (stack.md §8, decided 2026-11-21).
//
// A point: { t, cpu, mem, req, err, bytes }. cpu (vCPU) and mem (MB) are the sum over instances; req, err (5xx) and
// bytes are counts within the point's step. Roll-ups keep the mean of cpu and mem and the sum of the counts.

export const STEP = { raw: 10_000, minute: 60_000, hour: 3_600_000 };
const KEEP = { raw: 3_600_000, minute: 86_400_000, hour: 30 * 86_400_000 };
/** Chart ranges: which tier draws them. */
export const RANGES = {
  '1h': { ms: 3_600_000, tier: 'raw' },
  '24h': { ms: 86_400_000, tier: 'minute' },
  '7d': { ms: 7 * 86_400_000, tier: 'hour' },
  '30d': { ms: 30 * 86_400_000, tier: 'hour' },
};
const MAX_POINTS = 240;
const INSTANCE_STALE_MS = 60_000;
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);

/** Means of cpu and mem (over points that have them) and sums of the counts, as one point at `t`. */
export function combine(points, t) {
  const withCpu = points.filter((p) => p.cpu !== null && p.cpu !== undefined);
  const mean = (k) => (withCpu.length ? round(withCpu.reduce((s, p) => s + p[k], 0) / withCpu.length) : null);
  return {
    t,
    cpu: mean('cpu'),
    mem: withCpu.length ? round(withCpu.reduce((s, p) => s + p.mem, 0) / withCpu.length, 1) : null,
    req: points.reduce((s, p) => s + (p.req ?? 0), 0),
    err: points.reduce((s, p) => s + (p.err ?? 0), 0),
    bytes: points.reduce((s, p) => s + (p.bytes ?? 0), 0),
  };
}

/** Points grouped into buckets of `step` ms (aligned to the epoch), each combined. */
export function rollUp(points, step) {
  const groups = new Map();
  for (const p of points) {
    const t = Math.floor(p.t / step) * step;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(p);
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([t, list]) => combine(list, t));
}

/**
 * @param {object} o
 * @param {{ create: Function, read: Function }} [o.filing]   core filing (no persistence without it)
 * @param {() => number} [o.now]
 * @param {{ warn?: Function }} [o.log]
 */
export function createMetrics({ filing = null, now = () => Date.now(), log = {} } = {}) {
  const services = new Map(); // `${ws}/${svc}` → state
  const pathOf = (key) => `metrics/${key}.json`;

  function stateOf(ws, svc) {
    const key = `${ws}/${svc}`;
    let s = services.get(key);
    if (!s) {
      s = { key, raw: new Map(), minute: [], hour: [], months: {}, instances: new Map(), rolled: { minute: 0, hour: 0 }, dirty: false, loaded: null };
      services.set(key, s);
      s.loaded = load(s);
    }
    return s;
  }

  /** Merges what was saved before a restart (older points; month totals add up). */
  async function load(s) {
    if (!filing) return;
    let saved;
    try {
      saved = JSON.parse(String(await filing.read(pathOf(s.key), 'utf8')));
    } catch {
      return; // nothing saved yet
    }
    const merge = (mine, theirs) => [...theirs.filter((p) => !mine.some((m) => m.t === p.t)), ...mine].sort((a, b) => a.t - b.t);
    s.minute = merge(s.minute, saved.minute ?? []);
    s.hour = merge(s.hour, saved.hour ?? []);
    for (const [m, v] of Object.entries(saved.months ?? {})) {
      const cur = s.months[m] ?? { req: 0, bytes: 0 };
      s.months[m] = { req: cur.req + (v.req ?? 0), bytes: cur.bytes + (v.bytes ?? 0) };
    }
    s.rolled.minute = Math.max(s.rolled.minute, saved.rolled?.minute ?? 0);
    s.rolled.hour = Math.max(s.rolled.hour, saved.rolled?.hour ?? 0);
  }

  function bucket(s, t) {
    const at = Math.floor(t / STEP.raw) * STEP.raw;
    let b = s.raw.get(at);
    if (!b) {
      b = { t: at, cpu: new Map(), mem: new Map(), req: 0, err: 0, bytes: 0 };
      s.raw.set(at, b);
    }
    return b;
  }
  const rawPoint = (b) => {
    const has = b.cpu.size > 0;
    return { t: b.t, cpu: has ? round([...b.cpu.values()].reduce((x, y) => x + y, 0)) : null, mem: has ? round([...b.mem.values()].reduce((x, y) => x + y, 0), 1) : null, req: b.req, err: b.err, bytes: b.bytes };
  };

  /** Moves finished minutes into the minute tier and finished hours into the hour tier; drops what is too old. */
  function roll(s) {
    const t = now();
    const doneMinute = Math.floor(t / STEP.minute) * STEP.minute;
    const fresh = [...s.raw.values()].map(rawPoint).filter((p) => p.t >= s.rolled.minute && p.t < doneMinute);
    if (fresh.length) {
      s.minute.push(...rollUp(fresh, STEP.minute));
      s.rolled.minute = doneMinute;
      s.dirty = true;
    }
    const doneHour = Math.floor(t / STEP.hour) * STEP.hour;
    const minutes = s.minute.filter((p) => p.t >= s.rolled.hour && p.t < doneHour);
    if (minutes.length) {
      s.hour.push(...rollUp(minutes, STEP.hour));
      s.rolled.hour = doneHour;
      s.dirty = true;
    }
    for (const at of s.raw.keys()) if (at < t - KEEP.raw) s.raw.delete(at);
    s.minute = s.minute.filter((p) => p.t >= t - KEEP.minute);
    s.hour = s.hour.filter((p) => p.t >= t - KEEP.hour);
    for (const [name, inst] of s.instances) if (Date.parse(inst.at) < t - KEEP.raw) s.instances.delete(name);
  }

  return {
    /** One instance's sample from the platform (infra 8.5 R1). */
    sample(ws, svc, x) {
      const s = stateOf(ws, svc);
      const t = Date.parse(x.at) || now();
      const b = bucket(s, t);
      b.cpu.set(x.instance, x.cpu?.value ?? 0);
      b.mem.set(x.instance, x.memory?.value ?? 0);
      s.instances.set(x.instance, {
        at: new Date(t).toISOString(), cpu: x.cpu?.value ?? 0, cpuLimit: x.cpu?.limit ?? null, mem: x.memory?.value ?? 0, memLimit: x.memory?.limit ?? null,
      });
    },

    /** One request through the proxy: its status and the bytes sent back. */
    request(ws, svc, { status = 200, bytes = 0, at } = {}) {
      const s = stateOf(ws, svc);
      const t = at ?? now();
      const b = bucket(s, t);
      b.req += 1;
      if (status >= 500) b.err += 1;
      b.bytes += bytes;
      const m = monthOf(t);
      const cur = s.months[m] ?? { req: 0, bytes: 0 };
      s.months[m] = { req: cur.req + 1, bytes: cur.bytes + bytes };
      s.dirty = true;
    },

    /** Waits for a service's saved history to be read (the first call for it starts the read). */
    ready: (ws, svc) => stateOf(ws, svc).loaded,

    /**
     * A service's chart over a range: at most MAX_POINTS points, oldest first, each with per-step rates
     * (requests per minute, bytes per second) as well as its sums.
     */
    async series(ws, svc, range = '1h') {
      const r = RANGES[range] ?? RANGES['1h'];
      const s = stateOf(ws, svc);
      await s.loaded;
      roll(s);
      const to = now();
      const from = to - r.ms;
      const raw = [...s.raw.values()].map(rawPoint);
      let points;
      let step;
      if (r.tier === 'raw') {
        points = raw;
        step = STEP.raw;
      } else if (r.tier === 'minute') {
        // The current minute is still in the raw tier.
        points = [...s.minute, ...rollUp(raw.filter((p) => p.t >= s.rolled.minute), STEP.minute)];
        step = STEP.minute;
      } else {
        const lateMinutes = [...s.minute.filter((p) => p.t >= s.rolled.hour), ...rollUp(raw.filter((p) => p.t >= s.rolled.minute), STEP.minute)];
        points = [...s.hour, ...rollUp(lateMinutes, STEP.hour)];
        step = STEP.hour;
      }
      points = points.filter((p) => p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
      // Too many to draw: merge neighbours.
      if (points.length > MAX_POINTS) {
        const factor = Math.ceil(points.length / MAX_POINTS);
        step *= factor;
        points = rollUp(points, step);
      }
      return {
        range, from, to, step,
        points: points.map((p) => ({ ...p, reqPerMin: round((p.req * 60_000) / step, 1), bytesPerSec: round((p.bytes * 1000) / step, 1) })),
      };
    },

    /**
     * What a service uses now: CPU and memory from each instance's latest sample (within a minute), requests per
     * minute and bytes per second over the last minute, and the month's totals.
     */
    current(ws, svc) {
      const s = stateOf(ws, svc);
      const t = now();
      const live = [...s.instances].filter(([, i]) => Date.parse(i.at) >= t - INSTANCE_STALE_MS);
      const lastMinute = [...s.raw.values()].filter((b) => b.t >= t - 60_000);
      const month = s.months[monthOf(t)] ?? { req: 0, bytes: 0 };
      return {
        at: new Date(t).toISOString(),
        instances: live.length,
        cpu: live.length ? round(live.reduce((x, [, i]) => x + i.cpu, 0)) : null,
        cpuLimit: live.length && live.every(([, i]) => i.cpuLimit !== null) ? round(live.reduce((x, [, i]) => x + i.cpuLimit, 0)) : null,
        memoryMb: live.length ? round(live.reduce((x, [, i]) => x + i.mem, 0), 1) : null,
        memoryLimitMb: live.length && live.every(([, i]) => i.memLimit !== null) ? live.reduce((x, [, i]) => x + i.memLimit, 0) : null,
        reqPerMin: lastMinute.reduce((x, b) => x + b.req, 0),
        bytesPerSec: round(lastMinute.reduce((x, b) => x + b.bytes, 0) / 60, 1),
        monthRequests: month.req,
        monthBytes: month.bytes,
      };
    },

    /** Each instance's latest sample: Map(instance → { at, cpu, cpuLimit, mem, memLimit }). */
    instances: (ws, svc) => new Map(stateOf(ws, svc).instances),

    /** A workspace's bytes out this month, over every service it has had. */
    async monthBytes(ws) {
      const m = monthOf(now());
      let total = 0;
      for (const s of services.values()) {
        if (!s.key.startsWith(`${ws}/`)) continue;
        await s.loaded;
        total += s.months[m]?.bytes ?? 0;
      }
      return total;
    },

    /** Saves the services whose roll-ups changed. */
    async flush() {
      for (const s of services.values()) {
        roll(s);
        if (!s.dirty || !filing) continue;
        await s.loaded;
        s.dirty = false;
        const body = JSON.stringify({ minute: s.minute, hour: s.hour, months: s.months, rolled: s.rolled });
        try {
          await filing.create(pathOf(s.key), body);
        } catch (err) {
          s.dirty = true;
          log.warn?.(`[hero-co] could not save metrics for ${s.key}: ${err.message}`);
        }
      }
    },

    /** Forgets a deleted service (its saved file stays until the workspace goes). */
    forget(ws, svc) {
      services.delete(`${ws}/${svc}`);
    },
  };
}
