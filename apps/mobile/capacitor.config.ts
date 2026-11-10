import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 手机原生壳配置(D122,docs/design/58-mobile-shell.md):
 *
 * - 首页打包在 App 里(webDir),连接目标本身不打包——WebView 留在「所连服务端
 *   同源托管的 web 客户端」上,客户端与 core 版本永远匹配,零协议改动。
 * - allowNavigation 通配:目标源任意(桌面中转域 / 局域网 IP:端口 / 自建域名)。
 *   外部页面上 Capacitor 桥不注入(capacitor#1389),渲染层壳标记走
 *   `?shell=native&shellBack=…` 查询参数,不依赖桥。
 * - 明文 http 不走 server.cleartext(全局放行太粗且只服务开发场景):Android 用
 *   android/app/src/main/res/xml/network_security_config.xml 声明,iOS 用
 *   ios/App/App/Info.plist 的 ATS 例外,两处都有注释说明取舍。
 */
const config: CapacitorConfig = {
  appId: 'app.kepcup.desktop',
  appName: 'KepCup',
  webDir: 'dist',
  server: {
    allowNavigation: ['*'],
  },
};

export default config;
