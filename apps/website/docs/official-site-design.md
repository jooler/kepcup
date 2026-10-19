# KepCup Official Website Design Plan

Status: Approved direction by Pengfei (2026-10-19). Implementation of the marketing UI may follow; this document is the source of truth for IA and messaging.

## Goals

- Light marketing single-page site (EN default + Chinese switch), hosted on **kepcup.com**.
- Primary conversion: **Download + GitHub** (adjust to Waitlist if repo still private).
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

- Prefer unify brand on **kepcup.com** (oauth / dl. / registry. already there). `kepcup.app` in README currently does not resolve — either fix DNS or use as redirect only.
- Apex: Cloudflare Pages (or Workers Assets). Do **not** break `/oauth/*`, `dl.`, `registry.`.

## Information architecture (v1)

1. Nav — Logo, Docs, GitHub, Download, EN/中文  
2. Hero — Slogan + one-line what (local multi-Bot / OpenMind); CTA Download + GitHub  
3. Product shots — three-column chat / project team board / workbench (new screenshots needed)  
4. OpenMind — open source foundation + open thinking supplement; link to “looking for”  
5. Why local — honest contrast to hosted teammates (no disparagement)  
6. Dual loop + one conversation infinite history  
7. Project teams — three core roles; boards/OKRs/planning still roadmap  
8. Capability grid — 8–12 items from Done roadmap  
9. Trust — auth, sandbox, unattended, allowlist; honest that auth nagging is an open OpenMind question  
10. Download — platform matrix; signing / SmartScreen notes; GitHub Releases  
11. Looking for OpenMind — four questions → Issues/Discussions  
12. Thanks — text thanks to Grok Bot; OSS name matrix (no unauthorized logos)  
13. Footer — GPL-3.0, Privacy, Terms, language, GitHub  

Phase-2 pages: `/download`, `/privacy`, `/terms` (privacy recommended in v1 — OAuth already references it).

## Visual

- Existing: bubble SVG (`#37005C`), sidebar light/dark icons.  
- Missing: horizontal wordmark, OG image, marketing screenshots.  
- Do **not** place unauthorized Grok Bot logos.  
- Site may use brand purple as accent; product UI stays neutral/flat (D46). Avoid looking like a Grok Bot skin clone.

## Tech suggestions (not mandatory for scaffold)

- Cloudflare Pages + Astro (or SvelteKit static) + EN default / zh-CN.  
- Analytics: Cloudflare Web Analytics.  
- No heavy CMS / account system in v1.

## Open decisions (for Pengfei)

1. Confirm kepcup.com vs kepcup.app  
2. Same-day public GitHub + site?  
3. Download vs Waitlist CTA  
4. Desktop EN i18n milestone vs site-first EN  
5. Community: GitHub only vs Discord/WeChat  
6. Who implements Pages deploy

## Scaffold expectations for this package

- `apps/<site-package>/` monorepo package (name chosen to match repo conventions, e.g. `website` or `site`).  
- `docs/` under that package holding this design plan (and short README pointing to it).  
- Minimal package scaffolding so the workspace knows the package exists; full marketing UI can come later unless already trivial.
