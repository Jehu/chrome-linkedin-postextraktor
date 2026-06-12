// LinkedIn PostExtraktor – Popup
// Injiziert den Content-Script in den aktiven LinkedIn-Tab, zeigt den
// Fortschritt an und kopiert/speichert das fertige Markdown.

const $ = (id) => document.getElementById(id);

let tabId = null;
let mode = null; // 'copy' | 'save'
let lastResult = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('copyBtn').addEventListener('click', () => start('copy'));
  $('saveBtn').addEventListener('click', () => start('save'));
  $('cancelBtn').addEventListener('click', cancel);

  // Bilder-Option laden und Änderungen persistieren (Standard: an)
  chrome.storage.local.get('lipx_opt_images').then((st) => {
    $('imagesOpt').checked = st.lipx_opt_images !== false;
  });
  $('imagesOpt').addEventListener('change', () => {
    chrome.storage.local.set({ lipx_opt_images: $('imagesOpt').checked });
  });
  $('copyAgainBtn').addEventListener('click', () => lastResult && copyToClipboard(lastResult));
  $('saveAgainBtn').addEventListener('click', () => lastResult && downloadMarkdown(lastResult));

  chrome.runtime.onMessage.addListener(onMessage);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  if (!/^https:\/\/([a-z]+\.)?linkedin\.com\//.test(tab?.url || '')) {
    showHint('Bitte öffne zuerst einen LinkedIn-Post (linkedin.com/posts/… oder linkedin.com/feed/update/…) und klicke dann erneut auf das Icon.');
    $('copyBtn').disabled = true;
    $('saveBtn').disabled = true;
    return;
  }

  // Läuft noch eine Extraktion bzw. liegt ein frisches Ergebnis vor?
  const st = await chrome.storage.local.get(['lipx_state', 'lipx_result', 'lipx_mode', 'lipx_error']);
  mode = st.lipx_mode || null;

  if (st.lipx_state === 'running') {
    const alive = await ping();
    if (alive) {
      showProgress('Extraktion läuft noch …');
    } else {
      await chrome.storage.local.set({ lipx_state: null });
    }
  } else if (
    st.lipx_state === 'done' &&
    st.lipx_result &&
    Date.now() - st.lipx_result.ts < 15 * 60 * 1000
  ) {
    lastResult = st.lipx_result;
    showResult(
      `Letztes Ergebnis (${formatStats(lastResult.stats)}) liegt bereit.`,
      lastResult.stats
    );
  } else if (st.lipx_state === 'error' && st.lipx_error) {
    showError(st.lipx_error);
  }
}

function ping() {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(false);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'lipx-ping' }, (resp) => {
        void chrome.runtime.lastError;
        resolve(Boolean(resp?.ok && resp?.running));
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function start(m) {
  mode = m;
  await chrome.storage.local.set({ lipx_mode: m, lipx_state: null, lipx_result: null, lipx_error: null });
  showProgress('Starte Extraktion …');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(
      tabId,
      { action: 'lipx-extract', options: { images: $('imagesOpt').checked } },
      () => void chrome.runtime.lastError
    );
  } catch (err) {
    showError('Konnte den Content-Script nicht laden: ' + (err?.message || err));
  }
}

function cancel() {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { action: 'lipx-cancel' }, () => void chrome.runtime.lastError);
  $('progressText').textContent = 'Breche ab – exportiere bisherigen Stand …';
}

function onMessage(msg) {
  if (msg?.type === 'lipx-progress') {
    showProgress(msg.text);
  } else if (msg?.type === 'lipx-done') {
    handleDone(msg.result);
  } else if (msg?.type === 'lipx-error') {
    showError(msg.text);
  }
}

async function handleDone(result) {
  lastResult = result;
  if (mode === 'save') {
    downloadMarkdown(result);
    showResult(`✓ Datei gespeichert.\n${formatStats(result.stats)}`, result.stats);
  } else {
    const ok = await copyToClipboard(result);
    if (ok) {
      showResult(`✓ In die Zwischenablage kopiert.\n${formatStats(result.stats)}`, result.stats);
    } else {
      showResult(
        `Extraktion fertig (${formatStats(result.stats)}), aber das Kopieren schlug fehl – bitte unten erneut versuchen.`,
        result.stats
      );
    }
  }
}

