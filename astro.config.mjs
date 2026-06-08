import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://miople.us',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'rose-pine-dawn',
      wrap: true,
    },
  },
});
