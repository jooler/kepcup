# Security Policy

KepCup is a local-first Personal Agent. This policy explains how to report security issues privately and what we support.

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest GitHub Release (currently `v0.5.x`) | Yes |
| Current development branch (`v0.5.2` and successors) | Yes |
| Older releases | Best effort only; please upgrade when a fix ships |

## Reporting a vulnerability

**Do not** open a public GitHub Issue, Discussion, or Pull Request for security vulnerabilities.

Report privately using either channel:

1. **GitHub private vulnerability reporting (preferred)**  
   Open the repository’s [Security and quality](https://github.com/jooler/kepcup/security) tab → **Report a vulnerability**.  
   Direct link: https://github.com/jooler/kepcup/security/advisories/new

2. **Email**  
   Send details to **jerr@outlook.com** with subject prefix `[KepCup Security]`.

Please include as much as you can:

- Affected version (app release or commit) and platform (macOS / Windows / Linux / self-hosted)
- Component (desktop app, host server, connectors, installer, update path, etc.)
- Type of issue and impact (e.g. local data exposure, privilege escalation, remote code execution, auth bypass for a connector)
- Steps to reproduce and a proof of concept if available
- Any special configuration needed to trigger it
- How you would like to be credited (or request anonymity)

## Scope

In scope examples:

- Unauthorized access to local user data, credentials, or vault material
- Sandbox / process isolation bypasses that let a Bot or tool escape intended boundaries
- Remote or local code execution via crafted content, plugins, or updates
- Flaws in self-hosted / headless deploy that expose the service beyond the intended trust boundary
- Supply-chain issues in our release artifacts or update signing verification

Out of scope examples (unless they lead to a clear product vulnerability):

- Social engineering of third-party model / connector providers
- Issues that require physical access plus an already unlocked machine with no additional exploit
- Denial of service that only affects the reporter’s own local instance
- Vulnerabilities solely in upstream dependencies when a fix already exists upstream and we have not yet bumped; please still tell us so we can prioritize the bump

## What to expect

These are targets for a small maintainer team; timing may vary.

| Step | Target |
| ---- | ------ |
| Acknowledgment | Within **3 business days** (Asia/Shanghai) |
| Initial assessment (accept / decline / need more info) | Within **7 business days** |
| Status updates | At least every **14 days** until resolved or declined |
| Fix and advisory | Prioritized by severity; we aim to ship a patched release and a GitHub Security Advisory when we accept a report |

If we decline a report, we will explain why.

## Disclosure

We follow coordinated disclosure:

1. Confirm the issue and affected versions
2. Prepare fixes for supported versions
3. Release the fix and publish a GitHub Security Advisory when appropriate
4. Credit the reporter in the advisory unless they ask to remain anonymous

Please keep the vulnerability confidential until we publish a fix, or until **90 days** after your report, whichever comes first. If you need a different timeline, say so in the report.

## Non-security bugs

For crashes, UX bugs, and feature requests, use [GitHub Issues](https://github.com/jooler/kepcup/issues).
