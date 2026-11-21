# Operator setup: a cloud region (roadmap 3.7)

How an operator opens Johannesburg (`af-south` in hero-co's catalogue, the platform's `af-south-1`: AWS's name, so
the pools live in an AWS account) for customers. Everything below is done in the infrastructure accelerator's screens
at `/infrastructure` (operator sign-in; `ops-platform` in development), except the environment.

Rehearse it on the mock cloud first: in development (`npm run seed`) the seeded `stevie-aws` account is a mock AWS
account, and pool hosts there run an in-process agent, so the whole flow works with no cloud bill.

## 1. Environment

| Variable | Value | Why |
| --- | --- | --- |
| `PUBLIC_URL` | `https://cloud.nooblyjs.app` | Pool hosts' agents connect back here, and ingress VMs call the wake and TLS hooks. Only an `https://` address is passed on. `INFRA_PUBLIC_URL` overrides it for the accelerator alone. |
| `APP_DOMAIN` | `nooblyjs.app` (the default) | Services answer on `<name>.nooblyjs.app`. Passed to the platform as its domain; `INFRA_PLATFORM_DOMAIN` overrides it. |
| `INFRA_PLATFORM_DNS_ZONE` | the Route 53 hosted zone id of `nooblyjs.app` | The wildcard certificate's DNS-01 challenge (infra 8.4.2, still open: it also needs a Caddy built with the DNS module). |

Point `*.nooblyjs.app` (an A record) at the ingress pool's addresses once step 4 has made them.

## 2. Cloud account

**Accounts → Connect account**: AWS keys for the account that hosts the region (infra 2.10; the real adapter waits
for a sandbox account, roadmap 3.6). Check that the account's quota covers the pools' maximum sizes.

## 3. Host pool

**Platform → Host pools → Create pool**:

- Pool name `jnb-hosts`, Runs **Instances (hosts)**, the account, region `af-south-1`.
- Host size **Large** (t3.xlarge, 4 vCPU / 16 GB), Fewest hosts 2, Most hosts 10.

The pool launches its minimum. Each VM boots with Docker and the agent (cloud-init), enrols with a one-time token,
and appears under **Hosts** as Online. A region with no room grows the pool by one host at a time up to max; past max,
a deploy fails with "Johannesburg is full right now" on the customer's service page.

## 4. Builder pool and ingress pool

Two more pools in the same account and region:

- `jnb-builds`, Runs **Builds**, **Large**, fewest 1, most 3. Builds run here (one slot per 1 vCPU / 2 GB, so four on
  a t3.xlarge; 15 minutes each at most) and push to the account's registry (ECR); hosts pull with read-only credentials.
- `jnb-edge`, Runs **Ingress**, **Small** (t3.small), fewest 2, most 2. Each VM has a static address and runs Caddy.
  Hosts accept instance ports 20000–29999 only from these VMs.

The **Ingress · af-south-1** card on the Platform screen then shows the addresses, the last sync to the VMs, and any
custom domains waiting for DNS.

## 5. Check

1. As a customer, create a web service in Johannesburg. It builds on `jnb-builds`, runs on `jnb-hosts`, and answers
   on `https://<name>.nooblyjs.app` through `jnb-edge`.
2. Push to its branch: the webhook deploys it, one instance at a time, with no failed requests.
3. Leave it for 15 minutes: it shows *Sleeping*; open its URL: it wakes and answers.

To take a host out of service, **Drain** it: its instances move to the pool's other hosts, then the VM is deleted.
