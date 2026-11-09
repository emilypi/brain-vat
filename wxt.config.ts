import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'extension',
  publicDir: 'public',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    minimum_chrome_version: '116',
    name: 'Brain Vat',
    description: 'Read, highlight and investigate PDFs in a focused workspace.',
    permissions: ['storage', 'activeTab', 'sidePanel'],
    host_permissions: ['https://arxiv.org/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Open in Brain Vat' },
  },
});
