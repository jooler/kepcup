import { links, oss } from './links';
import type { Copy } from './types';

export const en = {
  locale: 'en',
  htmlLang: 'en',
  ogLocale: 'en_US',
  metaTitle: 'KepCup — Build a team. Only for you.',
  metaDescription:
    'KepCup is an open-source team of Bots that runs on your machine: Bots behave like people, all data stays local, and every model provider is yours to choose. Open source, plus open thinking — OpenMind.',
  nav: {
    skip: 'Skip to content',
    docs: 'Docs',
    github: 'GitHub',
    download: 'Download',
    langName: '中文',
    primary: 'Primary',
  },
  hero: {
    eyebrow: 'Open source · OpenMind · Fully local',
    title: 'Build a team. Only for you.',
    lede: 'KepCup is an open-source desktop app: create a team of Bots on your own machine, and they communicate, work, and report like real teammates — your data never leaves it, and the models are yours to choose.',
    primary: 'Download KepCup',
    secondary: 'View on GitHub',
    note: 'GPL-3.0 · macOS / Windows / Linux · No account',
    imageAlt:
      'The KepCup desktop app: a Bot list on the left, a conversation with the Steward and a running task in the middle, and a Bot profile on the right.',
  },
  loopBand: {
    title: 'Bots behave like people',
    body: 'Hand a task to a human teammate: they reply “Got it, on it”, then do the work, then come back and report. KepCup splits that into two independent loops — one talks, one works.',
    points: [
      { title: 'Reply loop', body: 'Second-level responses; read-only, for talking and dispatching.' },
      { title: 'Task loop', body: 'Real execution; tools and files stay inside the task, and tasks run in parallel.' },
      { title: 'The settle', body: 'Results return to the conversation, delivered by the Bot.' },
    ],
    caption:
      'Context is injected on demand — only the newest messages and the few most relevant ones. Conversations can grow forever.',
    imageAlt:
      'A KepCup conversation: the Bot replies first, dispatches a task, and reports the result back into the conversation.',
  },
  crew: {
    title: 'A team, each in its role',
    lede: 'Create Bots, give them permissions and a working directory; project teams collaborate, the workbench oversees.',
    cards: [
      {
        title: 'Project teams, not group chat',
        body: 'A lead who routes, a shared wiki, a circuit breaker — Bots hand work to each other around a goal.',
        image: 'team',
        imageAlt:
          'The KepCup project page: project goal, lead and member permissions, the working directory, and scheduled tasks.',
      },
      {
        title: 'Workbench',
        body: 'Items dispatch on schedule with delivery tracked; memos stay fleeting until you promote one.',
        image: 'bench',
        imageAlt: 'The KepCup workbench: memos on the left, items assigned to Bots on the right.',
      },
      {
        title: 'Memory and wiki',
        body: 'A Bot remembers who you are and what it promised; its wiki is its brain — docs, audio, and video all belong in it.',
        image: 'wiki',
        imageAlt: 'A KepCup Bot’s wiki tab: the knowledge base the Bot maintains itself.',
      },
      {
        title: 'Connections and extensions',
        body: 'Connect Notion, Linear, Cloudflare, and friends; skills, MCP, and mail on demand.',
        image: 'extensions',
        imageAlt: 'The Extension Center’s connections tab: one-click app authorization for Bots.',
      },
    ],
  },
  localBand: {
    title: 'Fully local. Your models.',
    body: 'Conversations, memory, wikis, and skills live in an encrypted database on your machine; model calls go straight to the providers you configured. KepCup never sees or stores them.',
    points: [
      { title: 'Any provider', body: 'OpenAI-compatible, Ollama, Chinese vendors; every Bot can override.' },
      { title: 'Subscriptions work', body: 'Claude Code, Codex, and friends join over ACP; credentials never touch KepCup.' },
      { title: 'You draw the lines', body: 'Sandboxed execution, per-path approval, dangerous commands blocked by default.' },
    ],
    chips: ['OpenAI-compatible', 'Ollama', 'Alibaba Bailian', 'Volcano Ark', 'Claude Code', 'Codex', 'Cursor', 'MCP', 'ACP'],
  },
  openMind: {
    kicker: 'OpenMind',
    title: 'Open thinking, not just open code',
    paragraphs: [
      `In the AI era, code can be rebuilt; thinking is hard to copy. KepCup publishes [40+ design documents and 92 numbered decision records](${links.docs}) next to the GPL-3.0 code — readable, quotable, rebuildable.`,
      'OpenMind supplements open source; it does not replace it — open source is the foundation, OpenMind is the thinking opened on top of it.',
    ],
    cta: 'Read the design docs',
  },
  download: {
    title: 'Download KepCup',
    lede: 'Installers are published on GitHub Releases. Install and go; the app updates itself.',
    platforms: [
      { name: 'macOS', sub: 'Apple Silicon · Intel', href: links.releases },
      { name: 'Windows', sub: 'x64 · arm64', href: links.releases },
      { name: 'Linux', sub: 'AppImage · deb', href: links.releases },
    ],
    more: { name: 'Source and license', sub: 'GPL-3.0 · GitHub', href: links.github },
  },
  faq: {
    title: 'FAQs',
    items: [
      {
        q: 'Is KepCup a cloud service?',
        a: 'No. A desktop app whose core service runs locally — close the window and the Bots keep working. None of our servers take part, and there is no account.',
      },
      {
        q: 'Is my data uploaded anywhere?',
        a: 'No. Everything lives in an encrypted database under ~/.kepcup/, with the master key in the system keychain. Model calls go straight to the providers you configured.',
      },
      {
        q: 'Which models can I use?',
        a: 'Any OpenAI-compatible endpoint, Ollama local models, or Chinese vendors — with multimodal capabilities configurable per vendor. KepCup is free; model usage is billed by your provider.',
      },
      {
        q: 'How is this different from Grok Bot or Muse?',
        a: 'It is the local-first take on the same job: they host the team in their cloud, KepCup runs it on your machine. An independent implementation — inspiration credited in the footer.',
      },
      {
        q: 'Can a Bot mess with my computer?',
        a: 'Not by default: commands run in a sandbox, file access is granted per path, dangerous commands are blocked, and approvals can be revoked anytime.',
      },
    ],
  },
  cta: {
    title: 'Meet your first Bot',
    lede: 'The Steward walks you through building the initial team.',
    primary: 'Download free',
    secondary: 'Read the docs',
  },
  thanks: {
    body: `Thanks to [Grok Bot](https://x.ai/bot) (xAI / Cursor product line) for product inspiration — KepCup is an independent implementation, not an official derivative or affiliate; ideas were also informed by [Rakazo](${links.rakazo}), [OpenMuse](${links.openmuse}), and [OpenDots](${links.opendots}). Marks and names belong to their owners.`,
    ossNote: 'Open-source dependencies:',
    names: oss,
  },
  footer: {
    product: 'Resources',
    community: 'Community',
    legal: 'Legal',
    docs: 'Docs',
    releases: 'Releases',
    source: 'Source',
    issues: 'Issues',
    discussions: 'Discussions',
    privacy: 'Privacy',
    terms: 'Terms',
    license: 'GPL-3.0',
    rights: '© 2026 kepcup-app',
    navLabel: 'Footer',
  },
  privacy: {
    title: 'Privacy',
    updated: 'Updated 27 November 2026',
    paragraphs: [
      'This is the privacy policy for KepCup — the website (kepcup.app, also served at kepcup.com) and the KepCup desktop app. The short version: the app runs on your machine, your conversations stay there, model calls go to the providers you configure, and the only data the app sends to KepCup is a report you explicitly submit with the thumbs-down reaction, described under “AI content reports” below.',
      'The website is a static site. It does not create accounts, and there is nothing to sign in to. These pages contain no first-party analytics script. Cloudflare serves the files and processes connection data, including IP addresses, to deliver the site; their policy is the [Cloudflare privacy policy](' +
        links.cloudflarePrivacy +
        ').',
      'Desktop app data stays on your machine. Conversations, Bot profiles, memories, wikis, skills, and settings live in an encrypted database under ~/.kepcup/, with the master key in your system keychain. Local emoji reactions on messages and the local queue of pending reports are kept in that same encrypted database. There is no KepCup account; clearing the app’s data on your machine deletes these local copies.',
      `Model calls go directly from the app to the AI providers you configure; API keys are stored locally, encrypted, and KepCup never sees or stores that traffic. What those providers receive, and their own privacy practices, are governed by the terms you accept with them. Product behavior is described in the [repository docs](${links.docs}).`,
      `The app sends no crash reports, usage statistics, or analytics. It does check for new versions: an update check is an ordinary download of a small manifest from [GitHub Releases](${links.releases}) or our read-only mirrors (updates.kepcup.com and an Aliyun OSS mirror), which involves the standard connection data — such as your IP address — that any download involves.`,
      'AI content reports. Bot messages in the app can be reacted to with emoji. Every reaction except the thumbs-down is stored only on your machine and is never uploaded or synced. The thumbs-down on a Bot message is a report of inappropriate AI-generated content: clicking it queues the report on your machine, and the app then sends it, in the background, to https://reports.kepcup.com — a reporting endpoint operated by KepCup on Cloudflare. Clicking the thumbs-down is itself your consent to send that one report; messages you do not report are never sent, and no separate confirmation dialog is shown. Reports are sent at most one per minute, and identical repeat reports from the same installation are discarded automatically within deduplication windows.',
      'What a report contains: the reported message’s text (or card JSON), up to four preceding messages and the quoted message it replies to, the Bot’s name and a trimmed persona profile (at most 8 KB), the Bot’s model configuration and the provider, model, and token usage actually used to produce the reply, the names and call counts of tools it used (not their output), attachment metadata (file name, type, and size — never the files themselves), and the app version, platform, and language.',
      'What a report never contains: API keys or other credentials (known API keys found in text are replaced with [REDACTED] before sending), full system prompts, full tool outputs, memory entries, attachment contents, or your team server’s address. All text is cleaned and truncated to fixed size limits before it leaves the app, and a report is capped at 128 KB in total.',
      'How reports are used: to evaluate and improve the safety of AI-generated content in KepCup — for example prompt, filter, or model adjustments — and to operate the reporting channel required by Microsoft Store policy 11.16, including taking appropriate action on what is reported. Reports are not used for advertising and are not shared with third parties; Cloudflare handles the data as our infrastructure provider.',
      'Storage and retention: reports are stored in a Cloudflare D1 database with encryption at rest, and each report is deleted automatically 365 days after it was received by a daily cleanup job. The server never stores your raw IP address — it keeps only an HMAC-SHA256 hash of it, used solely for rate limiting. Server logs contain report identifiers and statuses, not message content, client identifiers, or IP addresses.',
      `Deleting reports: ask us, or clear your local data. Email [kepcup-app@kepcup.app](${links.email}) to request deletion, and we remove every report tied to your installation’s client identifier. Clearing the app’s data on your machine immediately deletes your local copies (the pending queue and reactions); the server-side copy can only be removed via the email request.`,
      'Team-hosted conversations: if you report a message from a conversation hosted on a self-hosted KepCup team server, the report is forwarded by that team server software to the same reporting endpoint, and the source is recorded only as a one-way hash of the server — never its address.',
      `Downloads offered on this site go to [GitHub Releases](${links.releases}); GitHub’s own privacy policy applies there.`,
      'kepcup.com is a different hostname. It hosts OAuth client metadata at kepcup.com/oauth, connector files at dl.kepcup.com, a plugin registry at registry.kepcup.com, and the reporting endpoint at reports.kepcup.com. Those services are not this marketing site.',
      `Questions, privacy requests, or report-deletion requests: [kepcup-app@kepcup.app](${links.email}) or [GitHub issues](${links.issues}).`,
    ],
  },
  terms: {
    title: 'Terms',
    updated: 'Updated 27 November 2026',
    paragraphs: [
      `The KepCup desktop app and this repository are licensed under [GPL-3.0](${links.license}). The text of this website lives in the same repository.`,
      'This site does not offer an account, a subscription, or a hosted team. Downloads are the installers published on GitHub Releases, provided as-is under that license.',
      'AI-generated content. The app produces dynamic content with live generative AI models in response to your inputs. Such content may be inaccurate, incomplete, or inappropriate, and it does not represent the views of KepCup; verify it before relying on it. Your use of generated content must also comply with the terms of the model providers you configure.',
      'Reporting inappropriate content. Bot messages carry a thumbs-down reaction that reports inappropriate AI-generated content to the developer (the message context menu has a report item as well). We review reported content and take appropriate action on it — for example prompt, filter, or model adjustments — as required by Microsoft Store policy 11.16.',
      'Consent to report. Clicking the thumbs-down is an explicit instruction to send that one report to the developer as described in the [Privacy Policy](/privacy/): by clicking it, you consent to that submission. Nothing is sent until you click, and reactions other than the thumbs-down stay on your machine.',
      'Names of other products on this site belong to their owners. Mention is not endorsement, sponsorship, or affiliation.',
      `Questions: [kepcup-app@kepcup.app](${links.email}).`,
    ],
  },
  notFound: {
    title: 'Page not found',
    body: 'That address is not on kepcup.app.',
    home: 'Back to KepCup',
  },
} satisfies Copy;
