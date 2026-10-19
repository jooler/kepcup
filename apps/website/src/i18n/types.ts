export interface Named {
  title: string;
  body: string;
}

export interface Shot {
  key: 'chat' | 'team' | 'bench';
  title: string;
  body: string;
}

export interface CompareRow {
  peer: string;
  them: string;
  us: string;
}

export interface OssLink {
  name: string;
  href: string;
}

export interface Copy {
  locale: 'en' | 'zh';
  htmlLang: 'en' | 'zh-CN';
  ogLocale: 'en_US' | 'zh_CN';
  metaTitle: string;
  metaDescription: string;
  nav: {
    skip: string;
    docs: string;
    github: string;
    download: string;
    langName: string;
    onThisPage: string;
    primary: string;
  };
  toc: { href: string; label: string }[];
  hero: {
    eyebrow: string;
    slogan: string;
    imageAlt: string;
    lede: string;
    download: string;
    github: string;
    note: string;
  };
  shots: {
    id: string;
    title: string;
    lede: string;
    items: readonly Shot[];
  };
  openMind: {
    id: string;
    title: string;
    paragraphs: readonly string[];
    linkLabel: string;
  };
  why: {
    id: string;
    title: string;
    lede: string;
    caption: string;
    colPeer: string;
    colThem: string;
    colUs: string;
    rows: readonly CompareRow[];
  };
  dual: {
    id: string;
    title: string;
    lede: string;
    steps: readonly Named[];
    historyTitle: string;
    historyBody: string;
  };
  teams: {
    id: string;
    title: string;
    lede: string;
    roles: readonly Named[];
    roadmap: string;
  };
  capabilities: {
    id: string;
    title: string;
    lede: string;
    items: readonly Named[];
  };
  trust: {
    id: string;
    title: string;
    lede: string;
    items: readonly Named[];
    note: string;
  };
  download: {
    id: string;
    title: string;
    lede: string;
    platforms: readonly Named[];
    cta: string;
    source: string;
    license: string;
  };
  looking: {
    id: string;
    title: string;
    lede: string;
    items: readonly Named[];
    issue: string;
    discussion: string;
  };
  thanks: {
    id: string;
    title: string;
    disclaimer: string;
    grok: string;
    peers: string;
    ossTitle: string;
    ossNote: string;
    names: readonly OssLink[];
  };
  footer: {
    privacy: string;
    terms: string;
    license: string;
    rights: string;
    navLabel: string;
  };
  privacy: {
    title: string;
    updated: string;
    paragraphs: readonly string[];
  };
  terms: {
    title: string;
    updated: string;
    paragraphs: readonly string[];
  };
  notFound: {
    title: string;
    body: string;
    home: string;
  };
}
