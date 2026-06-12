// LinkedIn PostExtraktor – Content Script
// Klappt alle Kommentare/Antworten des geöffneten Posts aus und extrahiert
// Post + Kommentarbaum als Markdown. Kommuniziert mit dem Popup über
// chrome.runtime-Messages; das Ergebnis landet zusätzlich in
// chrome.storage.local, falls das Popup zwischenzeitlich geschlossen wurde.

(() => {
  if (window.__liPostExtraktor) return;
  window.__liPostExtraktor = true;

  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

  let cancelled = false;
  let running = false;
  let includeImages = true;

  // ---------------------------------------------------------------- Messaging

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === 'lipx-ping') {
      sendResponse({ ok: true, running });
      return;
    }
    if (msg?.action === 'lipx-cancel') {
      cancelled = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg?.action === 'lipx-extract') {
      if (!running) {
        cancelled = false;
        includeImages = msg.options?.images !== false;
        run().catch((err) => reportError(err?.message || String(err)));
      }
      sendResponse({ ok: true, alreadyRunning: running });
    }
  });

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) {
      /* Popup geschlossen – egal, Status liegt auch im Storage */
    }
  }

  function report(text) {
    safeSend({ type: 'lipx-progress', text });
  }

  function reportError(text) {
    running = false;
    chrome.storage.local.set({ lipx_state: 'error', lipx_error: text });
    safeSend({ type: 'lipx-error', text });
  }

  // ------------------------------------------------------------------ Helpers

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return (el?.innerText || '').replace(/ /g, ' ').trim();
  }

  // LinkedIn dupliziert Namen oft in einem aria-hidden-Span:
  // "Max MustermannMax Mustermann" -> "Max Mustermann"
  function dedupeName(s) {
    if (!s) return s;
    const half = Math.floor(s.length / 2);
    if (s.length % 2 === 0 && s.slice(0, half) === s.slice(half)) {
      return s.slice(0, half).trim();
    }
    return s;
  }

  function stripSeeMore(s) {
    return (s || '')
      .replace(/(…\s*)?(mehr anzeigen|see more|show more|weniger anzeigen|see less)\s*$/i, '')
      .trim();
  }

  // Schutz vor Endlosschleifen: jedes Button-Element maximal 3-mal klicken.
  // (LinkedIn rendert echte Nachlade-Buttons neu, die bekommen frische Zähler.)
  const clickCounts = new WeakMap();
  function tryClick(b) {
    const n = clickCounts.get(b) || 0;
    if (n >= 3) return false;
    clickCounts.set(b, n + 1);
    b.click();
    return true;
  }

  // ---------------------------------------------------------------- Bilder

  // Avatare, Emojis, Reaktions-Icons und Profilfotos aussortieren
  function isContentImage(img) {
    const src = img.currentSrc || img.src || '';
    if (!/^https?:\/\//.test(src)) return false;
    if (/profile-displayphoto|profile-framedphoto|EntityPhoto|ghost-person|emoji|reactions?-|company-logo/i.test(src)) {
      return false;
    }
    if (/avatar|presence|profile/i.test(img.className)) return false;
    const r = img.getBoundingClientRect();
    // Kleine Icons raus; naturalWidth als Fallback für nicht gerenderte Bilder
    if (r.width > 0 && r.width < 80 && img.naturalWidth < 160) return false;
    return true;
  }

  function imageUrl(img) {
    return img.currentSrc || img.src || img.getAttribute('data-delayed-url') || '';
  }

  // Bilder des Posts selbst (ohne Kommentarbereich)
  function collectPostImages(root) {
    if (!includeImages) return [];
    const candidates = [
      ...root.querySelectorAll(
        '.update-components-image img, .update-components-carousel img, ' +
          '.feed-shared-image img, .feed-shared-carousel img, ' +
          '[class*="update-components-mini-update"] img'
      ),
    ];
    // Fallback: großflächige Bilder im Post-Bereich
    if (!candidates.length) {
      candidates.push(
        ...[...root.querySelectorAll('img')].filter((img) => {
          if (img.closest('.comments-comments-list, [class*="comment"]')) return false;
          if (img.closest('[class*="actor"], [class*="social-details"]')) return false;
          const r = img.getBoundingClientRect();
          return r.width >= 200 || img.naturalWidth >= 400;
        })
      );
    }
    const urls = [];
    for (const img of candidates) {
      if (img.closest('.comments-comments-list')) continue;
      if (!isContentImage(img)) continue;
      const src = imageUrl(img);
      if (src && !urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  // Bilder eines einzelnen Kommentars (ohne die seiner verschachtelten Replies)
  function collectCommentImages(el) {
    if (!includeImages) return [];
    const sel =
      'article.comments-comment-entity, article.comments-comment-item, .comments-comment-item';
    const urls = [];
    for (const img of el.querySelectorAll('img')) {
      if (img.closest(sel) !== el) continue; // gehört zu einem Reply
      if (!isContentImage(img)) continue;
      const src = imageUrl(img);
      if (src && !urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  function buttonsIn(scope) {
    return [...(scope || document).querySelectorAll('button')].filter((b) => {
      if (!isVisible(b)) return false;
      // Nichts im Kommentar-Editor anklicken
      if (b.closest('.comments-comment-box, .comments-comment-texteditor, form')) return false;
      return true;
    });
  }

  // ------------------------------------------------------- Button-Erkennung

  const RE_LOAD_MORE_COMMENTS =
    /(weitere|mehr)\s+kommentare\s*(laden|anzeigen)?|load\s+(more|previous)\s+comments|show\s+more\s+comments|previous\s+comments/i;

  // Trifft "Vorherige Antworten anzeigen", "2 Antworten anzeigen", "1 Antwort",
  // "Show 3 replies", "Load previous replies" – aber NICHT den Aktions-Button
  // "Antworten" (Antwort verfassen) und nicht "Reply".
  const RE_EXPAND_REPLIES =
    /(vorherige|weitere|alle)\s+antwort(en)?(\s+(anzeigen|laden))?|\d+\s+antwort(en)?\b|antwort(en)?\s+anzeigen|(show|load|view)\s+(\d+\s+)?(previous\s+|more\s+|all\s+)?repl(y|ies)|\d+\s+repl(y|ies)\b|previous\s+replies/i;

  // LinkedIn nutzt je nach Kontext "… mehr", "mehr anzeigen", "see more"
  const RE_SEE_MORE = /^…?\s*(mehr anzeigen|mehr|see more|show more|more)\s*$/i;

  function findLoadMoreCommentButtons(scope) {
    const byClass = [
      ...scope.querySelectorAll(
        'button.comments-comments-list__load-more-comments-button, ' +
          'button[class*="load-more-comments"]'
      ),
    ].filter(isVisible);
    if (byClass.length) return byClass;
    return buttonsIn(scope).filter((b) => RE_LOAD_MORE_COMMENTS.test(textOf(b)));
  }

  function findReplyExpanderButtons(scope) {
    const byClass = [
      ...scope.querySelectorAll(
        'button.show-prev-replies, ' +
          'button[class*="show-prev-replies"], ' +
          'button[class*="replies-button"], ' +
          'button[class*="load-more-replies"]'
      ),
    ].filter(isVisible);
    const byText = buttonsIn(scope).filter((b) => {
      const t = textOf(b);
      if (!t || t.length > 60) return false;
      // Reiner Aktions-Button "Antworten"/"Reply" ausschließen
      if (/^(antworten|reply)$/i.test(t)) return false;
      return RE_EXPAND_REPLIES.test(t);
    });
    return [...new Set([...byClass, ...byText])];
  }

  function findSeeMoreButtons(scope) {
    const byClass = [
      ...scope.querySelectorAll(
        'button.feed-shared-inline-show-more-text__see-more-less-toggle, ' +
          'button[class*="see-more"]'
      ),
    ].filter((b) => isVisible(b) && !/weniger|less/i.test(textOf(b)));
    const byText = buttonsIn(scope).filter((b) => RE_SEE_MORE.test(textOf(b)));
    return [...new Set([...byClass, ...byText])];
  }

  // --------------------------------------------------- Sortierung umstellen

  // "Relevanteste" lädt nicht zwingend alle Kommentare nach – auf
  // "Neueste/Alle Kommentare" umstellen, damit wirklich alles kommt.
  async function ensureChronologicalSort(scope) {
    try {
      const toggle =
        scope.querySelector('button[class*="sort-order"], button[id*="sort"]') ||
        buttonsIn(scope).find(
          (b) =>
            /relevanteste|most relevant|top comments|relevant/i.test(textOf(b)) &&
            textOf(b).length < 40
        );
      if (!toggle) return;
      report('Stelle Kommentar-Sortierung um …');
      toggle.click();
      await SLEEP(700);
      const option = [
        ...document.querySelectorAll(
          '.artdeco-dropdown__content li, .artdeco-dropdown__content [role="button"], ' +
            '.artdeco-dropdown__content button, [role="menu"] [role="menuitem"], ' +
            '.artdeco-dropdown__item, [role="option"]'
        ),
      ].find(
        (el) =>
          isVisible(el) &&
          /neueste|alle kommentare|most recent|newest|all comments|chronolog/i.test(textOf(el))
      );
      if (option) {
        option.click();
        await SLEEP(1500);
        await waitForIdle(scope);
      } else {
        // Dropdown rendert seine Optionen nur auf echte (trusted) Klicks –
        // dann bleibt die Sortierung eben "Relevanteste". Für die
        // Vollständigkeit ist das unkritisch, alle Kommentare kommen über
        // "Weitere Kommentare laden". Dropdown wieder schließen:
        toggle.click();
        await SLEEP(300);
      }
    } catch (_) {
      /* best effort */
    }
  }

  async function waitForIdle(scope, timeout = 10000) {
    const t0 = Date.now();
    await SLEEP(400);
    while (Date.now() - t0 < timeout) {
      const spinner = (scope || document).querySelector(
        '.artdeco-loader, [class*="comments"][class*="loading"]'
      );
      if (!spinner || !isVisible(spinner)) return;
      await SLEEP(300);
    }
  }

  // --------------------------------------------------------------- Post-Root

  function findPostRoot() {
    const main = document.querySelector('main') || document.body;
    const candidates = [
      ...main.querySelectorAll(
        '.feed-shared-update-v2, [data-urn*="urn:li:activity"], [data-id*="urn:li:activity"]'
      ),
    ].filter(isVisible);
    return candidates[0] || main;
  }

  function commentsScope(root) {
    return (
      root.querySelector('.comments-comments-list') ||
      root.querySelector('[class*="comments-comment-list"]') ||
      root
    );
  }

  // ------------------------------------------------------------- Kommentare

  function commentSelector(root) {
    if (root.querySelector('article.comments-comment-entity')) {
      return 'article.comments-comment-entity';
    }
    if (root.querySelector('article.comments-comment-item')) {
      return 'article.comments-comment-item';
    }
    return '.comments-comment-item';
  }

  function getCommentElements(root) {
    return [...new Set(root.querySelectorAll(commentSelector(root)))];
  }

  function extractComment(el) {
    let name = textOf(
      el.querySelector(
        '.comments-comment-meta__description-title, ' +
          '.comments-post-meta__name-text, ' +
          '.comments-comment-meta__name, ' +
          '[class*="comment-meta"] [class*="title"]'
      )
    );
    name = dedupeName(name);
    const headline = textOf(
      el.querySelector(
        '.comments-comment-meta__description-subtitle, ' +
          '[class*="comment-meta"] [class*="subtitle"]'
      )
    );
    const time = textOf(el.querySelector('time'));
    const body = stripSeeMore(
      textOf(
        el.querySelector(
          '.comments-comment-item__main-content, ' +
            '.comments-comment-entity__content, ' +
            '.update-components-text'
        )
      )
    );
    const reactions = textOf(el.querySelector('[class*="reactions-count"]'));
    const images = collectCommentImages(el);
    return { name, headline, time, body, reactions, images };
  }

  // LinkedIn VIRTUALISIERT lange Kommentarlisten: beim Scrollen fliegen
  // Off-Screen-Kommentare aus dem DOM. Deshalb wird in jeder Runde geerntet
  // und per Kommentar-URN (data-id) in einer Map akkumuliert – am Ende steht
  // dort auch, was nicht mehr im DOM ist.
  const harvested = new Map();
  let harvestSeq = 0;

  function commentKey(el, data) {
    return (
      el.getAttribute('data-id') ||
      el.id ||
      `anon:${data.name}|${data.time}|${(data.body || '').slice(0, 60)}`
    );
  }

  function harvestComments(scope) {
    const sel = commentSelector(scope);
    for (const el of scope.querySelectorAll(sel)) {
      const data = extractComment(el);
      if (!data.name && !data.body) continue; // Skeleton/Platzhalter
      const key = commentKey(el, data);
      const parentEl = el.parentElement?.closest(sel);
      const parentKey = parentEl
        ? commentKey(parentEl, extractComment(parentEl))
        : null;
      const isReplyClass = /--reply\b|(^|[\s_-])reply([\s_-]|$)/i.test(el.className);
      const prev = harvested.get(key);
      harvested.set(key, {
        key,
        parentKey: parentKey || prev?.parentKey || null,
        seq: prev?.seq ?? harvestSeq++,
        isReplyClass: isReplyClass || prev?.isReplyClass || false,
        // Längerer Body gewinnt (nach "… mehr"-Expansion), Bilder vereinigen
        data: (() => {
          const best =
            prev && (prev.data.body || '').length > (data.body || '').length
              ? prev.data
              : data;
          const images = [...new Set([...(prev?.data.images || []), ...(data.images || [])])];
          return { ...best, images };
        })(),
      });
    }
    return harvested.size;
  }

  // Baut den Kommentarbaum aus der Ernte-Map: parentKey -> Kinder;
  // "--reply"-Klasse als Fallback dem letzten Top-Level-Kommentar.
  function buildCommentTree() {
    const items = [...harvested.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((h) => ({ ...h, children: [] }));
    const byKey = new Map(items.map((i) => [i.key, i]));
    const roots = [];
    let lastTop = null;
    for (const item of items) {
      const parent = item.parentKey ? byKey.get(item.parentKey) : null;
      if (parent && parent !== item) {
        parent.children.push(item);
        continue;
      }
      if (item.isReplyClass && lastTop) {
        lastTop.children.push(item);
      } else {
        roots.push(item);
        lastTop = item;
      }
    }
    return roots;
  }

  function countTree(roots) {
    let top = 0;
    let replies = 0;
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        if (depth === 0) top++;
        else replies++;
        walk(n.children, depth + 1);
      }
    };
    walk(roots, 0);
    return { top, replies, total: top + replies };
  }

  // ----------------------------------------------------------------- Post

  function extractPost(root) {
    // Der Actor-Container heißt je nach Version ".update-components-actor"
    // oder "...__container" – die inneren Klassen sind stabil, daher root als
    // Fallback-Scope.
    const actor = root.querySelector('.update-components-actor') || root;
    const pick = (scope, sel) => {
      const el = scope?.querySelector(sel);
      const hidden = el?.querySelector('span[aria-hidden="true"]');
      return textOf(hidden || el);
    };
    // Nur erste Zeile, ohne "• 2."-Verbindungsgrad-Badge
    const name = dedupeName(
      pick(actor, '.update-components-actor__title').split('\n')[0].split('•')[0].trim()
    );
    const headline = pick(actor, '.update-components-actor__description')
      .replace(/\n+/g, ' ')
      .trim();
    const timeText = pick(actor, '.update-components-actor__sub-description')
      .split('•')[0]
      .trim();
    const body = stripSeeMore(
      textOf(
        root.querySelector('.update-components-text, .feed-shared-inline-show-more-text')
      )
    );

    const socialBar = root.querySelector('.social-details-social-counts');
    const reactions = textOf(
      socialBar?.querySelector('[class*="reactions-count"]')
    );
    const socialText = textOf(socialBar);
    const declaredComments =
      socialText.match(/(\d[\d., ]*)\s*Kommentar/i)?.[1]?.trim() ||
      socialText.match(/(\d[\d., ]*)\s*comment/i)?.[1]?.trim() ||
      '';
    const reposts =
      socialText.match(/(\d[\d., ]*)\s*(?:Mal geteilt|repost)/i)?.[1]?.trim() || '';

    return {
      name,
      headline,
      timeText,
      body,
      reactions,
      declaredComments,
      reposts,
      images: collectPostImages(root),
      url: location.origin + location.pathname,
    };
  }

  // ------------------------------------------------------------- Markdown

  function quoted(text, depth) {
    const prefix = '> '.repeat(depth);
    return text
      .split('\n')
      .map((l) => (prefix + l).trimEnd())
      .join('\n');
  }

  function imageLines(urls) {
    return (urls || []).map((u, i) => `![Bild ${i + 1}](${u})`);
  }

  function renderComment(node, depth) {
    const c = node.data;
    const metaParts = [];
    if (c.time) metaParts.push(c.time);
    if (c.reactions) metaParts.push(`${c.reactions} Reaktionen`);
    const meta = metaParts.length ? `*${metaParts.join(' · ')}*` : '';
    const imgs = imageLines(c.images);

    let block;
    if (depth === 0) {
      const head = `### ${c.name || 'Unbekannt'}`;
      const sub = c.headline ? `*${c.headline}*` : '';
      block = [head, sub, meta, '', c.body || '*(kein Text)*', ...imgs]
        .filter((l, i) => l !== '' || i === 3)
        .join('\n');
    } else {
      const head = `**↳ ${c.name || 'Unbekannt'}**${c.headline ? ` — *${c.headline}*` : ''}`;
      const inner = [head, meta, '', c.body || '*(kein Text)*', ...imgs]
        .filter((l, i) => l !== '' || i === 2)
        .join('\n');
      block = quoted(inner, depth);
    }

    const childBlocks = node.children.map((ch) => renderComment(ch, depth + 1));
    return [block, ...childBlocks].join('\n\n');
  }

  function buildMarkdown(post, tree, counts) {
    const lines = [];
    lines.push(`# LinkedIn-Post von ${post.name || 'Unbekannt'}`);
    lines.push('');
    if (post.headline) lines.push(`**Autor:** ${post.name} — ${post.headline}  `);
    else if (post.name) lines.push(`**Autor:** ${post.name}  `);
    if (post.timeText) lines.push(`**Veröffentlicht:** ${post.timeText}  `);
    lines.push(`**URL:** ${post.url}  `);
    const stats = [];
    if (post.reactions) stats.push(`${post.reactions} Reaktionen`);
    if (post.declaredComments) stats.push(`${post.declaredComments} Kommentare`);
    if (post.reposts) stats.push(`${post.reposts} Mal geteilt`);
    if (stats.length) lines.push(`**Engagement:** ${stats.join(' · ')}  `);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(post.body || '*(kein Post-Text gefunden)*');
    if (post.images?.length) {
      lines.push('');
      lines.push(...imageLines(post.images));
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(
      `## Kommentare (${counts.top}${counts.replies ? ` + ${counts.replies} Antworten` : ''})`
    );
    lines.push('');
    for (const node of tree) {
      lines.push(renderComment(node, 0));
      lines.push('');
    }
    lines.push('---');
    const now = new Date();
    lines.push(
      `*Exportiert am ${now.toLocaleDateString('de-DE')} um ${now.toLocaleTimeString('de-DE')} ` +
        `mit LinkedIn PostExtraktor · ${counts.total} Kommentare erfasst` +
        (post.declaredComments ? ` (LinkedIn meldet ${post.declaredComments})` : '') +
        '*'
    );
    return lines.join('\n');
  }

  // ------------------------------------------------------------- Hauptlauf

  async function run() {
    running = true;
    harvested.clear();
    harvestSeq = 0;
    await chrome.storage.local.set({ lipx_state: 'running', lipx_error: null });
    report('Suche Post auf der Seite …');

    const root = findPostRoot();
    if (!root) {
      reportError('Kein LinkedIn-Post auf dieser Seite gefunden.');
      return;
    }

    // Post-Text ausklappen
    for (const b of findSeeMoreButtons(root)) {
      b.click();
      await SLEEP(150);
    }

    const cScope = commentsScope(root);
    await ensureChronologicalSort(cScope === root ? root : cScope.parentElement || root);

    // Expansions-Schleife: so lange klicken/scrollen, bis 3 Runden lang
    // nichts Neues mehr kommt.
    let stableRounds = 0;
    let rounds = 0;
    let lastCount = 0;
    while (!cancelled && rounds < 600) {
      rounds++;
      let acted = 0;

      // "Weitere Kommentare laden"
      for (const b of findLoadMoreCommentButtons(cScope).slice(0, 2)) {
        b.scrollIntoView({ block: 'center' });
        await SLEEP(150);
        if (!tryClick(b)) continue;
        acted++;
        await waitForIdle(cScope);
      }

      // Versteckte Antworten ausklappen
      for (const b of findReplyExpanderButtons(cScope).slice(0, 6)) {
        b.scrollIntoView({ block: 'center' });
        await SLEEP(100);
        if (!tryClick(b)) continue;
        acted++;
        await SLEEP(350);
      }
      if (acted) await waitForIdle(cScope);

      // Gekürzte Kommentartexte ("… mehr anzeigen") ausklappen
      for (const b of findSeeMoreButtons(cScope)) {
        if (!tryClick(b)) continue;
        acted++;
        await SLEEP(60);
      }

      // Ernten, BEVOR die Virtualisierung beim Weiterscrollen Kommentare
      // aus dem DOM entfernt
      const count = harvestComments(cScope);

      // Scrollen, um Lazy-Loading anzustoßen
      const els = getCommentElements(cScope);
      if (els.length) {
        els[els.length - 1].scrollIntoView({ block: 'center' });
      } else {
        window.scrollBy(0, 800);
      }

      report(`Klappe Kommentare aus … ${count} erfasst (Runde ${rounds})`);

      if (acted === 0 && count === lastCount) {
        stableRounds++;
        window.scrollBy(0, 600);
      } else {
        stableRounds = 0;
      }
      lastCount = count;
      if (stableRounds >= 3) break;
      await SLEEP(650);
    }

    // Finaler Sweep: wegen der DOM-Virtualisierung einmal komplett von oben
    // nach unten durch die Kommentarliste scrollen und alles einsammeln, was
    // zwischendurch aus dem DOM geflogen ist.
    report('Finaler Durchlauf – sammle alle Kommentare ein …');
    const firstComment = getCommentElements(cScope)[0];
    (firstComment || cScope).scrollIntoView({ block: 'start' });
    await SLEEP(500);
    let lastY = -1;
    for (let step = 0; step < 300 && !cancelled; step++) {
      harvestComments(cScope);
      // frisch gerenderte gekürzte Texte und versteckte Antworten nachziehen
      let acted = 0;
      for (const b of findSeeMoreButtons(cScope)) {
        if (tryClick(b)) acted++;
      }
      for (const b of findReplyExpanderButtons(cScope).slice(0, 4)) {
        if (tryClick(b)) acted++;
      }
      if (acted) {
        await SLEEP(700);
        harvestComments(cScope);
      }
      window.scrollBy(0, Math.round(window.innerHeight * 0.6));
      await SLEEP(350);
      if (window.scrollY === lastY) break; // unten angekommen
      lastY = window.scrollY;
      if (step % 5 === 0) {
        report(`Finaler Durchlauf … ${harvested.size} Kommentare erfasst`);
      }
    }

    report('Extrahiere Inhalte …');
    harvestComments(cScope);
    const post = extractPost(root);
    const tree = buildCommentTree();
    const counts = countTree(tree);
    const markdown = buildMarkdown(post, tree, counts);

    // Alle Bild-URLs in Dokument-Reihenfolge – das Popup lädt sie im
    // Speichern-Modus herunter und ersetzt die URLs durch relative Pfade.
    const allImages = [...(post.images || [])];
    const collectImgs = (nodes) => {
      for (const n of nodes) {
        for (const u of n.data.images || []) {
          if (!allImages.includes(u)) allImages.push(u);
        }
        collectImgs(n.children);
      }
    };
    collectImgs(tree);

    const result = {
      markdown,
      images: allImages,
      stats: {
        author: post.name || 'linkedin-post',
        topLevel: counts.top,
        replies: counts.replies,
        total: counts.total,
        declared: post.declaredComments,
        images: allImages.length,
        chars: markdown.length,
        cancelled,
      },
      url: post.url,
      ts: Date.now(),
    };

    running = false;
    await chrome.storage.local.set({ lipx_state: 'done', lipx_result: result });
    safeSend({ type: 'lipx-done', result });
  }
})();
