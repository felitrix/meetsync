import { loadSettings, saveSettings } from '@/services/storage-service';
import { normalizeOllamaUrl, ollama } from '@/services/ollama-client';
import { nvidiaRelay } from '@/services/nvidia-relay-client';
import { resolveLocale, type Locale } from '@/i18n';
import type { AlertWatch, UserSettings } from '@/types';

const COPY = {
  pt: {
    title: 'Configurações',
    subtitle: 'Configure o MeetSync em qualquer aba, sem precisar abrir o Google Meet.',
    saved: 'Salvo automaticamente',
    saving: 'Salvando…',
    general: 'Geral',
    generalSub: 'Idioma, identificação e comportamento básico.',
    language: 'Idioma',
    selfName: 'Seu nome na reunião',
    selfNameHint: 'Usado para substituir “Você” e evitar alertas sobre a sua própria fala.',
    capture: 'Captura',
    captureSub: 'Como o MeetSync inicia e acompanha reuniões.',
    autoCaptions: 'Ligar legendas automaticamente',
    autoCaptionsSub: 'Tenta ativar as legendas ao entrar numa reunião.',
    autoChat: 'Abrir chat automaticamente',
    autoChatSub: 'Abre o painel do chat para capturar mensagens de texto.',
    alertsArmed: 'Monitorar menções',
    alertsArmedSub: 'Ativa as regras configuradas abaixo.',
    alertSound: 'Som dos alertas',
    alertSoundSub: 'Toca um aviso local quando uma regra dispara.',
    export: 'Exportação e histórico',
    exportSub: 'Preferências usadas nos downloads e no armazenamento local.',
    includeHeader: 'Incluir cabeçalho no TXT',
    includeHeaderSub: 'Adiciona título, data, link e participantes.',
    exportJson: 'Baixar JSON junto',
    exportJsonSub: 'Gera também um arquivo estruturado para automações.',
    retention: 'Reuniões não favoritas mantidas',
    ai: 'Ollama e IA local',
    aiSub: 'Somente localhost ou 127.0.0.1; nenhum servidor remoto é aceito.',
    ollamaUrl: 'Endereço do Ollama',
    test: 'Testar conexão',
    testing: 'Conectando…',
    connected: (n: number) => `Conectado — ${n} modelo(s) encontrado(s).`,
    failed: (message: string) => `Não foi possível conectar: ${message}`,
    model: 'Modelo',
    noModels: 'Teste a conexão para listar os modelos',
    correction: 'Corrigir transcrição com IA',
    correctionSub: 'Corrige reconhecimento de fala antes do download.',
    summary: 'Incluir resumo/ata',
    summarySub: 'Gera uma ata usando o modelo local selecionado.',
    separate: 'Resumo em arquivo separado',
    separateSub: 'Baixa a ata em outro arquivo em vez de anexá-la ao TXT.',
    realtime: 'Atualizar ata durante a reunião',
    realtimeSub: 'Gera novas versões da ata no intervalo escolhido.',
    interval: 'Intervalo da ata em tempo real',
    vocabulary: 'Vocabulário do negócio',
    vocabularySub: 'Um termo por linha ou separado por vírgula.',
    watches: 'Regras de alerta',
    watchesSub: 'Gerencie palavras, frases e contextos monitorados fora da reunião.',
    keyword: 'Palavra ou frase',
    context: 'Contexto por IA',
    ruleName: 'Nome da regra',
    ruleDetails: 'Termos separados por vírgula ou descrição do contexto',
    addRule: 'Adicionar regra',
    remove: 'Excluir',
    emptyRules: 'Nenhuma regra configurada.',
  },
  en: {
    title: 'Settings',
    subtitle: 'Configure MeetSync from any tab, without opening Google Meet.',
    saved: 'Saved automatically',
    saving: 'Saving…',
    general: 'General',
    generalSub: 'Language, identification, and basic behavior.',
    language: 'Language',
    selfName: 'Your meeting name',
    selfNameHint: 'Used to replace “You” and avoid alerts about your own speech.',
    capture: 'Capture',
    captureSub: 'How MeetSync starts and follows meetings.',
    autoCaptions: 'Turn captions on automatically',
    autoCaptionsSub: 'Tries to enable captions when you join a meeting.',
    autoChat: 'Open chat automatically',
    autoChatSub: 'Opens chat to capture text messages.',
    alertsArmed: 'Monitor mentions',
    alertsArmedSub: 'Enables the rules configured below.',
    alertSound: 'Alert sound',
    alertSoundSub: 'Plays a local sound when a rule triggers.',
    export: 'Export and history',
    exportSub: 'Preferences used for downloads and local storage.',
    includeHeader: 'Include TXT header',
    includeHeaderSub: 'Adds title, date, link, and participants.',
    exportJson: 'Download JSON too',
    exportJsonSub: 'Also generates a structured file for automations.',
    retention: 'Non-favorite meetings retained',
    ai: 'Ollama and local AI',
    aiSub: 'Localhost or 127.0.0.1 only; remote servers are rejected.',
    ollamaUrl: 'Ollama address',
    test: 'Test connection',
    testing: 'Connecting…',
    connected: (n: number) => `Connected — ${n} model(s) found.`,
    failed: (message: string) => `Could not connect: ${message}`,
    model: 'Model',
    noModels: 'Test the connection to list models',
    correction: 'Correct transcript with AI',
    correctionSub: 'Corrects speech recognition before download.',
    summary: 'Include summary/minutes',
    summarySub: 'Creates minutes using the selected local model.',
    separate: 'Summary in a separate file',
    separateSub: 'Downloads minutes separately instead of appending them to TXT.',
    realtime: 'Update minutes during the meeting',
    realtimeSub: 'Generates new minutes at the selected interval.',
    interval: 'Real-time minutes interval',
    vocabulary: 'Business vocabulary',
    vocabularySub: 'One term per line or comma-separated.',
    watches: 'Alert rules',
    watchesSub: 'Manage monitored words, phrases, and contexts outside a meeting.',
    keyword: 'Word or phrase',
    context: 'AI context',
    ruleName: 'Rule name',
    ruleDetails: 'Comma-separated terms or a context description',
    addRule: 'Add rule',
    remove: 'Delete',
    emptyRules: 'No rules configured.',
  },
  es: {
    title: 'Configuración',
    subtitle: 'Configura MeetSync desde cualquier pestaña, sin abrir Google Meet.',
    saved: 'Guardado automáticamente',
    saving: 'Guardando…',
    general: 'General',
    generalSub: 'Idioma, identificación y comportamiento básico.',
    language: 'Idioma',
    selfName: 'Tu nombre en la reunión',
    selfNameHint: 'Se usa para reemplazar “Tú” y evitar alertas sobre tu propia voz.',
    capture: 'Captura',
    captureSub: 'Cómo MeetSync inicia y acompaña las reuniones.',
    autoCaptions: 'Activar subtítulos automáticamente',
    autoCaptionsSub: 'Intenta activar los subtítulos al entrar en una reunión.',
    autoChat: 'Abrir chat automáticamente',
    autoChatSub: 'Abre el chat para capturar mensajes de texto.',
    alertsArmed: 'Monitorear menciones',
    alertsArmedSub: 'Activa las reglas configuradas abajo.',
    alertSound: 'Sonido de alertas',
    alertSoundSub: 'Reproduce un aviso local cuando se activa una regla.',
    export: 'Exportación e historial',
    exportSub: 'Preferencias de descarga y almacenamiento local.',
    includeHeader: 'Incluir encabezado en TXT',
    includeHeaderSub: 'Añade título, fecha, enlace y participantes.',
    exportJson: 'Descargar también JSON',
    exportJsonSub: 'Genera un archivo estructurado para automatizaciones.',
    retention: 'Reuniones no favoritas conservadas',
    ai: 'Ollama e IA local',
    aiSub: 'Solo localhost o 127.0.0.1; se rechazan servidores remotos.',
    ollamaUrl: 'Dirección de Ollama',
    test: 'Probar conexión',
    testing: 'Conectando…',
    connected: (n: number) => `Conectado — ${n} modelo(s) encontrado(s).`,
    failed: (message: string) => `No fue posible conectar: ${message}`,
    model: 'Modelo',
    noModels: 'Prueba la conexión para listar los modelos',
    correction: 'Corregir transcripción con IA',
    correctionSub: 'Corrige el reconocimiento antes de la descarga.',
    summary: 'Incluir resumen/acta',
    summarySub: 'Genera un acta usando el modelo local seleccionado.',
    separate: 'Resumen en archivo separado',
    separateSub: 'Descarga el acta por separado en lugar de añadirla al TXT.',
    realtime: 'Actualizar acta durante la reunión',
    realtimeSub: 'Genera nuevas versiones del acta en el intervalo elegido.',
    interval: 'Intervalo del acta en tiempo real',
    vocabulary: 'Vocabulario del negocio',
    vocabularySub: 'Un término por línea o separado por comas.',
    watches: 'Reglas de alerta',
    watchesSub: 'Gestiona palabras, frases y contextos monitoreados fuera de la reunión.',
    keyword: 'Palabra o frase',
    context: 'Contexto por IA',
    ruleName: 'Nombre de la regla',
    ruleDetails: 'Términos separados por comas o descripción del contexto',
    addRule: 'Añadir regla',
    remove: 'Eliminar',
    emptyRules: 'No hay reglas configuradas.',
  },
} as const;

