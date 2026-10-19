# @kepcup/website

Official marketing site for KepCup. **Scaffold only — marketing UI is TBD.**

Deploy target: **kepcup.com** via Cloudflare Pages (later). Existing `kepcup.com` routes (`/oauth/*`, `dl.`, `registry.`) must stay intact. `kepcup.app` in the desktop package metadata does not resolve today; treat that as a conflict to fix in DNS, or use the name only as a redirect onto kepcup.com.

## Docs

Approved information architecture and messaging: [docs/official-site-design.md](docs/official-site-design.md).

That plan is the source of truth. In particular:

- OpenMind supplements open source. Open source is the foundation. Never frame OpenMind as replacing open source. OpenMind is not an in-app Bot feature.
- Product contrast uses Grok Bot, Muse / Dot, and Rakazo / OpenDots only. Do not include OpenCode.
- Slogan — EN: *Build a team. Only for you.* ZH: *创建一个团队，只为你服务！*

## Layout

`pnpm-workspace.yaml` already includes `apps/*`, so this package is part of the workspace as `@kepcup/website`. There is no build, dev server, or site UI yet. `public/index.html` is a placeholder stub.
