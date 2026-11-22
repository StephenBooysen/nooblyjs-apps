// Numbers as the watch screens write them (product.md §3.2: every number has its unit, and its limit where there is
// one). Pure functions: tested in Node by test/format.test.js.

const num = (n, digits) => Number(n).toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** vCPU: "0.41", "<0.01" for a little, "0" for none. */
export function cpuText(v) {
  if (v === null || v === undefined) return '—';
  if (v > 0 && v < 0.01) return '<0.01';
  return num(v, v >= 10 ? 1 : 2);
}

/** Memory in MB as MB or GB: "58.5 MB", "2.2 GB". → [value, unit] */
export function memoryParts(mb) {
  if (mb === null || mb === undefined) return ['—', ''];
  if (mb >= 1024) return [num(mb / 1024, mb >= 10240 ? 0 : 1), 'GB'];
  return [num(mb, mb >= 100 ? 0 : 1), 'MB'];
}
export const memoryText = (mb) => memoryParts(mb).join(' ').trim();

/** Bytes (decimal units, as bandwidth is billed): "67.5 MB", "12.4 GB". → [value, unit] */
export function bytesParts(b) {
  if (b === null || b === undefined) return ['—', ''];
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return [num(v, i === 0 ? 0 : v >= 100 ? 0 : 1), units[i]];
}
export const bytesText = (b) => bytesParts(b).join(' ').trim();

/** Bytes per second: "3.1 MB/s". → [value, unit] */
export function rateParts(bps) {
  const [v, u] = bytesParts(bps);
  return [v, u ? `${u}/s` : ''];
}

/** A whole count: "1,240". */
export const countText = (n) => (n === null || n === undefined ? '—' : num(Math.round(n), 0));

/** used as a percentage of limit, 0–100 (0 when either is missing). */
export const pctOf = (used, limit) => (used === null || used === undefined || !limit ? 0 : Math.max(0, Math.min(100, (used / limit) * 100)));

/** How long ago: "just now", "12 min ago", "3 hours ago", "2 days ago". */
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? '' : 's'} ago`;
  return `${Math.round(s / 86_400)} day${Math.round(s / 86_400) === 1 ? '' : 's'} ago`;
}

/** How long something has run: "Up 40 s", "Up 12 min", "Up 3 h", "Up 2 days". */
export function uptime(iso, now = Date.now()) {
  if (!iso) return 'Not started';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return `Up ${Math.round(s)} s`;
  if (s < 3600) return `Up ${Math.round(s / 60)} min`;
  if (s < 86_400) return `Up ${Math.round(s / 3600)} h`;
  return `Up ${Math.round(s / 86_400)} day${Math.round(s / 86_400) === 1 ? '' : 's'}`;
}

/** A log line's time with milliseconds, in the viewer's time zone: "08:21:04.112". */
export function logTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** How long a deploy took: "48 s", "3 min 12 s". */
export function duration(fromIso, toIso) {
  if (!fromIso || !toIso) return '';
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The left label under a chart for a range: "1 hour ago", "24 hours ago", "7 days ago", "30 days ago". */
export const RANGE_START = { '1h': '1 hour ago', '24h': '24 hours ago', '7d': '7 days ago', '30d': '30 days ago' };