const NVIDIA_COPY: Record<Locale, { title: string; sub: string; url: string; code: string; pair: string; test: string; anon: string; anonSub: string; limits: string; warning: string; unpaired: string; paired: string }> = {
  pt: { title: 'NVIDIA experimental', sub: 'Uso manual por relay local; a chave nunca entra na extensão.', url: 'Relay local', code: 'Código de pareamento', pair: 'Parear', test: 'Testar relay', anon: 'Anonimizar antes de enviar', anonSub: 'Remove nomes e identificadores comuns por padrão.', limits: 'Limites rígidos', warning: 'Somente protótipos e conteúdo não confidencial. Sem chamadas automáticas.', unpaired: 'Relay ainda não pareado.', paired: 'Relay pareado e protegido.' },
  en: { title: 'Experimental NVIDIA', sub: 'Manual use through a local relay; the key never enters the extension.', url: 'Local relay', code: 'Pairing code', pair: 'Pair', test: 'Test relay', anon: 'Anonymize before sending', anonSub: 'Removes names and common identifiers by default.', limits: 'Hard limits', warning: 'Prototypes and non-confidential content only. No automatic calls.', unpaired: 'Relay is not paired yet.', paired: 'Relay paired and protected.' },
  es: { title: 'NVIDIA experimental', sub: 'Uso manual mediante relay local; la clave nunca entra en la extensión.', url: 'Relay local', code: 'Código de emparejamiento', pair: 'Emparejar', test: 'Probar relay', anon: 'Anonimizar antes de enviar', anonSub: 'Elimina nombres e identificadores comunes por defecto.', limits: 'Límites estrictos', warning: 'Solo prototipos y contenido no confidencial. Sin llamadas automáticas.', unpaired: 'Relay aún no emparejado.', paired: 'Relay emparejado y protegido.' },
};

