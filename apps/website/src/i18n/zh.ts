import { links, oss } from './links';
import type { Copy } from './types';

export const zh = {
  locale: 'zh',
  htmlLang: 'zh-CN',
  ogLocale: 'zh_CN',
  metaTitle: 'KepCup — 创建一个团队，只为你服务！',
  metaDescription:
    'KepCup 是本地运行的开源多 Bot 团队应用：Bot 的行为逻辑参考真人，数据完全留在本机，大模型供应商完全自定义。开源，再加上开放的思考——OpenMind。',
  nav: {
    skip: '跳到正文',
    docs: '文档',
    github: 'GitHub',
    download: '下载',
    langName: 'English',
    primary: '主导航',
  },
  hero: {
    eyebrow: '开源 · OpenMind · 完全本地运行',
    title: '创建一个团队，只为你服务！',
    lede: 'KepCup 是一款开源桌面应用：在你的电脑上创建 Bot 团队，它们像真人同事一样沟通、干活、汇报——数据不离开你的机器，模型由你指定。',
    primary: '下载 KepCup',
    secondary: '在 GitHub 查看',
    note: 'GPL-3.0 · macOS / Windows / Linux · 无需注册',
    imageAlt:
      'KepCup 桌面应用：左侧是 Bot 列表，中间是与管家的对话和进行中的任务，右侧是 Bot 详情页。',
  },
  loopBand: {
    title: 'Bot 的行为逻辑，参考真人',
    body: '把事交给真人同事的样子：先回一句「收到，我去办」，然后开工，做完回来汇报。KepCup 把这套逻辑拆成两个独立的 Loop——沟通的只管沟通，干活的专心干活。',
    points: [
      { title: '回复 Loop', body: '秒级回话，只读不写，专职沟通与调度。' },
      { title: '任务 Loop', body: '真正执行，工具与文件留在任务内部，可并行。' },
      { title: '结算汇报', body: '结果回到对话，由 Bot 向你交付。' },
    ],
    caption: '上下文按需注入：只带最新几条与最相关的历史——对话可以无限长。',
    imageAlt: 'KepCup 对话界面：Bot 先回复一句，再派出任务，任务完成后在对话里汇报结果。',
  },
  crew: {
    title: '一支团队，各司其职',
    lede: '创建 Bot，给它们权限与工作目录；项目组负责协作，工作台负责统筹。',
    cards: [
      {
        title: '项目组，而不是群聊',
        body: '负责人分派、共享 wiki、协作熔断——Bot 围绕目标接力，不是闲聊。',
        image: 'team',
        imageAlt: 'KepCup 项目详情页：项目目标、负责人与成员权限、工作目录和定时任务。',
      },
      {
        title: '工作台',
        body: '事项可定时派发、交付可追踪；备忘先记下，随时转成事项。',
        image: 'bench',
        imageAlt: 'KepCup 工作台：左边是派给 Bot 的事项，右边是备忘闪念。',
      },
      {
        title: '记忆与 Wiki',
        body: 'Bot 记得你是谁、答应过什么；Wiki 是它的大脑，文档、音视频皆可入库。',
        image: 'wiki',
        imageAlt: 'KepCup Bot 详情页的 Wiki 标签：这个 Bot 自己维护的知识库目录。',
      },
      {
        title: '连接与扩展',
        body: '连接 Notion、Linear、Cloudflare 等常用应用；技能、MCP、邮件按需取用。',
        image: 'extensions',
        imageAlt: 'KepCup 扩展中心的连接页签：常用应用一键授权给 Bot。',
      },
    ],
  },
  localBand: {
    title: '完全本地运行，模型你说了算',
    body: '对话、记忆、Wiki、技能全部保存在本机加密数据库；模型调用直达你配置的供应商，KepCup 不经手、不存储。',
    points: [
      { title: '任意供应商', body: 'OpenAI 兼容、Ollama、国内厂商；每个 Bot 可单独覆盖。' },
      { title: '订阅也能用', body: 'Claude Code、Codex 等经 ACP 接入；凭据不经 KepCup 之手。' },
      { title: '边界你来定', body: '沙箱执行、按路径授权、危险命令默认拦截。' },
    ],
    chips: ['OpenAI 兼容', 'Ollama', '阿里云百炼', '火山方舟', 'Claude Code', 'Codex', 'Cursor', 'MCP', 'ACP'],
  },
  openMind: {
    kicker: 'OpenMind',
    title: '开放思维，不止开放代码',
    paragraphs: [
      `AI 时代，代码可以被重建，思考难以复制。KepCup 把 [40 余篇设计文档与 92 条编号决策记录](${links.docs})和 GPL-3.0 代码放在一起公开——可读、可引用、可重建。`,
      'OpenMind 补充开源，而不是取代开源——开源是根基，OpenMind 是开放在根基之上的思考。',
    ],
    cta: '阅读设计文档',
  },
  download: {
    title: '下载 KepCup',
    lede: '安装包发布在 GitHub Releases，装好即用，应用内可自动更新。',
    platforms: [
      { name: 'macOS', sub: 'Apple Silicon · Intel', href: links.releases },
      { name: 'Windows', sub: 'x64 · arm64', href: links.releases },
      { name: 'Linux', sub: 'AppImage · deb', href: links.releases },
    ],
    more: { name: '源码与许可', sub: 'GPL-3.0 · GitHub', href: links.github },
  },
  faq: {
    title: '常见问题',
    items: [
      {
        q: 'KepCup 是云服务吗？',
        a: '不是。桌面应用，核心服务在本机常驻——关掉窗口 Bot 仍在工作；没有我们的服务器参与，也无需注册账号。',
      },
      {
        q: '我的数据会被上传吗？',
        a: '不会。数据保存在本机 ~/.kepcup/ 的加密数据库，主密钥在系统钥匙串；模型调用直达你配置的供应商。',
      },
      {
        q: '可以用什么模型？',
        a: '任意 OpenAI 兼容接口、Ollama 本地模型或国内厂商，多模态能力可按厂商分别配置。KepCup 免费开源，模型费用按你的供应商账单结算。',
      },
      {
        q: '和 Grok Bot、Muse 有什么区别？',
        a: '同一件事的本地优先版本：它们托管在云端，KepCup 跑在你自己的机器上。独立实现，灵感致谢见页脚。',
      },
      {
        q: 'Bot 会乱动我的电脑吗？',
        a: '默认不会：命令在沙箱执行、文件按路径授权、危险命令默认拦截，授权可随时撤销。',
      },
    ],
  },
  cta: {
    title: '创建你的第一个 Bot',
    lede: '管家会带你完成初始团队搭建。',
    primary: '免费下载',
    secondary: '阅读文档',
  },
  thanks: {
    body: `感谢 [Grok Bot](https://x.ai/bot)（xAI / Cursor 产品线）的产品灵感——KepCup 是独立实现，不是官方衍生或附属产品；想法上亦参考过 [Rakazo](${links.rakazo})、[OpenMuse](${links.openmuse}) 与 [OpenDots](${links.opendots})。标志与名称属于各自权利人。`,
    ossNote: '开源依赖：',
    names: oss,
  },
  footer: {
    product: '资源',
    community: '参与',
    legal: '法律',
    docs: '文档',
    releases: 'Releases',
    source: '源码',
    issues: 'Issues',
    discussions: '讨论',
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
