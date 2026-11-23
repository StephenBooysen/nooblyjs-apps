// Mounts the three accelerators the same way, mount(app, eventEmitter, serviceRegistry, options) (stack.md §3.5):
// customers → payments → infrastructure, and shuts them down in reverse. Everything is checked before anything is
// mounted, so a bad start leaves the app without half an accelerator.
//
//   customers       /admin/customer/, /admin/marketing/   operator back office (stack.md §3.3)
//   payments        /admin/payments/, /admin/billing/     operator screens and APIs; /admin/payments/p and /components are
//                                                         public (webhooks, hosted invoices, the card form)
//   infrastructure  /infrastructure/                      operator control plane (stack.md §3.2)
//
// The operator rail (nooblyjs-core's shell) has one button per screen: Customers, Marketing, Payments, Infrastructure.
// Infrastructure is the accelerator's own frame app. The other three are their accelerators' pages, shown in the frame
// at /customers, /marketing and /payments (public/js/operator/embed.js); their own URLs under /admin still answer.
import path from 'node:path';
import { INFRA_HOST_NEEDS } from './host.js';

export const INFRA_MOUNT = '/infrastructure';
export const CX_BASE = '/admin';
/** Customers' public routes (tracking, unsubscribe, webhooks): no sign-in. */
export const CX_PUBLIC = `${CX_BASE}/marketing/p`;

/** The back office (/admin): the overview in the frame, without a rail button of its own. */
export const BACK_OFFICE = {
  name: 'back-office',
  label: 'Back office',
  title: 'Back office',
  icon: 'grid',
  mountPath: CX_BASE,
  rail: false,
  ui: { entry: '/js/operator/back-office.js', styles: ['/css/operator.css'] },
  nav: [{ key: 'overview', label: 'Overview', path: '/', icon: 'grid' }],
};

/** The accelerator pages the rail shows in the frame: `mountPath` is the frame's URL, `src` the accelerator's page. */
export const EMBEDDED_SCREENS = [
  { name: 'customers', label: 'Customers', icon: 'users', mountPath: '/customers', src: `${CX_BASE}/customer/` },
  { name: 'marketing', label: 'Marketing', icon: 'spark', mountPath: '/marketing', src: `${CX_BASE}/marketing/` },
  { name: 'payments', label: 'Payments', icon: 'doc', mountPath: '/payments', src: `${CX_BASE}/payments/` },
];
const SCREEN = Object.fromEntries(EMBEDDED_SCREENS.map((s) => [s.name, s]));

/** A rail app for one embedded screen. Every one carries all of them, so a link inside one can switch the rail. */
function embeddedApp({ name, label, icon, mountPath, src }) {
  const screens = EMBEDDED_SCREENS.map((s) => ({ mountPath: s.mountPath, src: s.src }));
  return { name, label, title: label, icon, mountPath, ui: { entry: '/js/operator/embed.js', styles: ['/css/operator.css'], src, screens }, nav: [] };
}

async function importOptional(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(`'${name}'`)) return null;
    throw err;
  }
}

/**
 * @param {object} o
 * @param {import('express').Express} o.app
 * @param {import('node:events').EventEmitter} o.eventEmitter
 * @param {object} o.serviceRegistry     nooblyjs-core, initialised
 * @param {object} o.infraHost           the host from createHost().hostFor(<dataDir>/infrastructure)
 * @param {object} o.shell               nooblyjs-core's shell (the operator frame and rail)
 * @param {string} o.dataDir
 * @param {object} o.config              loadConfig()
 * @param {object} [o.log]
 * @param {number} [o.mockStepMs]        passed to the infrastructure accelerator (tests pass 0)
 * @param {number} [o.jobCheckMs]
 * @param {(tenantId: string, refs: string[]) => Promise<Record<string, string>>} [o.resolveSecrets]   opens our secretRefs at deploy (infra 8.9 R9)
 * @param {{ now(): number }} [o.payClock]   the payments accelerator's clock (tests move it)
 * @param {boolean} [o.payJobs]           the payments jobs (period close, dunning) on a timer; false in tests
 */
