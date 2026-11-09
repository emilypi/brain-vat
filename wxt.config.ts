import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'extension',
  publicDir: 'public',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Paper Reader',
    description: 'Read, highlight and investigate PDFs in a focused workspace.',
    permissions: ['storage', 'activeTab', 'sidePanel'],
    host_permissions: ['https://arxiv.org/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Open in Paper Reader' },
  },
});
