// Cron schedules (roadmap 5.3), always in UTC as Render's are. Shared by the server (validation, the scheduler) and the
// browser (the create form's preview, the service page), so it imports nothing.
//
// Five fields, numbers only: minute (0–59), hour (0–23), day of month (1–31), month (1–12), day of week (0–6, Sunday 0;
// 7 is Sunday too). Each field takes *, n, a-b, lists (a,b,c) and steps (*/n, a-b/n). @hourly, @daily, @weekly and
// @monthly are shorthands. Day of month and day of week restricted together match when either does (cron's rule).

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];
const SHORTHANDS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const CRON_HINT = 'Five fields in UTC: minute, hour, day of month, month, day of week. For example 0 2 * * * runs every day at 02:00 UTC.';

function field(token, { name, min, max }) {
  const values = new Set();
  for (const part of token.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return { error: `The ${name} field "${part}" is not a number, a range, a list or a step.` };
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (lo < min || hi > max || lo > hi) return { error: `The ${name} field goes from ${min} to ${max}${name === 'day of week' ? ' (Sunday is 0)' : ''}.` };
    if (!(step >= 1)) return { error: `A step in the ${name} field is 1 or more.` };
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

/** → { fields: [Set×5], restricted: { dom, dow }, expression } or { error } (in words). */
export function parseCron(input) {
  if (typeof input !== 'string' || !input.trim()) return { error: 'Enter a schedule.' };
  const expression = input.trim().replace(/\s+/g, ' ');
  const text = SHORTHANDS[expression.toLowerCase()] ?? expression;
  const tokens = text.split(' ');
  if (tokens.length !== 5) return { error: `A schedule has five fields; this has ${tokens.length}. ${CRON_HINT}` };
  const fields = [];
  for (let i = 0; i < 5; i += 1) {
    const f = field(tokens[i], FIELDS[i]);
    if (f.error) return { error: f.error };
    fields.push(f.values);
  }
  if (fields[4].has(7)) fields[4].add(0);
  return { fields, tokens, restricted: { dom: tokens[2] !== '*', dow: tokens[4] !== '*' }, expression };
}

/** Whether a parsed schedule fires in the UTC minute that holds `date`. */
export function cronMatches(parsed, date) {
  const d = new Date(date);
  const [min, hour, dom, month, dow] = parsed.fields;
  if (!min.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !month.has(d.getUTCMonth() + 1)) return false;
  return dayMatches(parsed, d);
}

function dayMatches(parsed, d) {
  const domOk = parsed.fields[2].has(d.getUTCDate());
  const dowOk = parsed.fields[4].has(d.getUTCDay());
  if (parsed.restricted.dom && parsed.restricted.dow) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next `count` times (Date, UTC minutes) after `from` that the schedule fires; at most a year ahead. */
export function nextRuns(input, from = new Date(), count = 3) {
  const parsed = typeof input === 'string' ? parseCron(input) : input;
  if (!parsed || parsed.error) return [];
  const out = [];
  const t = new Date(Math.floor(new Date(from).getTime() / 60_000) * 60_000 + 60_000);
  const limit = t.getTime() + 366 * 86_400_000;
  while (out.length < count && t.getTime() <= limit) {
    if (!parsed.fields[3].has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(parsed, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!parsed.fields[1].has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!parsed.fields[0].has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else {
      out.push(new Date(t));
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    }
  }
  return out;
}

const two = (n) => String(n).padStart(2, '0');
const isNum = (s) => /^\d+$/.test(s);
const step = (s) => /^\*\/(\d+)$/.exec(s)?.[1];

function daysText(token) {
  if (token === '1-5') return 'every weekday (Monday to Friday)';
  if (token === '0,6' || token === '6,0') return 'every Saturday and Sunday';
  if (isNum(token)) return `every ${DAYS[Number(token) % 7]}`;
  if (/^\d+(,\d+)+$/.test(token)) return `every ${token.split(',').map((d) => SHORT_DAYS[Number(d) % 7]).join(', ')}`;
  return null;
}

/** The schedule in words: "Every day at 02:00 UTC", "Every 15 minutes". Unusual ones say the expression. */
export function describeCron(input) {
  const parsed = typeof input === 'string' ? parseCron(input) : input;
  if (!parsed || parsed.error) return '';
  const [m, h, dom, mon, dow] = parsed.tokens;
  const plain = `On the schedule ${parsed.expression} (UTC)`;
  if (mon !== '*') return plain;
  if (m === '*' && h === '*' && dom === '*' && dow === '*') return 'Every minute';
  if (step(m) && h === '*' && dom === '*' && dow === '*') return `Every ${step(m)} minutes`;
  if (!isNum(m)) return plain;
  if (h === '*' && dom === '*' && dow === '*') return Number(m) === 0 ? 'Every hour, on the hour' : `Every hour at ${two(m)} minutes past`;
  if (step(h) && dom === '*' && dow === '*') return `Every ${step(h)} hours at ${two(m)} minutes past (from 00:${two(m)} UTC)`;
  if (!isNum(h)) return plain;
  const at = `at ${two(h)}:${two(m)} UTC`;
  if (dom === '*' && dow === '*') return `Every day ${at}`;
  if (dom === '*' && daysText(dow)) return `${daysText(dow)[0].toUpperCase()}${daysText(dow).slice(1)} ${at}`;
  if (isNum(dom) && dow === '*') return `On day ${Number(dom)} of every month ${at}`;
  return plain;
}
