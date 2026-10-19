# @kepcup/website

Official marketing site for KepCup. English is the default (`/`). Chinese is at `/zh/`.

**Deploy target: [kepcup.app](https://kepcup.app)** on Cloudflare Workers static assets. This package does not deploy to kepcup.com.

`kepcup.com` still hosts the existing OAuth client metadata (`/oauth/*`), `dl.kepcup.com`, and `registry.kepcup.com`. Those Workers stay as they are. Do not attach `kepcup-website` to the kepcup.com zone.

## Docs

Information architecture and messaging: [docs/official-site-design.md](docs/official-site-design.md).

Constraints that have to stay true in the copy:

- OpenMind supplements open source. Open source is the foundation. Never frame OpenMind as replacing open source. OpenMind is not an in-app Bot feature.
- Product contrast uses Grok Bot, Muse / Dot, and Rakazo / OpenDots only. Do not include OpenCode.
- Slogan — EN: *Build a team. Only for you.* ZH: *创建一个团队，只为你服务！*

`pnpm --filter @kepcup/website build` runs `scripts/check-messaging.mjs` first and fails if those lines disappear.

## Develop

From the repository root (Node.js ≥ 22.19, pnpm 11.22.0). Astro is pinned to 7.3.8 because 7.4 requires Node ≥ 22.22, which is above this repo’s engine range.

```bash
pnpm install
pnpm --filter @kepcup/website dev
```

The dev server prints a local URL. `pnpm --filter @kepcup/website preview` serves the production build.

There is no CMS and no account system.

## Build

```bash
pnpm --filter @kepcup/website build
```

Static files land in `apps/website/dist/`. Astro emits a directory per page (`zh/index.html`, `privacy/index.html`). Wrangler is set to `html_handling: auto-trailing-slash`, so `/zh` redirects to `/zh/`.

## Deploy to kepcup.app

Pengfei deploys from a machine that already has Cloudflare credentials for the account that owns **kepcup.app**. This repository does not deploy the site on its own.

Worker name: `kepcup-website`. Config: `wrangler.jsonc`.

```bash
pnpm --filter @kepcup/website deploy
```

That builds, then runs `wrangler deploy`. The route is a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on `kepcup.app`. The first deploy creates or updates the DNS record on that zone. `workers.dev` and preview URLs are off, so the site is not also published on a `*.workers.dev` hostname.

Check the package without publishing:

```bash
pnpm --filter @kepcup/website deploy:dry-run
```

A dry run needs the same API credentials as a real deploy. It uploads nothing.

Token: use the account that can see the **kepcup.app** zone. The recipe in [infra/cloudflare/README.md](../../infra/cloudflare/README.md) was written for kepcup.com (`oauth-cimd`, `directory`, `registry`). Reuse that flow, and include kepcup.app in the token’s zone resources. Useful permissions: Account / Workers Scripts Edit, Account Settings Read, Zone / Read, Zone / DNS Edit, Zone / Workers Routes Edit. Run Wrangler through `infra/cloudflare/with-env.sh` if the shell already has a token for a different zone — that script clears `CLOUDFLARE_*` and reads the repo `.env`.

`www.kepcup.app` is not attached. A custom domain matches one hostname. To send `www` to the apex, add a proxied DNS record for `www` and a [redirect rule](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#redirect-between-www-and-root-domain) in the kepcup.app zone. Do not point `www` at a second copy of the site.

Docs in the nav point at the `v0.1.1` tree on GitHub (`jooler/kepcup`). Change `src/i18n/links.ts` when the public default branch carries the same docs.

GitHub Discussions should be enabled on the repository. The “looking for OpenMind” section links there.
