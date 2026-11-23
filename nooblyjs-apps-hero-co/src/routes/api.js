// /api/v1: what the browser asks this app (not the accelerators, which have their own APIs).
import { OPERATORS } from '../platform/realtime.js';

const HEARTBEAT_MS = 25_000;
/** How often an open event stream checks that its person may still see each workspace on it (roadmap 8.3). */
export const RECHECK_MS = 10_000;

/**
 * @param {object} o
 * @param {typeof import('express')} o.express
 * @param {ReturnType<import('../platform/session.js').createSession>} o.session
 * @param {ReturnType<import('../platform/realtime.js').createRealtime>} o.realtime
 * @param {() => object[]} o.accelerators   describe() of the mounted accelerators
 * @param {{ name: string, version: string }} o.about
 * @param {number} [o.recheckMs]   how often an event stream re-reads who it is for (tests make it short)
 */
export function createApi({ express, session, realtime, accelerators, about, recheckMs = RECHECK_MS }) {
  const router = express.Router();

  router.get('/about', (req, res) => res.json(about));

  /** The signed-in person and their workspaces (the shell's top bar and switcher). */
  router.get('/me', session.auth, (req, res) => {
    const { id, name, email, emailVerified, githubLogin, operator, workspaces } = req.person;
    res.json({ id, name, email, emailVerified, githubLogin, operator, workspaces });
  });

  /** Operators: what is mounted and what is still to come. */
  router.get('/admin/accelerators', session.requireOperator, (req, res) => res.json({ items: accelerators() }));

  /** Server-Sent Events: the person's workspaces (and the operator channel for operators). */
  router.get('/events', session.auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const topics = req.person.workspaces.map((w) => w.id);
    if (req.person.operator) topics.push(OPERATORS);
    send('hello', { person: req.person.id, topics: topics.filter((t) => t !== OPERATORS) });
    const unsubscribe = realtime.subscribe(topics, (event) => send(event.type, { ...event.data, at: event.at }));
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    // Signed out, a password reset, removed from a workspace, no longer an operator: the stream ends, and the browser's
    // reconnect gets only what the person may see now (or a 401).
    let checking = false;
    const recheck = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const now = await session.current(req);
        const allowed = new Set(now?.workspaces.map((w) => w.id) ?? []);
        if (now?.operator) allowed.add(OPERATORS);
        if (!now || topics.some((t) => !allowed.has(t))) res.end();
      } catch {
        res.end();
      } finally {
        checking = false;
      }
    }, recheckMs);
    recheck.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(recheck);
      unsubscribe();
    });
  });

  router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } }));
  return router;
}
