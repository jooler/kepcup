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
        imageAlt: 'The KepCup workbench: items assigned to Bots on the left, memos on the right.',
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
    updated: 'Updated 19 October 2026',
    paragraphs: [
      'This page covers the marketing site at kepcup.app. It is a static site. It does not create accounts, and there is nothing to sign in to.',
      'The pages in this repository do not include a first-party analytics script. If the kepcup.app zone later turns on Cloudflare Web Analytics, this page will say so.',
      `Cloudflare serves the files. They process connection data, including IP addresses, to deliver the site. Their policy is the [Cloudflare privacy policy](${links.cloudflarePrivacy}).`,
      `Download buttons go to [GitHub Releases](${links.releases}). GitHub’s own privacy policy applies there. The desktop app is local-first: model calls go to the providers you configure, on terms you accept with those providers. This page is not the full policy for the app. Product behavior is described in the [repository docs](${links.docs}).`,
      'kepcup.com is a different hostname. It hosts OAuth client metadata at kepcup.com/oauth, connector files at dl.kepcup.com, and a registry at registry.kepcup.com. Those services are not this marketing site, and this deployment does not replace them.',
      `Questions: [kepcup-app@kepcup.app](${links.email}).`,
    ],
  },
  terms: {
    title: 'Terms',
    updated: 'Updated 19 October 2026',
    paragraphs: [
      `The KepCup desktop app and this repository are licensed under [GPL-3.0](${links.license}). The text of this website lives in the same repository.`,
      'This site does not offer an account, a subscription, or a hosted team. Downloads are the installers published on GitHub Releases, provided as-is under that license.',
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
