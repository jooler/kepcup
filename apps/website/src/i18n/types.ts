export interface FaqItem {
  q: string;
  a: string;
}

export interface BandPoint {
  title: string;
  body: string;
}

export interface CrewCard {
  title: string;
  body: string;
  /** Screenshot key resolved in HomePage.astro. */
  image: 'team' | 'bench' | 'wiki' | 'extensions';
  imageAlt: string;
}

export interface PlatformCard {
  name: string;
  sub: string;
  href: string;
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
    primary: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    lede: string;
    primary: string;
    secondary: string;
    note: string;
    imageAlt: string;
  };
  loopBand: {
    title: string;
    body: string;
    points: readonly BandPoint[];
    caption: string;
    imageAlt: string;
  };
  crew: {
    title: string;
    lede: string;
    cards: readonly CrewCard[];
  };
  localBand: {
    title: string;
    body: string;
    points: readonly BandPoint[];
    chips: readonly string[];
  };
  openMind: {
    kicker: string;
    title: string;
    paragraphs: readonly string[];
    cta: string;
  };
  download: {
    title: string;
    lede: string;
    platforms: readonly PlatformCard[];
    more: PlatformCard;
  };
  faq: {
    title: string;
    items: readonly FaqItem[];
  };
  cta: {
    title: string;
    lede: string;
    primary: string;
    secondary: string;
  };
  thanks: {
    body: string;
    ossNote: string;
    names: readonly OssLink[];
  };
  footer: {
    product: string;
    community: string;
    legal: string;
    docs: string;
    releases: string;
    source: string;
    issues: string;
    discussions: string;
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
