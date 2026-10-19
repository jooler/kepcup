import { links, oss } from './links';
import type { Copy } from './types';

export const en = {
  locale: 'en',
  htmlLang: 'en',
  ogLocale: 'en_US',
  metaTitle: 'KepCup — Build a team. Only for you.',
  metaDescription:
    'KepCup is a local-first multi-Bot assistant. Open source is the foundation. OpenMind supplements it by opening the thinking. Your data stays on your machine.',
  nav: {
    skip: 'Skip to content',
    docs: 'Docs',
    github: 'GitHub',
    download: 'Download',
    langName: '中文',
    onThisPage: 'On this page',
    primary: 'Primary',
  },
  toc: [
    { href: '#product', label: 'Product' },
    { href: '#openmind', label: 'OpenMind' },
    { href: '#why-local', label: 'Why local' },
    { href: '#dual-loop', label: 'Dual loop' },
    { href: '#teams', label: 'Project teams' },
    { href: '#capabilities', label: 'Capabilities' },
    { href: '#trust', label: 'Trust' },
    { href: '#download', label: 'Download' },
    { href: '#looking-for', label: 'Looking for' },
    { href: '#thanks', label: 'Thanks' },
  ],
  hero: {
    eyebrow: 'Local-first multi-Bot · Open source + OpenMind',
    slogan: 'Build a team. Only for you.',
    imageAlt: 'The KepCup desktop app',
    lede: 'KepCup is a desktop app where you create Bots on your machine, give them permissions and a working directory, and they collaborate with you — and with each other — without shipping your data to a host you do not control.',
    download: 'Download',
    github: 'View on GitHub',
    note: 'GPL-3.0 · Bring your own model · A Steward walks you through the first setup.',
  },
  shots: {
    id: 'product',
    title: 'Where the work sits',
    lede: 'Three surfaces. Here is how each one looks.',
    items: [
      {
        key: 'chat',
        title: 'Conversation',
        body: 'A three-column chat: your Bots, the thread, and the work beside it.',
      },
      {
        key: 'team',
        title: 'Project team',
        body: 'A shared board for a team that ships work. Not a group chat.',
      },
      {
        key: 'bench',
        title: 'Workbench',
        body: 'Items you hand to Bots, and memos that stay fleeting notes.',
      },
    ],
  },
  openMind: {
    id: 'openmind',
    title: 'Open source, and an open mind',
    paragraphs: [
      'KepCup is an OpenMind product. Open source is the foundation: the code is GPL-3.0, free to use and free to read. OpenMind is the necessary supplement in the AI era. It opens the thinking — product intent, the hard problems, and how the modules fit — so someone else can rebuild these ideas, or fold them into their own product, with coding models and agents.',
      'OpenMind supplements open source. OpenMind does not replace open source. The public line is open source + open mind.',
      'OpenMind is not an in-app Bot, and it is not a capability you turn on inside a conversation. The Steward that helps you set up the first Bots is a Bot. OpenMind is the decision to publish the thinking next to the code.',
      `The writing lives in the [repository docs](${links.docs}). Much of the design notes are in Chinese today.`,
    ],
    linkLabel: 'Where we are looking for your OpenMind',
  },
  why: {
    id: 'why-local',
    title: 'Why local',
    lede: 'Hosted teammate products are a real category. KepCup is the local-first take on the same job: a team that works for you, with the computer and the data staying yours. This is a contrast of emphasis, not a dismissal.',
    caption: 'What each product emphasizes. KepCup is an independent implementation.',
    colPeer: 'Peer',
    colThem: 'Their emphasis',
    colUs: 'KepCup’s emphasis',
    rows: [
      {
        peer: 'Grok Bot',
        them: 'Cloud computer, always on, subscription.',
        us: 'Runs on your machine. Data stays local. Bring your own model. Auth and sandbox are yours to set.',
      },
      {
        peer: 'Muse / Dot',
        them: 'Hosted “ask and done”.',
        us: 'A teammate feel, plus project teams that get work done — not a social chat.',
      },
      {
        peer: 'Rakazo / OpenDots',
        them: 'Self-hosted, in the Grok Bot direction, with container computers.',
        us: 'A desktop app: Steward onboarding, a Workbench, and an OpenMind narrative beside the code.',
      },
    ],
  },
  dual: {
    id: 'dual-loop',
    title: 'Dual loop',
    lede: 'A Bot’s dual loop mirrors how people work. The message list is what you agreed to remember. The reply does not drag the whole raw transcript in as its working context. The task keeps its own tools and files.',
    steps: [
      {
        title: 'Message list',
        body: 'A long-term, distilled board — the conversation you and the Bot meant to keep.',
      },
      {
        title: 'Reply loop',
        body: 'Each user message starts an independent reply. It does not stack cumulative raw history as its context.',
      },
      {
        title: 'Task loop',
        body: 'Tool use, files, and intermediate state stay inside that task, then settle back to the board.',
      },
    ],
    historyTitle: 'One conversation, infinite history',
    historyBody:
      'The UI keeps a thin history board. The dual loop injects only the context that turn needs, so a conversation can grow without every reply replaying the entire transcript.',
  },
  teams: {
    id: 'teams',
    title: 'Project teams, not group chat',
    lede: 'A project team is not a room where Bots chat. It has three cores, and the point is shipping work.',
    roles: [
      {
        title: 'Centralized communication',
        body: 'You and the Bots in one place.',
      },
      {
        title: 'Plans and collaboration',
        body: 'Who owns what, and how work moves.',
      },
      {
        title: 'Shared knowledge and delivery',
        body: 'A shared wiki, and getting the work done.',
      },
    ],
    roadmap:
      'Shared message board and project wiki are in. Board, OKR, and date planning are still on the roadmap.',
  },
  capabilities: {
    id: 'capabilities',
    title: 'What is already in the app',
    lede: 'A short map of the desktop app as it stands. Items still on the roadmap are called out above, not hidden in this grid.',
    items: [
      {
        title: 'Dual-loop core',
        body: 'Distilled board, independent reply, separate task loop.',
      },
      {
        title: 'Bots that talk',
        body: 'Conversation logic, including how Bots communicate with each other.',
      },
      {
        title: 'Bot details',
        body: 'Config, memory, skills, wiki, and schedules on each Bot.',
      },
      {
        title: 'Your models',
        body: 'Provider configuration, and multimodal input and output.',
      },
      {
        title: 'Web and browser',
        body: 'Web access, and a browser a Bot can use.',
      },
      {
        title: 'Mic and camera',
        body: 'Hardware sensor path for microphone and camera, with permission.',
      },
      {
        title: 'Other agents',
        body: 'Connect third-party coding agents through ACP when you install them.',
      },
      {
        title: 'Extension Center',
        body: 'Skills, connections, MCP, and mail — used when a Bot needs them.',
      },
      {
        title: 'Bounds',
        body: 'Auth, sandbox, unattended mode, and a command allowlist.',
      },
      {
        title: 'Schedules',
        body: 'One-shot and recurring.',
      },
      {
        title: 'Workbench',
        body: 'Items you assign to Bots, and memos for fleeting notes.',
      },
      {
        title: 'Project teams',
        body: 'Shared communication and a project wiki. Board and OKR are still ahead.',
      },
    ],
  },
  trust: {
    id: 'trust',
    title: 'You set the bounds',
    lede: 'Local-first only matters if the Bot cannot quietly outrun the permissions you gave it.',
    items: [
      {
        title: 'Auth',
        body: 'A Bot asks before it crosses a line you have not granted.',
      },
      {
        title: 'Sandbox',
        body: 'Commands run in a sandbox you control.',
      },
      {
        title: 'Unattended',
        body: 'When you allow it, a Bot can continue without you sitting beside it.',
      },
      {
        title: 'Allowlist',
        body: 'Dangerous commands stay blocked by default.',
      },
    ],
    note: 'Mid-run permission prompts still interrupt too often. That is an open OpenMind question: fewer interruptions, while dangerous commands stay blocked by default. If you have a better design, it belongs in the discussion below.',
  },
  download: {
    id: 'download',
    title: 'Download',
    lede: 'Installers are published on GitHub Releases for jooler/kepcup. After you install, the app can check for updates itself. There is no account to create on this website.',
    platforms: [
      {
        title: 'macOS',
        body: 'Disk images for Apple Silicon and Intel. Release builds are signed and notarized when the Apple credentials are configured. An unsigned build is stopped by Gatekeeper, and automatic update needs a signed app.',
      },
      {
        title: 'Windows',
        body: 'One NSIS installer for x64 and arm64. Without a code-signing certificate, SmartScreen warns on first launch (“Windows protected your PC”) — More info, then Run anyway. Microsoft Store builds, when they are published, are signed by the store.',
      },
      {
        title: 'Linux',
        body: 'AppImage and deb for x64 and arm64. AppImage updates in place. The deb updater asks for a password through pkexec.',
      },
    ],
    cta: 'GitHub Releases',
    source: 'Source on GitHub',
    license: 'GPL-3.0',
  },
  looking: {
    id: 'looking-for',
    title: 'We are looking for your OpenMind',
    lede: 'Open an issue, a discussion, or a pull request — especially on these four. This is the OpenMind ask. It is not a feature request form inside the app.',
    items: [
      {
        title: 'Better authorization',
        body: 'Mid-run prompts interrupt too often. We want less interruption while still blocking dangerous commands by default.',
      },
      {
        title: 'Multimodal vendor APIs',
        body: 'Providers disagree. We want one layer in front of them.',
      },
      {
        title: 'Project teams',
        body: 'Beyond board, OKR, and planning — what else should a team have?',
      },
      {
        title: 'Workbench',
        body: 'It should surface work in one place and cut the load of remembering which Bot or team. What is missing?',
      },
    ],
    issue: 'Open an issue',
    discussion: 'Start a discussion',
  },
  thanks: {
    id: 'thanks',
    title: 'Thanks',
    disclaimer:
      'KepCup stands on open-source projects and on product ideas we learned from. This note does not imply endorsement or affiliation. Marks and names belong to their owners.',
    grok: 'Thanks to Grok Bot (xAI / Cursor product line) for product inspiration — conversational Bots, a three-column layout, and a flat UI. KepCup is an independent implementation, not an official derivative or affiliate.',
    peers: `Ideas were also informed by [Rakazo](${links.rakazo}), [OpenMuse](${links.openmuse}), and [OpenDots](${links.opendots}). They are not runtime dependencies of this repository.`,
    ossTitle: 'Open-source dependencies',
    ossNote:
      'Names and upstream links only. No third-party logos on this site. The repository README keeps the longer tier list.',
    names: oss,
  },
  footer: {
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