const root = document.getElementById('root')!;
if (!root) throw new Error('Options root not found.');

let settings: UserSettings;
let locale: Locale = 'pt';
let models: string[] = [];
let connectionMessage = '';
let connectionKind: '' | 'is-ok' | 'is-error' = '';
let nvidiaMessage = '';
let nvidiaKind: '' | 'is-ok' | 'is-error' = '';
let saveState: HTMLElement | null = null;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') element.textContent = value;
    else element.setAttribute(key, value);
  }
  element.append(...children);
  return element;
}

function copy() {
  return COPY[locale];
}

async function persist(partial: Partial<UserSettings>, rerender = false): Promise<void> {
  settings = { ...settings, ...partial };
  if (saveState) {
    saveState.textContent = copy().saving;
    saveState.className = 'save-state';
  }
  await saveSettings(settings);
  if (rerender) {
    render();
  } else if (saveState) {
    saveState.textContent = copy().saved;
    saveState.className = 'save-state is-ok';
  }
}

function section(title: string, subtitle: string, children: Node[], wide = false): HTMLElement {
  return node('section', { class: `section${wide ? ' is-wide' : ''}` }, [
    node('div', { class: 'section-head' }, [
      node('h2', { text: title }),
      node('p', { text: subtitle }),
    ]),
    ...children,
  ]);
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return node('label', { class: 'field' }, [
    node('span', { text: label }),
    control,
    ...(hint ? [node('small', { class: 'hint', text: hint })] : []),
  ]);
}

function toggle(
  label: string,
  description: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLElement {
  const input = node('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return node('label', { class: 'toggle' }, [
    node('span', {}, [
      node('strong', { text: label }),
      node('small', { text: description }),
    ]),
    input,
  ]);
}

