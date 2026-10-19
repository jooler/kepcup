import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Static marketing site. No Cloudflare adapter and no server output:
// Workers serves the dist/ files as static assets (see wrangler.jsonc).
export default defineConfig({
  site: 'https://kepcup.app',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    inlineStylesheets: 'never',
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: 'en',
          zh: 'zh-CN',
        },
      },
    }),
  ],
});
