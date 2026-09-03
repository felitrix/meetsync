// Gera dist-firefox/ a partir de dist/ (build do Chrome) ajustando só o que difere no Firefox:
//
//  • background: o Firefox não implementa `service_worker` (bug 1573659) — usa `scripts`.
//  • browser_specific_settings.gecko: id obrigatório para publicar na AMO; strict_min_version
//    140 (ESR atual): a 127 passou a conceder host_permissions na instalação e a 140 introduziu
//    data_collection_permissions, hoje exigido pela AMO.
//  • web_accessible_resources.use_dynamic_url: não existe no Firefox (gera aviso na validação).
//  • data_collection_permissions: declaração obrigatória na AMO ('none' — nada sai do navegador).
//
// O JS é o mesmo dos dois lados: src/lib/ext.ts aponta `chrome` para `browser` no Firefox.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const out = resolve(root, 'dist-firefox');

if (!existsSync(dist)) {
  console.error('✗ dist/ não encontrada. Rode `npm run build` antes.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });

const manifestPath = resolve(out, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const worker = manifest.background?.service_worker;
if (!worker) {
  console.error('✗ manifest sem background.service_worker — build do Chrome mudou?');
  process.exit(1);
}
manifest.background = { scripts: [worker], type: 'module' };

manifest.browser_specific_settings = {
  gecko: {
    id: 'meetsync@felitrix.github.io',
    strict_min_version: '140.0',
    // A AMO exige a declaração; o MeetSync não envia nada para fora do navegador.
    data_collection_permissions: { required: ['none'] },
  },
};
// Firefox para Android só entende data_collection_permissions a partir da 142.
manifest.browser_specific_settings.gecko_android = { strict_min_version: '142.0' };

for (const war of manifest.web_accessible_resources ?? []) delete war.use_dynamic_url;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ Build Firefox em ${out}`);