async function copyToClipboard(result) {
  try {
    await navigator.clipboard.writeText(result.markdown);
    return true;
  } catch (_) {
    // Fallback über verstecktes Textfeld
    try {
      const ta = document.createElement('textarea');
      ta.value = result.markdown;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
}

function downloadMarkdown(result) {
  const images = result.images || [];

  // Ohne Bilder: einfacher Einzeldatei-Download wie gehabt
  if (!images.length || !chrome.downloads) {
    downloadBlob(result.markdown, buildFilename(result));
    return;
  }

  // Mit Bildern: alles in einen Unterordner linkedin-export/<post>/ legen,
  // Bilder über chrome.downloads (kein CORS-Problem, Browser lädt direkt)
  // und die CDN-URLs im Markdown durch relative Pfade ersetzen.
  const base = buildFilename(result).replace(/\.md$/, '');
  const folder = `linkedin-export/${base}`;
  let md = result.markdown;
  images.forEach((url, i) => {
    const name = `${base}-bild-${String(i + 1).padStart(2, '0')}.jpg`;
    md = md.split(url).join(`./${name}`);
    chrome.downloads.download({ url, filename: `${folder}/${name}`, conflictAction: 'uniquify' });
  });
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url: blobUrl, filename: `${folder}/${base}.md`, conflictAction: 'uniquify' },
    () => {
      void chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }
  );
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function buildFilename(result) {
  const slug = (result.stats?.author || 'linkedin-post')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'linkedin-post';
  const d = new Date(result.ts || Date.now());
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `linkedin-${slug}-${date}.md`;
}

function formatStats(stats) {
  if (!stats) return '';
  let s = `${stats.topLevel} Kommentare`;
  if (stats.replies) s += ` + ${stats.replies} Antworten`;
  if (stats.images) s += ` · ${stats.images} Bilder`;
  if (stats.throttled) s += ' (LinkedIn drosselt – Teilergebnis)';
  else if (stats.cancelled) s += ' (abgebrochen, Teilergebnis)';
  return s;
}

const THROTTLE_TEXT = {
  checkpoint:
    '⚠️ LinkedIn hat auf eine Sicherheits-/Login-Seite umgeleitet. Der Export wurde gestoppt; nur der bis dahin geladene Stand ist enthalten. Bitte einige Zeit warten, normal weiterbrowsen und es später erneut versuchen.',
  banner:
    '⚠️ LinkedIn meldet eine Einschränkung (z. B. zu viele Anfragen). Der Export wurde schonend abgebrochen – das Teilergebnis ist gespeichert. Bitte eine Weile warten, bevor du es erneut versuchst.',
  stall:
    '⚠️ LinkedIn lieferte mehrfach keine weiteren Kommentare nach (möglicherweise Drosselung). Der Export wurde gestoppt; das Teilergebnis ist enthalten. Etwas warten und später erneut versuchen.',
};

// ----------------------------------------------------------------- UI-States

function showHint(text) {
  $('hint').textContent = text;
  $('hint').classList.remove('hidden');
}

function showProgress(text) {
  $('actions').classList.add('hidden');
  $('result').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('progressText').textContent = text;
}

function showResult(text, stats) {
  $('progress').classList.add('hidden');
  $('actions').classList.remove('hidden');
  $('result').classList.remove('hidden');
  const rt = $('resultText');
  rt.textContent = text;
  rt.classList.remove('error');

  const warn = $('resultWarn');
  const declared = parseInt(String(stats?.declared || '').replace(/[^\d]/g, ''), 10);
  if (stats?.throttled && THROTTLE_TEXT[stats.throttled]) {
    // Drossel-Hinweis hat Vorrang vor dem reinen Zahlen-Mismatch
    warn.textContent = THROTTLE_TEXT[stats.throttled];
    warn.classList.remove('hidden');
  } else if (declared && stats && declared > stats.total) {
    warn.textContent = `⚠️ LinkedIn meldet ${declared} Kommentare, erfasst wurden ${stats.total}. Eventuell wurden gelöschte/eingeschränkte Kommentare mitgezählt – oder es konnte nicht alles geladen werden.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

function showError(text) {
  $('progress').classList.add('hidden');
  $('actions').classList.remove('hidden');
  $('result').classList.remove('hidden');
  $('resultWarn').classList.add('hidden');
  const rt = $('resultText');
  rt.textContent = '✗ ' + text;
  rt.classList.add('error');
}