function selectControl(
  values: Array<{ value: string; label: string }>,
  selected: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = node('select') as HTMLSelectElement;
  for (const item of values) {
    const option = node('option', { value: item.value, text: item.label }) as HTMLOptionElement;
    option.selected = item.value === selected;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function generalSection(): HTMLElement {
  const c = copy();
  const language = selectControl(
    [
      { value: 'pt', label: 'Português' },
      { value: 'en', label: 'English' },
      { value: 'es', label: 'Español' },
    ],
    locale,
    (value) => {
      locale = value as Locale;
      document.documentElement.lang = locale === 'pt' ? 'pt-BR' : locale;
      void persist({ locale }, true);
    },
  );
  const selfName = node('input', {
    type: 'text',
    'data-setting': 'selfName',
    value: settings.selfName,
    placeholder: locale === 'pt' ? 'Ex.: Felipe' : 'Your name',
  }) as HTMLInputElement;
  selfName.addEventListener('change', () => void persist({ selfName: selfName.value.trim() }));
  return section(c.general, c.generalSub, [
    field(c.language, language),
    field(c.selfName, selfName, c.selfNameHint),
  ]);
}

function captureSection(): HTMLElement {
  const c = copy();
  return section(c.capture, c.captureSub, [
    toggle(c.autoCaptions, c.autoCaptionsSub, settings.autoEnableCaptions, (value) =>
      void persist({ autoEnableCaptions: value })),
    toggle(c.autoChat, c.autoChatSub, settings.autoOpenChat, (value) =>
      void persist({ autoOpenChat: value })),
    toggle(c.alertsArmed, c.alertsArmedSub, settings.alertsArmed, (value) =>
      void persist({ alertsArmed: value })),
    toggle(c.alertSound, c.alertSoundSub, settings.alertSound, (value) =>
      void persist({ alertSound: value })),
  ]);
}

function exportSection(): HTMLElement {
  const c = copy();
  const retention = selectControl(
    [10, 20, 40].map((value) => ({ value: String(value), label: String(value) })),
    String(settings.historyRetentionCount),
    (value) => void persist({ historyRetentionCount: Number(value) }),
  );
  return section(c.export, c.exportSub, [
    toggle(c.includeHeader, c.includeHeaderSub, settings.includeHeaderByDefault, (value) =>
      void persist({ includeHeaderByDefault: value })),
    toggle(c.exportJson, c.exportJsonSub, settings.exportJson, (value) =>
      void persist({ exportJson: value })),
    field(c.retention, retention),
  ]);
}

async function testConnection(): Promise<void> {
  const c = copy();
  connectionMessage = c.testing;
  connectionKind = '';
  render();
  try {
    const url = normalizeOllamaUrl(settings.ollamaUrl);
    models = await ollama.listModels(url);
    const model = models.includes(settings.ollamaModel ?? '')
      ? settings.ollamaModel
      : models[0];
    settings = { ...settings, ollamaUrl: url, ollamaModel: model };
    await saveSettings(settings);
    connectionMessage = c.connected(models.length);
    connectionKind = 'is-ok';
  } catch (error) {
    connectionMessage = c.failed(error instanceof Error ? error.message : String(error));
    connectionKind = 'is-error';
  }
  render();
}

function aiSection(): HTMLElement {
  const c = copy();
  const url = node('input', {
    type: 'text',
    value: settings.ollamaUrl,
    placeholder: 'http://localhost:11434',
  }) as HTMLInputElement;
  url.addEventListener('change', () => {
    const normalized = normalizeOllamaUrl(url.value);
    url.value = normalized;
    void persist({ ollamaUrl: normalized });
  });
  const test = node('button', { class: 'btn fit', type: 'button', text: c.test }) as HTMLButtonElement;
  test.addEventListener('click', () => void testConnection());

  const modelValues = [...new Set([...(settings.ollamaModel ? [settings.ollamaModel] : []), ...models])]
    .map((value) => ({ value, label: value }));
  if (!modelValues.length) modelValues.push({ value: '', label: c.noModels });
  const model = selectControl(modelValues, settings.ollamaModel ?? '', (value) =>
    void persist({ ollamaModel: value || undefined }));

  const interval = selectControl(
    [1, 2, 5, 10].map((value) => ({ value: String(value), label: `${value} min` })),
    String(settings.summaryIntervalMin),
    (value) => void persist({ summaryIntervalMin: Number(value) }),
  );

  const vocabulary = node('textarea', {
    placeholder: 'NeoVale 3D\nSKU\nMercado Livre',
  }) as HTMLTextAreaElement;
  vocabulary.value = settings.vocabulary.join('\n');
  vocabulary.addEventListener('change', () => {
    const terms = [...new Set(vocabulary.value.split(/[,\n]/).map((term) => term.trim()).filter(Boolean))];
    void persist({ vocabulary: terms });
  });

  return section(c.ai, c.aiSub, [
    node('div', { class: 'row' }, [field(c.ollamaUrl, url), test]),
    node('div', { class: `status ${connectionKind}`.trim(), text: connectionMessage }),
    field(c.model, model),
    toggle(c.correction, c.correctionSub, settings.enableAiCorrection, (value) =>
      void persist({ enableAiCorrection: value })),
    toggle(c.summary, c.summarySub, settings.includeSummary, (value) =>
      void persist({ includeSummary: value })),
    toggle(c.separate, c.separateSub, settings.separateSummaryFile, (value) =>
      void persist({ separateSummaryFile: value })),
    toggle(c.realtime, c.realtimeSub, settings.realtimeSummary, (value) =>
      void persist({ realtimeSummary: value })),
    field(c.interval, interval),
    field(c.vocabulary, vocabulary, c.vocabularySub),
  ], true);
}

function nvidiaSection(): HTMLElement {
  const c = NVIDIA_COPY[locale];
  const url = node('input', { type: 'text', value: settings.nvidiaRelayUrl, placeholder: 'http://127.0.0.1:19876' }) as HTMLInputElement;
  url.addEventListener('change', () => {
    try {
      const normalized = nvidiaRelay.normalizeUrl(url.value);
      url.value = normalized;
      void persist({ nvidiaRelayUrl: normalized, nvidiaRelayToken: undefined });
    } catch (error) {
      nvidiaMessage = error instanceof Error ? error.message : String(error); nvidiaKind = 'is-error'; render();
    }
  });
  const code = node('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '000000' }) as HTMLInputElement;
  const pair = node('button', { class: 'btn primary fit', type: 'button', text: c.pair }) as HTMLButtonElement;
  pair.addEventListener('click', () => void (async () => {
    if (!/^\d{6}$/.test(code.value.trim())) { nvidiaMessage = 'Informe o código de 6 dígitos exibido pelo relay.'; nvidiaKind = 'is-error'; render(); return; }
    try {
      const result = await nvidiaRelay.pair(settings.nvidiaRelayUrl, code.value.trim());
      await persist({ nvidiaRelayToken: result.token, aiProvider: 'nvidia-relay' });
      nvidiaMessage = c.paired; nvidiaKind = 'is-ok'; render();
    } catch (error) { nvidiaMessage = error instanceof Error ? error.message : String(error); nvidiaKind = 'is-error'; render(); }
  })());
  const test = node('button', { class: 'btn fit', type: 'button', text: c.test }) as HTMLButtonElement;
  test.addEventListener('click', () => void (async () => {
    try {
      const result = await nvidiaRelay.test(settings.nvidiaRelayUrl, settings.nvidiaRelayToken);
      if (!result.paired) throw new Error(c.unpaired);
      const [models, usage] = await Promise.all([
        nvidiaRelay.listModels(settings.nvidiaRelayUrl, settings.nvidiaRelayToken!),
        nvidiaRelay.usage(settings.nvidiaRelayUrl, settings.nvidiaRelayToken!),
      ]);
      nvidiaMessage = `${c.paired} ${usage.calls}/${usage.limits.dailyCalls} chamadas hoje · ${models.models.join(', ')}`;
      nvidiaKind = 'is-ok';
    } catch (error) { nvidiaMessage = error instanceof Error ? error.message : String(error); nvidiaKind = 'is-error'; }
    render();
  })());
  const model = node('input', { type: 'text', value: settings.nvidiaModel }) as HTMLInputElement;
  model.addEventListener('change', () => void persist({ nvidiaModel: model.value.trim() || 'meta/llama-3.1-8b-instruct' }));
  const limits = `${settings.nvidiaDailyCallLimit}/dia · ${settings.nvidiaMeetingCallLimit}/reunião · ${settings.nvidiaInputTokenLimit} entrada · ${settings.nvidiaOutputTokenLimit} saída`;
  return section(c.title, c.sub, [
    node('div', { class: 'row' }, [field(c.url, url), test]),
    node('div', { class: 'row' }, [field(c.code, code), pair]),
    node('div', { class: `status ${nvidiaKind}`.trim(), text: nvidiaMessage || (settings.nvidiaRelayToken ? c.paired : c.unpaired) }),
    field(copy().model, model),
    toggle(c.anon, c.anonSub, settings.nvidiaAnonymize, (value) => void persist({ nvidiaAnonymize: value })),
    field(c.limits, node('div', { class: 'hint', text: limits })),
    node('p', { class: 'hint', text: c.warning }),
  ], true);
}

function watchDetail(watch: AlertWatch): string {
  return watch.mode === 'keyword' ? (watch.terms ?? []).join(', ') : (watch.desc ?? '');
}

function watchesSection(): HTMLElement {
  const c = copy();
  const list = node('div', { class: 'watch-list' });
  if (!settings.alertWatches.length) list.append(node('p', { class: 'hint', text: c.emptyRules }));
  for (const watch of settings.alertWatches) {
    const enabled = node('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = watch.enabled;
    enabled.addEventListener('change', () => {
      const alertWatches = settings.alertWatches.map((item) =>
        item.id === watch.id ? { ...item, enabled: enabled.checked } : item);
      void persist({ alertWatches });
    });
    const remove = node('button', { class: 'btn danger', type: 'button', text: c.remove });
    remove.addEventListener('click', () => {
      void persist({ alertWatches: settings.alertWatches.filter((item) => item.id !== watch.id) }, true);
    });
    list.append(node('div', { class: 'watch' }, [
      enabled,
      node('div', {}, [
        node('span', { class: 'watch-label', text: watch.label }),
        node('small', { text: watchDetail(watch) }),
      ]),
      remove,
    ]));
  }

  const mode = selectControl(
    [
      { value: 'keyword', label: c.keyword },
      { value: 'ai', label: c.context },
    ],
    'keyword',
    () => undefined,
  );
  const label = node('input', { type: 'text', placeholder: c.ruleName }) as HTMLInputElement;
  const detail = node('input', { type: 'text', placeholder: c.ruleDetails }) as HTMLInputElement;
  const add = node('button', { class: 'btn primary fit', type: 'button', text: c.addRule });
  add.addEventListener('click', () => {
    const cleanLabel = label.value.trim();
    const cleanDetail = detail.value.trim();
    if (!cleanLabel || !cleanDetail) return;
    const watch: AlertWatch = mode.value === 'ai'
      ? {
          id: crypto.randomUUID(),
          mode: 'ai',
          label: cleanLabel,
          desc: cleanDetail,
          enabled: true,
        }
      : {
          id: crypto.randomUUID(),
          mode: 'keyword',
          label: cleanLabel,
          terms: cleanDetail.split(',').map((term) => term.trim()).filter(Boolean),
          enabled: true,
        };
    void persist({ alertWatches: [...settings.alertWatches, watch] }, true);
  });

  return section(c.watches, c.watchesSub, [
    list,
    node('div', { class: 'row' }, [mode, label, detail, add]),
  ], true);
}

function render(): void {
  const c = copy();
  saveState = node('div', { class: 'save-state is-ok', text: c.saved });
  const logo = node('img') as HTMLImageElement;
  logo.src = chrome.runtime.getURL('public/icons/icon-128.png');
  root.replaceChildren(node('div', { class: 'page' }, [
    node('header', { class: 'hero' }, [
      logo,
      node('div', {}, [
        node('h1', { text: `MeetSync — ${c.title}` }),
        node('p', { text: c.subtitle }),
      ]),
      saveState,
    ]),
    node('div', { class: 'grid' }, [
      generalSection(),
      captureSection(),
      exportSection(),
      aiSection(),
      nvidiaSection(),
      watchesSection(),
    ]),
  ]));
  document.body.dataset.optionsReady = 'true';
}

async function init(): Promise<void> {
  settings = await loadSettings();
  locale = resolveLocale(settings.locale);
  document.documentElement.lang = locale === 'pt' ? 'pt-BR' : locale;
  render();
}

void init();