export async function mountAccelerators({ app, eventEmitter, serviceRegistry, infraHost, shell, dataDir, config, log = console, mockStepMs, jobCheckMs, resolveSecrets, payClock, payJobs = true }) {
  // Check before mounting anything.
  if (typeof eventEmitter?.emit !== 'function') throw new Error('mountAccelerators needs the shared EventEmitter.');
  if (!serviceRegistry?.initialized) throw new Error('mountAccelerators needs an initialised serviceRegistry.');
  const missing = INFRA_HOST_NEEDS.filter((key) => !infraHost?.[key]);
  if (missing.length) throw new Error(`The infrastructure host is missing ${missing.join(', ')}; nothing was mounted.`);

  const [customersModule, paymentsModule, infrastructureModule] = await Promise.all([
    import('nooblyjs-accel-customers'),
    importOptional('nooblyjs-accel-payments'),
    import('nooblyjs-accelerator-infrastructure'),
  ]);
  const customers = customersModule.default ?? customersModule;

  const mounted = {};
  const pending = [];
  const closeAll = async () => {
    for (const name of ['infrastructure', 'payments', 'customers']) {
      try {
        await mounted[name]?.shutdown?.();
      } catch (err) {
        log.warn?.(`shutdown of ${name} failed: ${err.message}`);
      }
    }
  };

  try {
    mounted.customers = await customers.mount(app, eventEmitter, serviceRegistry, {
      modules: ['customer', 'marketing'],
      basePath: CX_BASE,
      containerPrefix: 'cx',
      auth: { roleResolver: (req) => req.person?.cxRoles ?? [] },
      seed: !config.production,
      marketing: {
        tracking: { baseUrl: config.publicUrl, signingSecret: config.cxTrackingSecret },
        dispatch: { concurrency: 1 },
      },
    });

    if (paymentsModule) {
      // Billing (roadmap 7.1–7.3; stack.md §3.4): its records in its own file store under DATA_DIR/payments; emails
      // through the customers accelerator; Stripe when its keys are in the environment, else the mock provider.
      mounted.payments = await paymentsModule.mount(app, eventEmitter, serviceRegistry, {
        modules: ['payments', 'billing'],
        basePath: CX_BASE,
        containerPrefix: 'pay',
        express: (await import('express')).default,
        providers: { data: { type: 'file', options: { dataDir: path.join(dataDir, 'payments') } } },
        provider: { type: config.payProvider ?? 'mock' },
        customers: mounted.customers,
        currency: 'USD',
        brand: 'NooblyJS Cloud',
        publicUrl: config.publicUrl,
        billingUrl: (account) => (account.externalRef ? `${config.publicUrl}/w/${account.externalRef}/billing` : null),
        seller: { name: 'NooblyJS Cloud' },
        auth: { roleResolver: (req) => req.person?.payRoles ?? [] },
        jobs: { enabled: payJobs },
        ...(payClock ? { clock: payClock } : {}),
      });
    } else {
      pending.push({ name: 'payments', reason: 'Not built yet: nooblyjs-accel-payments roadmap Phase 0.' });
    }

    const infrastructure = await infrastructureModule.mount(app, eventEmitter, serviceRegistry, {
      mountPath: INFRA_MOUNT,
      dataDir: path.join(dataDir, 'infrastructure'),
      host: infraHost,
      // Platform hosting (the accelerator's phase 8); environment values are opened by us when a container starts.
      // Services answer on <name>.<appDomain> through a region's ingress (roadmap 3.5, 3.7).
      platform: { enabled: true, resolveSecrets, domain: config.appDomain },
      // Cloud pool VMs connect back to this app, and ingress VMs call its wake hook: only over https (roadmap 3.7).
      publicUrl: config.publicUrl?.startsWith('https://') ? config.publicUrl : null,
      // The Local network region (infra spec 8.9): site lan-dev, and in development an agent on this machine.
      local: {
        // Tests take the top of the host port range, so they never meet a development instance on this machine.
        site: { id: 'lan-dev', name: 'Local network', bind: '127.0.0.1', ...(config.localAgent === 'mock' ? { ports: { min: 29000, max: 29999 } } : {}) },
        agent: config.localAgent === 'off' ? null : config.localAgent,
        controller: `http://127.0.0.1:${config.port}`,
        // Postgres for the Local network (roadmap 6.2; infra 8.6): an admin URL from HERO_LOCAL_POSTGRES_URL (never in
        // a file of ours), or a stand-in with the mock agent (tests).
        ...(config.localAgent === 'mock' ? { postgres: { engine: infrastructureModule.createMockPostgres() } } : config.localPostgresUrl ? { postgres: { url: config.localPostgresUrl } } : {}),
      },
      ...(mockStepMs === undefined ? {} : { mockStepMs }),
      ...(jobCheckMs === undefined ? {} : { jobCheckMs }),
    });
    mounted.infrastructure = infrastructure;

    // The rail, in this order, once everything is up.
    shell.add(embeddedApp(SCREEN.customers), { name: 'customers', mountPath: SCREEN.customers.mountPath });
    shell.add(embeddedApp(SCREEN.marketing), { name: 'marketing', mountPath: SCREEN.marketing.mountPath });
    if (mounted.payments) shell.add(embeddedApp(SCREEN.payments), { name: 'payments', mountPath: SCREEN.payments.mountPath });
    else shell.notInstalled({ name: 'payments', mountPath: SCREEN.payments.mountPath }, { name: 'payments', label: SCREEN.payments.label, icon: SCREEN.payments.icon, phase: 0 });
    shell.add({ ...infrastructure, label: 'Infrastructure' }, { name: infrastructure.name, mountPath: INFRA_MOUNT });
  } catch (err) {
    await closeAll();
    throw err;
  }

  return {
    mounted,
    pending,
    /** What the back office shows, in rail order: `href` is the screen in the frame, `links` the accelerator's own pages. */
    describe: () => [
      { name: 'customers', label: 'Customers', state: 'mounted', href: SCREEN.customers.mountPath, links: [SCREEN.customers.src], version: mounted.customers.version },
      { name: 'marketing', label: 'Marketing', state: 'mounted', href: SCREEN.marketing.mountPath, links: [SCREEN.marketing.src], version: mounted.customers.version },
      ...(mounted.payments
        ? [{ name: 'payments', label: 'Payments', state: 'mounted', href: SCREEN.payments.mountPath, links: [SCREEN.payments.src], version: mounted.payments.version }]
        : pending.map((p) => ({ name: p.name, label: 'Payments', state: 'pending', reason: p.reason, href: SCREEN.payments.mountPath, links: [] }))),
      { name: 'infrastructure', label: 'Infrastructure', state: 'mounted', href: INFRA_MOUNT, links: [`${INFRA_MOUNT}/`] },
    ],
    shutdown: closeAll,
  };
}
