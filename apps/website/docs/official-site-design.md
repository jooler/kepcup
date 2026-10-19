# KepCup Official Website Design Plan

Status: Approved direction by Pengfei (2026-10-19). The marketing UI in this package implements the v1 information architecture below.

Public site: **https://kepcup.app** (Cloudflare Workers static assets, Worker name `kepcup-website`).

## Goals

- Light marketing single-page site (EN default + Chinese at `/zh/`), hosted on **kepcup.app**.
- Primary conversion: **Download + GitHub**.
- Narrative aligned with root README; OpenMind emphasized as messaging layer, **not** an in-app Bot feature.
- Local-first, open-source + OpenMind, BYO models — not a cloud-subscription funnel like hosted teammates.

## OpenMind (messaging, not product module)

- OpenMind does **not** replace open source. **Open source is the foundation** (code).
- OpenMind is the **necessary AI-era supplement**: open the *thinking* (product intent, hard problems, how modules fit) so others can rebuild or fold the design into their own products with coding models/agents.
- Public line: **open source + open mind** — never “OpenMind instead of open source”.
- Must **not** be framed as related to in-app Bots or any Bot capability.

## Product contrast (allowed peers only)

Include: Grok Bot, Muse / Dot, Rakazo / OpenDots (personal/team Bot assistants).

**Do not** include OpenCode in product comparison tables or copy.

| Peer | They emphasize | KepCup emphasizes |
|------|----------------|-------------------|
| Grok Bot | Cloud computer, 24/7, subscription | Local run, data on your machine, BYO model, auth/sandbox you control |
| Muse / Dot | Hosted “ask and done” | Teammate feel + **project teams that get work done** (not social chat) |
| Rakazo / OpenDots | Self-hosted Grok-like, container computers | Desktop local-first, Steward onboarding, Workbench, OpenMind narrative |

## Slogan

- EN: *Build a team. Only for you.*
- ZH: *创建一个团队，只为你服务！*

## Domain & infra

- Public marketing site: **kepcup.app**, confirmed purchased and on Cloudflare (2026-10-19). Prefer kepcup.app over kepcup.com for the public site.
- Apex is a Workers static-asset deploy (`apps/website/wrangler.jsonc`), not a Cloudflare Pages project. `workers.dev` is disabled.
- **kepcup.com stays the OAuth / download / registry host.** Do not move or replace `/oauth/*`, `dl.kepcup.com`, or `registry.kepcup.com`. Those Workers live under `infra/cloudflare/` and assume the kepcup.com zone. Desktop package metadata may already say `kepcup.app`; this site does not retarget those other packages.
- `www.kepcup.app` is not a second site. Redirect it to the apex with a zone rule if you want both names.

## Information architecture (v1)

1. Nav — Logo, Docs, GitHub, Download, EN/中文
2. Hero — Slogan + one-line what (local multi-Bot / OpenMind); CTA Download + GitHub
3. Product shots — three-column chat / project team board / workbench (placeholders until real screenshots exist)
4. OpenMind — open source foundation + open thinking supplement; link to “looking for”
5. Why local — honest contrast to hosted teammates (no disparagement)
6. Dual loop + one conversation infinite history
7. Project teams — three core roles; boards/OKRs/planning still roadmap
8. Capability grid — 12 items from the Done roadmap
9. Trust — auth, sandbox, unattended, allowlist; honest that auth nagging is an open OpenMind question
10. Download — platform matrix; signing / SmartScreen notes; GitHub Releases `jooler/kepcup`
11. Looking for OpenMind — four questions → Issues/Discussions
12. Thanks — text thanks to Grok Bot; OSS name matrix (no unauthorized logos)
13. Footer — GPL-3.0, Privacy, Terms, language, GitHub

Also in v1: `/privacy` and `/terms` (and `/zh/privacy`, `/zh/terms`). A separate `/download` page is not required; Download jumps to the section and then to GitHub Releases.

## Visual

- Existing: bubble SVG (`#37005C`), sidebar light/dark icons, copied into `public/brand/`.
- Missing: horizontal wordmark (the site sets the name in text next to the glyph), marketing screenshots (CSS placeholders until then).
- OG image: `public/brand/og.png` (generated card, not a third-party logo).
- Do **not** place unauthorized Grok Bot logos.
- Site uses brand purple as accent. Flat and editorial, not a Grok Bot skin clone. Product UI stays neutral/flat (D46).

## Tech

- Astro static output (`output: 'static'`), no Cloudflare adapter, no server routes.
- EN at `/`, Chinese at `/zh/` (Astro i18n, default locale not prefixed).
- No analytics snippet in v1. No CMS. No accounts.
- Deploy notes: [../README.md](../README.md).

## Open decisions (for Pengfei)

1. **Decided:** public site is kepcup.app. kepcup.com remains oauth / dl / registry.
2. Same-day public GitHub + site?
3. **Decided for v1:** Download + GitHub, not a waitlist.
4. Desktop EN i18n milestone vs site-first EN — the site ships EN + zh; the desktop app is unchanged.
5. Community: GitHub only vs Discord/WeChat — v1 links Issues and Discussions only.
6. **Decided:** Pengfei deploys from a credentialed machine after this package is ready. The agent does not deploy.
