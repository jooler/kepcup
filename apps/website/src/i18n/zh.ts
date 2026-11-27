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
        imageAlt: 'KepCup 工作台：左边是备忘闪念，右边是派给 Bot 的事项。',
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
    updated: '更新于 2026-11-27',
    paragraphs: [
      '这是 KepCup 的隐私政策，覆盖网站（kepcup.app，亦通过 kepcup.com 提供）与 KepCup 桌面应用。简版：应用在你自己的电脑上运行，对话留在本机，模型调用发往你配置的供应商；应用发给我们的唯一数据，是你用 👎 明确提交的那条举报，见下方「AI 内容举报」。',
      '本网站是静态站点，不创建账号，也没有可以登录的地方；页面不含第一方统计脚本。文件由 Cloudflare 提供，他们会处理连接数据（包括 IP 地址）来把网站送到你这里，政策见 [Cloudflare 隐私政策](' +
        links.cloudflarePrivacy +
        ')。',
      '桌面应用的数据留在你的机器上：对话、Bot 画像、记忆、Wiki、技能与设置都保存在 ~/.kepcup/ 下的加密数据库，主密钥在系统钥匙串；消息上的本机 emoji 表情与待发送的举报队列也保存在同一个加密库里。KepCup 没有账号体系；在本机清空应用数据即删除这些本地副本。',
      `模型调用从应用直达你配置的 AI 供应商；API Key 保存在本机（加密存储），KepCup 不经手、不存储这部分流量。供应商收到什么、他们如何处理，由你接受的那家供应商条款决定。产品行为写在[仓库文档](${links.docs})里。`,
      '应用不发送崩溃报告、使用统计或任何分析数据。应用会检查新版本：检查更新就是从 [GitHub Releases](' +
        links.releases +
        ') 或我们的只读镜像（updates.kepcup.com 与阿里云 OSS 镜像）下载一个小清单文件，涉及的网络数据与任何下载一样——例如你的 IP 地址。',
      'AI 内容举报。应用里的 Bot 消息可以添加 emoji 表情：除 👎 之外的所有表情只存在本机，不上传、不同步。Bot 消息上的 👎 是「举报不当 AI 生成内容」：点击后举报先在本机排队，再由应用在后台发送到 https://reports.kepcup.com——这是 KepCup 运营、架设在 Cloudflare 上的举报接收端点。点击 👎 本身即视为你同意发送这一条举报；你不点击的消息永远不会被发送，应用也不会再弹二次确认框。举报后台最多每分钟发送一条，同一安装对相同内容的重复举报会在去重窗口内被自动丢弃。',
      '一条举报包含：被举报消息的正文（或卡片 JSON）、之前最多四条上下文消息与被引用的原文、Bot 名称与裁剪后的人设画像（不超过 8 KB）、该 Bot 的模型配置以及实际使用的供应商/模型/token 用量、用到的工具名称与调用次数（不含工具输出）、附件元数据（文件名、类型、大小——不含附件内容），以及应用版本、平台与语言。',
      '一条举报绝不包含：API Key 或其他凭据（正文里识别出的已知 API Key 在发送前会被替换为 [REDACTED]）、完整系统提示词、工具输出全文、记忆条目、附件内容、你的团队服务器地址。所有文本在离开应用前都会清洗并按固定大小截断，整份举报总量不超过 128 KB。',
      '举报的用途：评估并改进 KepCup AI 生成内容的安全性——例如提示词、过滤或模型调整——以及运营 Microsoft Store 政策 11.16 要求的举报渠道，包括对举报内容采取适当行动。举报不用于广告，也不与第三方共享；Cloudflare 作为基础设施提供方处理这些数据。',
      '存储与保留：举报保存在 Cloudflare D1 数据库中（静态加密），每日定时任务自动删除收到超过 365 天的举报。服务器永不保存你的原始 IP 地址——只保存它的 HMAC-SHA256 摘要，仅用于限流。服务端日志只记举报标识与状态，不含消息正文、客户端标识或 IP 地址。',
      `删除举报：两个渠道。发邮件到 [kepcup-app@kepcup.app](${links.email}) 提出删除请求，我们会删除与你的安装客户端标识关联的全部举报；在本机清空应用数据会立即删除你的本地副本（待发队列与表情），服务器上的副本只能通过邮件请求删除。`,
      '团队托管会话：如果你举报的是自托管 KepCup 团队服务器上会话里的消息，举报由该团队服务器软件转发到同一个举报端点，来源只记录为该服务器的单向哈希——绝不包含其地址。',
      `本站提供的下载指向 [GitHub Releases](${links.releases})，适用 GitHub 自己的隐私政策。`,
      'kepcup.com 是另一个主机名：它托管 kepcup.com/oauth 的 OAuth 客户端元数据、dl.kepcup.com 的连接器文件、registry.kepcup.com 的插件注册表，以及 reports.kepcup.com 的举报端点。那些服务不是这个营销站。',
      `疑问、隐私请求或举报删除请求：[kepcup-app@kepcup.app](${links.email}) 或 [GitHub Issues](${links.issues})。`,
    ],
  },
  terms: {
    title: '条款',
    updated: '更新于 2026-11-27',
    paragraphs: [
      `KepCup 桌面应用和本仓库以 [GPL-3.0](${links.license}) 许可。本网站的文字在同一个仓库里。`,
      '本站不提供账号、订阅或托管团队。下载的是发布在 GitHub Releases 上的安装包，按该许可原样提供。',
      'AI 生成内容。应用根据你的输入，用实时生成式 AI 模型动态产生内容。此类内容可能不准确、不完整或不合适，不代表 KepCup 的观点；请在核实后再依赖它。使用生成内容时，你也应遵守所配置模型供应商的条款。',
      '举报不当内容。Bot 消息带有 👎 表情入口，可将不当 AI 生成内容举报给开发者（消息右键菜单中也有「举报」项）。我们会审查被举报的内容并采取相应行动——例如提示词、过滤或模型调整——这是 Microsoft Store 政策 11.16 的要求。',
      '举报即同意。点击 👎 即是明确指示按[隐私政策](/zh/privacy/)所述向开发者发送这一条举报：点击即视为同意该次提交。你不点击就不会发送任何内容；除 👎 之外的表情只保存在你的机器上。',
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
