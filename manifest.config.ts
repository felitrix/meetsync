import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

/**
 * Manifest MV3 do MeetSync.
 *
 * Permissões mínimas (RNF-017): apenas `storage` e `notifications`.
 * host_permissions: somente `meet.google.com` (RNF-018).
 * Ollama e o relay NVIDIA ficam restritos a `localhost`/`127.0.0.1`; a extensão não recebe
 * permissão para a API externa. Somente o companion local, fora do pacote, fala com a NVIDIA.
 */
export default defineManifest({
  manifest_version: 3,
  // ES2022 + crypto.randomUUID; também evita instalar em navegadores Chromium obsoletos.
  minimum_chrome_version: '109',
  // Nome/descrição localizados via _locales (a Web Store exibe conforme o idioma do usuário).
  // Os textos vivem em public/_locales/{en,pt_BR,es}/messages.json (achatado para dist/_locales).
  default_locale: 'en',
  name: '__MSG_name__',
  version: pkg.version,
  description: '__MSG_description__',
  icons: {
    16: 'public/icons/icon-16.png',
    32: 'public/icons/icon-32.png',
    48: 'public/icons/icon-48.png',
    128: 'public/icons/icon-128.png',
  },
  action: {
    default_title: 'MeetSync',
    default_popup: 'src/popup/popup.html',
    default_icon: {
      16: 'public/icons/icon-16.png',
      32: 'public/icons/icon-32.png',
      48: 'public/icons/icon-48.png',
      128: 'public/icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // Google Meet + Microsoft Teams (Web): teams.cloud.microsoft (autenticado) e
      // teams.microsoft.com (convidado/anônimo + launcher).
      matches: [
        'https://meet.google.com/*',
        'https://teams.cloud.microsoft/*',
        'https://teams.microsoft.com/*',
      ],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
    },
  ],
  // O download usa Blob + link local; não precisa da permissão ampla `downloads`.
  permissions: ['storage', 'notifications'],
  // localhost/127.0.0.1 concedidos na instalação para Ollama e relay NVIDIA local.
  // Permissões enxutas para a Chrome Web Store — sem curinga (evita rejeição no review).
  host_permissions: [
    'https://meet.google.com/*',
    'https://teams.cloud.microsoft/*',
    'https://teams.microsoft.com/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  // Endurece as páginas da extensão: só código empacotado, sem objetos/plugins ou base externa.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
  },
  options_ui: {
    page: 'src/options/options.html',
    open_in_tab: true,
  },
});
