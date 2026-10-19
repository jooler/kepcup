import { links, oss } from './links';
import type { Copy } from './types';

export const zh = {
  locale: 'zh',
  htmlLang: 'zh-CN',
  ogLocale: 'zh_CN',
  metaTitle: 'KepCup — 创建一个团队，只为你服务！',
  metaDescription:
    'KepCup 是本地优先的多 Bot 助手。开源是根基。OpenMind 是补充，开放的是思考。数据留在你的电脑上。',
  nav: {
    skip: '跳到正文',
    docs: '文档',
    github: 'GitHub',
    download: '下载',
    langName: 'English',
    onThisPage: '本页目录',
    primary: '主导航',
  },
  toc: [
    { href: '#product', label: '产品' },
    { href: '#openmind', label: 'OpenMind' },
    { href: '#why-local', label: '为什么本地' },
    { href: '#dual-loop', label: '双 loop' },
    { href: '#teams', label: '项目组' },
    { href: '#capabilities', label: '能力' },
    { href: '#trust', label: '边界' },
    { href: '#download', label: '下载' },
    { href: '#looking-for', label: '寻找' },
    { href: '#thanks', label: '致谢' },
  ],
  hero: {
    eyebrow: '本地优先的多 Bot · 开源 + OpenMind',
    slogan: '创建一个团队，只为你服务！',
    imageAlt: 'KepCup 桌面应用界面',
    lede: 'KepCup 是一个桌面应用。你在自己的电脑上创建 Bot，给他们权限和工作目录，他们与你协作，也彼此协作——不必把数据交给一个你无法掌控的主机。',
    download: '下载',
    github: '在 GitHub 查看',
    note: 'GPL-3.0 · 自带模型 · 管家会带你完成第一次设置。',
  },
  shots: {
    id: 'product',
    title: '工作放在哪里',
    lede: '三个界面。下面是它们各自的样子。',
    items: [
      {
        key: 'chat',
        title: '对话',
        body: '三栏：你的 Bot、对话本身，以及旁边的工作。',
      },
      {
        key: 'team',
        title: '项目组',
        body: '一块把活干完的共享板。不是群聊。',
      },
      {
        key: 'bench',
        title: '工作台',
        body: '交给 Bot 的事项，以及停留为闪念的备忘。',
      },
    ],
  },
  openMind: {
    id: 'openmind',
    title: '开源，再加上开放的思考',
    paragraphs: [
      'KepCup 是一款 OpenMind 产品。开源是根基：代码以 GPL-3.0 发布，可以免费使用、自由阅读。OpenMind 是 AI 时代必要的补充。它开放的是思考——产品意图、难题本身，以及模块如何咬合——让别人能用编程模型与智能体重建这些想法，或把它们折叠进自己的产品。',
      'OpenMind 补充开源。OpenMind 不是来取代开源。对外就一句话：开源，再加上开放的思考。',
      'OpenMind 不是应用内的 Bot，也不是对话里可以打开的一项能力。带你完成初次设置的管家是一个 Bot。OpenMind 是把思考和代码放在一起公开发表的决定。',
      `这些文字在[仓库文档](${links.docs})里。设计笔记目前大多是中文。`,
    ],
    linkLabel: '我们在寻找你的 OpenMind',
  },
  why: {
    id: 'why-local',
    title: '为什么放在本地',
    lede: '托管式队友产品是一个真实的品类。KepCup 做的是同一件事的本地优先版本：一个只为你工作的团队，电脑和数据留在你这里。下面比的是各自强调什么，不是贬低谁。',
    caption: '各产品强调的重点。KepCup 是独立实现。',
    colPeer: '对照',
    colThem: '他们强调',
    colUs: 'KepCup 强调',
    rows: [
      {
        peer: 'Grok Bot',
        them: '云端电脑、一直在线、订阅。',
        us: '跑在你的机器上。数据留在本地。自带模型。授权和沙箱由你来定。',
      },
      {
        peer: 'Muse / Dot',
        them: '托管的「说一声就办完」。',
        us: '有队友的感觉，再加上真能把活干完的项目组——不是社交闲聊。',
      },
      {
        peer: 'Rakazo / OpenDots',
        them: '自托管，沿 Grok Bot 的方向，用容器电脑。',
        us: '一个桌面应用：管家带你完成初次设置，有工作台，代码旁边还有 OpenMind 的叙述。',
      },
    ],
  },
  dual: {
    id: 'dual-loop',
    title: '双 loop',
    lede: 'Bot 的双 loop 对照人的工作方式。消息列表是你们约定要记住的内容。回复不会把整段原始记录拖进工作上下文。任务自己保管工具和文件。',
    steps: [
      {
        title: '消息列表',
        body: '一块长期、蒸馏过的板——你和 Bot 打算留下来的对话。',
      },
      {
        title: '回复 loop',
        body: '每条用户消息开启一次独立回复。它不会把累计的原始历史叠成上下文。',
      },
      {
        title: '任务 loop',
        body: '工具、文件和中间状态留在这个任务里，结束再结算回板上。',
      },
    ],
    historyTitle: '一段对话，无限历史',
    historyBody:
      '界面保持一块薄历史板。双 loop 只注入这一轮需要的上下文，所以对话可以一直变长，而每次回复不必重放整段记录。',
  },
  teams: {
    id: 'teams',
    title: '项目组，不是群聊',
    lede: '项目组不是让 Bot 闲聊的房间。它有三个核心，目的是把工作交付出去。',
    roles: [
      {
        title: '集中沟通',
        body: '你和 Bot 在同一处。',
      },
      {
        title: '计划与协作',
        body: '谁负责什么，工作怎么流转。',
      },
      {
        title: '共享知识与交付',
        body: '共享 wiki，并把活干完。',
      },
    ],
    roadmap: '共享消息板和项目 wiki 已经有了。看板、OKR 和日程规划还在路线图上。',
  },
  capabilities: {
    id: 'capabilities',
    title: '应用里已经有的',
    lede: '桌面应用现状的一张简表。还在路线图上的内容写在上面，不混进这张表里假装已经完成。',
    items: [
      {
        title: '双 loop 核心',
        body: '蒸馏后的板、独立回复、分开的任务 loop。',
      },
      {
        title: '会说话的 Bot',
        body: '对话逻辑，包括 Bot 之间如何沟通。',
      },
      {
        title: 'Bot 详情',
        body: '每个 Bot 的配置、记忆、技能、wiki 和定时。',
      },
      {
        title: '你的模型',
        body: '供应商配置，以及多模态输入输出。',
      },
      {
        title: 'Web 与浏览器',
        body: '访问网页，以及 Bot 可以使用的浏览器。',
      },
      {
        title: '麦克风与摄像头',
        body: '麦克风和摄像头的传感器路径，使用前要授权。',
      },
      {
        title: '其他智能体',
        body: '你在本机安装之后，可以通过 ACP 接上第三方编程智能体。',
      },
      {
        title: '扩展中心',
        body: '技能、连接、MCP 和邮件——Bot 需要时才用。',
      },
      {
        title: '边界',
        body: '授权、沙箱、无人值守，以及命令白名单。',
      },
      {
        title: '定时',
        body: '单次与周期。',
      },
      {
        title: '工作台',
        body: '派给 Bot 的事项，以及闪念备忘。',
      },
      {
        title: '项目组',
        body: '共享沟通和项目 wiki。看板和 OKR 还在后面。',
      },
    ],
  },
  trust: {
    id: 'trust',
    title: '边界由你来定',
    lede: '本地优先只有在 Bot 不能悄悄越过你给的权限时才算数。',
    items: [
      {
        title: '授权',
        body: '越过一条你还没允许的线之前，Bot 会先问。',
      },
      {
        title: '沙箱',
        body: '命令跑在你掌控的沙箱里。',
      },
      {
        title: '无人值守',
        body: '你允许之后，Bot 可以在你不坐在旁边时继续。',
      },
      {
        title: '白名单',
        body: '危险命令默认仍然被拦住。',
      },
    ],
    note: '执行中途的权限提示还是打断得太勤。这是一个开放的 OpenMind 问题：少打断，同时默认仍拦住危险命令。如果你有更好的设计，请写到下面的讨论里。',
  },
  download: {
    id: 'download',
    title: '下载',
    lede: '安装包发布在 GitHub Releases（jooler/kepcup）。装好之后，应用自己可以检查更新。这个网站上没有账号要注册。',
    platforms: [
      {
        title: 'macOS',
        body: 'Apple Silicon 与 Intel 的 dmg。发行构建在配好 Apple 凭据时会签名并公证。未签名的包会被 Gatekeeper 拦住，自动更新也要求应用已签名。',
      },
      {
        title: 'Windows',
        body: '一个 NSIS 安装包覆盖 x64 与 arm64。没有代码签名证书时，首次启动 SmartScreen 会提示「Windows 已保护你的电脑」——点「更多信息」，再点「仍要运行」。微软商店版本若发布，由商店签名。',
      },
      {
        title: 'Linux',
        body: 'x64 与 arm64 的 AppImage 和 deb。AppImage 就地更新。deb 更新会通过 pkexec 向你要密码。',
      },
    ],
    cta: 'GitHub Releases',
    source: 'GitHub 上的源码',
    license: 'GPL-3.0',
  },
  looking: {
    id: 'looking-for',
    title: '我们在寻找你的 OpenMind',
    lede: '欢迎提 Issue、讨论或 Pull Request——尤其是这四件事。这是 OpenMind 的邀请，不是应用里面的一张功能表单。',
    items: [
      {
        title: '更好的授权',
        body: '执行中途的确认打断太多。我们希望少打断，同时默认仍拦住危险命令。',
      },
      {
        title: '多模态厂商 API',
        body: '各家不一致。我们想要面前的一层统一抽象。',
      },
      {
        title: '项目组',
        body: '除了看板、OKR 和规划，一个团队还该有什么？',
      },
      {
        title: '工作台',
        body: '它应该在同一个地方汇集工作，减轻「记住哪个 Bot、哪个组」的负担。还缺什么？',
      },
    ],
    issue: '提一个 Issue',
    discussion: '开始一段讨论',
  },
  thanks: {
    id: 'thanks',
    title: '致谢',
    disclaimer:
      'KepCup 站在开源项目和我们学到的产品想法之上。这段话不暗示任何背书或隶属。标志和名称属于各自的权利人。',
    grok: '感谢 Grok Bot（xAI / Cursor 产品线）带来的产品灵感——对话式 Bot、三栏布局，以及扁平的界面。KepCup 是独立实现，不是官方衍生，也不是附属产品。',
    peers: `想法上亦参考过 [Rakazo](${links.rakazo})、[OpenMuse](${links.openmuse}) 和 [OpenDots](${links.opendots})。它们不是本仓库的运行时依赖。`,
    ossTitle: '开源依赖',
    ossNote: '这里只有名称和上游链接，网站上不放第三方标志。更完整的分层清单在仓库 README。',
    names: oss,
  },
  footer: {
    privacy: '隐私',
    terms: '条款',
    license: 'GPL-3.0',
    rights: '© 2026 kepcup-app',
    navLabel: '页脚',
  },
  privacy: {
    title: '隐私',
    updated: '更新于 2026-10-19',
    paragraphs: [
      '本页说明 kepcup.app 上的营销站。它是静态网站，不创建账号，也没有可以登录的地方。',
      '这个仓库里的页面不包含第一方统计脚本。如果 kepcup.app 以后打开 Cloudflare Web Analytics，本页会写明。',
      `文件由 Cloudflare 提供。他们会处理连接数据（包括 IP 地址）来把网站送到你这里。政策见 [Cloudflare 隐私政策](${links.cloudflarePrivacy})。`,
      `下载按钮指向 [GitHub Releases](${links.releases})，适用 GitHub 自己的隐私政策。桌面应用是本地优先的：模型调用发往你配置的供应商，并遵守你与那些供应商接受的条款。本页不是应用的完整政策。产品行为写在[仓库文档](${links.docs})里。`,
      'kepcup.com 是另一个主机名。它托管 kepcup.com/oauth 的 OAuth 客户端元数据、dl.kepcup.com 的连接器文件，以及 registry.kepcup.com 的注册表。那些服务不是这个营销站，这次部署也不会换掉它们。',
      `联系：[kepcup-app@kepcup.app](${links.email})。`,
    ],
  },
  terms: {
    title: '条款',
    updated: '更新于 2026-10-19',
    paragraphs: [
      `KepCup 桌面应用和本仓库以 [GPL-3.0](${links.license}) 许可。本网站的文字在同一个仓库里。`,
      '本站不提供账号、订阅或托管团队。下载的是发布在 GitHub Releases 上的安装包，按该许可原样提供。',
      '本站提到的其他产品名称属于各自权利人。提及不等于背书、赞助或隶属。',
      `联系：[kepcup-app@kepcup.app](${links.email})。`,
    ],
  },
  notFound: {
    title: '找不到页面',
    body: 'kepcup.app 上没有这个地址。',
    home: '回到 KepCup',
  },
} satisfies Copy;
