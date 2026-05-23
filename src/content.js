(function () {
  'use strict';

  const previousRuntime = globalThis.__MBE_CONTENT_RUNTIME__;
  if (previousRuntime && typeof previousRuntime.dispose === 'function') {
    try {
      previousRuntime.dispose();
    } catch (error) {
      // A reloaded extension can leave an invalidated old context behind.
    }
  }

  const runtimeState = {
    disposed: false,
    dispose: null,
  };
  globalThis.__MBE_CONTENT_RUNTIME__ = runtimeState;

  const { browser, constants, normalize, text } = MBE;
  const t = MBE.i18n && MBE.i18n.t ? MBE.i18n.t : (key) => key;
  const log = MBE.debug.createLogger('content');
  const parsers = MBE.parsers;

  const ADAPTERS = {
    hitmoz: {
      name: 'hitmoz',
      matches(hostname) {
        return /(^|\.)hitmoz\.(com|org|net)$/i.test(hostname);
      },
      extract(document, scopeContext) {
        return parsers.extractHitmozTracks(document, scopeContext);
      },
      extractScope(document, url) {
        if (!/^\/artist\/\d+/.test(url.pathname)) {
          return null;
        }

        const h1 = document.querySelector('h1');
        const h1Text = h1 ? normalize.whitespace(h1.textContent || '') : '';
        const h1Cleaned = h1Text
          .replace(/\s+(слушать|скачать|песни|трек[иов]*|музыка|mp3|онлайн).*$/i, '')
          .trim();
        if (h1Cleaned) {
          return h1Cleaned;
        }

        const counts = new Map();
        for (const row of Array.from(document.querySelectorAll('li.tracks__item[data-musmeta]'))) {
          let musMeta = null;
          try {
            musMeta = JSON.parse(row.getAttribute('data-musmeta') || '');
          } catch (e) {}
          const descEl = row.querySelector('.track__desc');
          const rawArtist = normalize.whitespace(
            (musMeta && musMeta.artist) ||
            (descEl && (descEl.innerText || descEl.textContent)) ||
            '',
          );
          if (rawArtist) {
            counts.set(rawArtist, (counts.get(rawArtist) || 0) + 1);
          }
        }
        let bestArtist = '';
        let bestCount = 0;
        for (const [artist, count] of counts.entries()) {
          if (count > bestCount) {
            bestArtist = artist;
            bestCount = count;
          }
        }
        return bestArtist || null;
      },
    },
    mp3party: {
      name: 'mp3party',
      matches(hostname) {
        return /(^|\.)mp3party\.net$/i.test(hostname);
      },
      extract(document, scopeContext) {
        return parsers.extractMp3partyTracks(document, scopeContext);
      },
      extractScope(document, url) {
        if (/^\/artist\/\d+/.test(url.pathname)) {
          const h1 = document.querySelector('h1');
          const raw = h1 ? normalize.whitespace(h1.textContent) : '';
          const cleaned = raw.replace(/\s+скачать.*$/i, '').trim();
          return cleaned || null;
        }
        return null;
      },
    },
    themp3: {
      name: 'themp3.info',
      matches(hostname) {
        return /(^|\.)themp3\.info$/i.test(hostname);
      },
      extract(document, scopeContext) {
        return parsers.extractTheMp3Tracks(document, scopeContext);
      },
    },
    ligaudio: {
      name: 'web.ligaudio.ru',
      matches(hostname) {
        return /(^|\.)ligaudio\.ru$/i.test(hostname);
      },
      extract(document, scopeContext) {
        return parsers.extractLigAudioTracks(document, scopeContext);
      },
      extractScope(document, url) {
        const h1 = document.querySelector('h1');
        const h1Text = h1 ? normalize.whitespace(h1.textContent || '') : '';
        if (h1Text) {
          return h1Text;
        }

        const titlePart = normalize.whitespace(document.title || '').split(/\s*[|—–-]\s*/)[0];
        if (titlePart) {
          return titlePart;
        }

        const match = url.pathname.match(/^\/mp3\/([^/]+)(?:\/\d+)?\/?$/i);
        if (!match) {
          return null;
        }
        try {
          return decodeURIComponent(match[1].replace(/\+/g, ' '));
        } catch (_error) {
          return match[1].replace(/\+/g, ' ');
        }
      },
    },
    mailru: {
      name: 'my.mail.ru',
      matches(hostname) {
        return /(^|\.)mail\.ru$/i.test(hostname);
      },
      extract(document, scopeContext) {
        return parsers.extractMailRuTracks(document, scopeContext);
      },
    },
    vk: {
      name: 'vk.com',
      matches(hostname) {
        return hostname === 'vk.com' || hostname === 'vk.ru';
      },
      extract(document, scopeContext) {
        return parsers.extractVkTracks(document, scopeContext);
      },
      extractScope(document, url) {
        const hashStr = url.hash ? url.hash.slice(1) : '';
        if (hashStr && !url.searchParams.get('q')) {
          try {
            const q = new URLSearchParams(hashStr).get('q');
            if (q && q.trim()) return normalize.whitespace(q);
          } catch (e) {}
        }
        return null;
      },
    },
    universal: {
      name: 'universal',
      matches() {
        return true;
      },
      extract(document, scopeContext) {
        return parsers.extractGenericTracks(document, scopeContext);
      },
    },
  };

  let enabled = false;
  let debugEnabled = false;
  let activationId = '';
  let running = false;
  let observer = null;
  let debounceTimer = null;
  let errorBanner = null;
  let pendingProcess = false;
  let lastProcessSignature = '';
  let lastProcessResults = null;
  // Per-page-load classification cache: baseKey -> 'new' | 'variant'.
  // Survives mail.ru-style row re-renders so our colour stays after the DOM swap,
  // even when storage already sees the track as a duplicate.
  let pageStatusCache = new Map();
  let pageStatusUrl = '';

  function pageHostname() {
    return new URL(location.href).hostname;
  }

  function getAdapter() {
    const hostname = pageHostname();
    for (const key of ['hitmoz', 'mp3party', 'themp3', 'ligaudio', 'mailru', 'vk']) {
      if (ADAPTERS[key].matches(hostname)) {
        return ADAPTERS[key];
      }
    }
    return ADAPTERS.universal;
  }

  function injectStyles() {
    if (document.getElementById('mbe-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'mbe-styles';
    style.textContent = `
      .${constants.ACTIVE_CLASS_NEW},
      .${constants.ACTIVE_CLASS_VARIANT},
      .${constants.ACTIVE_CLASS_DUPLICATE} {
        outline-offset: 0 !important;
        border-radius: 6px !important;
        margin-top: 6px !important;
        margin-bottom: 6px !important;
      }

      .${constants.ACTIVE_CLASS_NEW} {
        outline: 3px solid rgba(34, 197, 94, 0.8) !important;
      }

      .${constants.ACTIVE_CLASS_VARIANT} {
        outline: 1.5px dashed rgba(227, 68, 211, 0.7) !important;
      }

      .${constants.ACTIVE_CLASS_DUPLICATE} {
        outline: 3px solid rgba(107, 114, 128, 0.7) !important;
      }

      .${constants.ACTIVE_CLASS_NEW}.mbe-border-thin,
      .${constants.ACTIVE_CLASS_DUPLICATE}.mbe-border-thin {
        outline-width: 2px !important;
      }

      #mbe-error-banner {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        max-width: min(420px, calc(100vw - 32px));
        padding: 12px 14px;
        border-radius: 10px;
        background: rgba(20, 20, 20, 0.95);
        color: #fff;
        font: 13px/1.4 system-ui, sans-serif;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.15);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clearPageClasses() {
    const selector = [
      `.${constants.ACTIVE_CLASS_NEW}`,
      `.${constants.ACTIVE_CLASS_VARIANT}`,
      `.${constants.ACTIVE_CLASS_DUPLICATE}`,
    ].join(',');
    document.querySelectorAll(selector).forEach((el) => {
      el.classList.remove(constants.ACTIVE_CLASS_NEW, constants.ACTIVE_CLASS_VARIANT, constants.ACTIVE_CLASS_DUPLICATE, 'mbe-border-thin');
    });
  }

  function clearPageStatusCache() {
    pageStatusCache = new Map();
    pageStatusUrl = '';
    lastProcessSignature = '';
    lastProcessResults = null;
  }

  function setDebugEnabled(value) {
    debugEnabled = Boolean(value);
    log.setEnabled(debugEnabled);
    log.info('debug mode', debugEnabled ? 'enabled' : 'disabled', {
      activationId,
      href: location.href,
      readyState: document.readyState,
    });
    if (!debugEnabled) {
      document.querySelectorAll(`.${constants.ACTIVE_CLASS_DUPLICATE}`).forEach((el) => {
        el.classList.remove(constants.ACTIVE_CLASS_DUPLICATE);
      });
    }
  }

  function diag(event, details) {
    if (!debugEnabled) {
      return;
    }
    console.log('[MusicBrowserExt:content]', event, {
      activationId,
      href: location.href,
      ...details,
    });
  }

  function showError(message) {
    injectStyles();
    if (!errorBanner) {
      errorBanner = document.createElement('div');
      errorBanner.id = 'mbe-error-banner';
      document.documentElement.appendChild(errorBanner);
    }
    errorBanner.textContent = `MusicBrowserExt: ${message}`;
  }

  function hideError() {
    if (errorBanner) {
      errorBanner.remove();
      errorBanner = null;
    }
  }

  function selectPrimaryTracks(tracks) {
    const primaryByDomKey = new Map();
    const primaryTracks = [];

    for (const track of tracks) {
      const domKey = track && track.domKey ? String(track.domKey) : '';
      if (!domKey) {
        primaryTracks.push(track);
        continue;
      }

      const current = primaryByDomKey.get(domKey);
      if (!current) {
        primaryByDomKey.set(domKey, track);
        continue;
      }

      const currentPriority = Number(current.renderPriority || 0) || 0;
      const nextPriority = Number(track.renderPriority || 0) || 0;
      if (nextPriority > currentPriority) {
        primaryByDomKey.set(domKey, track);
      }
    }

    const selectedDomKeys = new Set();
    for (const track of tracks) {
      const domKey = track && track.domKey ? String(track.domKey) : '';
      if (!domKey) {
        continue;
      }
      if (selectedDomKeys.has(domKey)) {
        continue;
      }
      selectedDomKeys.add(domKey);
      primaryTracks.push(primaryByDomKey.get(domKey));
    }

    return primaryTracks;
  }

  function makeProcessSignature(scopeContext, primaryTracks) {
    const trackParts = (primaryTracks || []).map((track) => [
      track.domKey || '',
      track.artist || '',
      track.title || '',
      track.duration || 0,
      track.baseKey || '',
    ].join('\u001f'));
    return [
      location.href,
      scopeContext.scopeKey,
      scopeContext.pageNumber,
      trackParts.length,
      trackParts.join('\u001e'),
    ].join('\u001d');
  }

  // Applies visible marks. Duplicate marks are only shown in Debug mode.
  // Page cache wins over backend status so the colour survives DOM re-renders
  // that happen after the track is already saved in storage.
  function applyTrackStatuses(tracks, results, primaryTracks) {
    const resultById = new Map(results.map((item) => [item.id, item]));
    const resultByDomKey = new Map();
    for (const track of primaryTracks || []) {
      if (!track || !track.domKey) {
        continue;
      }
      const result = resultById.get(track.id);
      if (result) {
        resultByDomKey.set(String(track.domKey), result);
      }
    }
    const seenBaseKeys = new Set();

    if (pageStatusUrl !== location.href) {
      pageStatusCache = new Map();
      pageStatusUrl = location.href;
    }

    for (const track of tracks) {
      const ownResult = resultById.get(track.id);
      const result = ownResult ||
        (track.domKey ? resultByDomKey.get(String(track.domKey)) : null);
      if (!result) {
        continue;
      }
      const node = track.node;
      if (!(node instanceof Element)) {
        continue;
      }

      const statusBaseKey = result.baseKey || track.baseKey;
      const cached = pageStatusCache.get(statusBaseKey);
      let effectiveStatus = result.status;

      // Keep the row truthful for exact duplicates visible in the same render.
      // The cache is only for DOM re-renders, not for overriding a real duplicate row.
      const isSameRenderDuplicate = result.status === 'duplicate' && seenBaseKeys.has(statusBaseKey);
      if (!isSameRenderDuplicate && (cached === 'new' || cached === 'variant')) {
        effectiveStatus = cached;
      } else if (result.status === 'new' || result.status === 'variant') {
        pageStatusCache.set(statusBaseKey, result.status);
      }
      seenBaseKeys.add(statusBaseKey);

      // Border thickness: 2px if track row is shorter than 60px, 3px otherwise.
      const isThin = node.offsetHeight < 60;
      node.classList.remove(
        constants.ACTIVE_CLASS_NEW,
        constants.ACTIVE_CLASS_VARIANT,
        constants.ACTIVE_CLASS_DUPLICATE,
        'mbe-border-thin',
      );
      if (isThin) {
        node.classList.add('mbe-border-thin');
      }

      if (effectiveStatus === 'new') {
        node.classList.add(constants.ACTIVE_CLASS_NEW);
      } else if (effectiveStatus === 'variant') {
        node.classList.add(constants.ACTIVE_CLASS_VARIANT);
      } else if (debugEnabled && effectiveStatus === 'duplicate') {
        node.classList.add(constants.ACTIVE_CLASS_DUPLICATE);
      }
    }
  }

  async function processPage(forceReprocess = false) {
    if (runtimeState.disposed || !enabled) {
      return;
    }
    if (running) {
      pendingProcess = true;
      return;
    }

    const adapter = getAdapter();
    if (!adapter) {
      log.warn('no adapter for page', { activationId, hostname: pageHostname(), href: location.href });
      return;
    }
    log.debug('adapter selected', { activationId, adapter: adapter.name, hostname: pageHostname() });

    const scopeContext = normalize.pageContext(document, location.href, adapter);
    log.debug('scope context', {
      activationId,
      error: scopeContext.error,
      scopeKey: scopeContext.scopeKey,
      scopeLabel: scopeContext.scopeLabel,
      scopeSource: scopeContext.scopeSource,
      pageNumber: scopeContext.pageNumber,
    });
    if (scopeContext.error) {
      if (enabled) {
        browser.runtime.sendMessage({
          type: 'MBE_PROCESS_TRACKS',
          scopeKey: '',
          scopeLabel: '',
          url: location.href,
          pageNumber: scopeContext.pageNumber,
          activationId,
          tracks: [],
        }).catch(() => {});
      }
      showError(scopeContext.error);
      return;
    }

    hideError();
    injectStyles();

    const tracks = adapter.extract(document, scopeContext);
    const primaryTracks = selectPrimaryTracks(tracks);
    const processSignature = makeProcessSignature(scopeContext, primaryTracks);
    if (tracks.length === 0) {
      showError(t('errorNoTrackRows'));
    } else {
      hideError();
    }

    if (!forceReprocess && lastProcessSignature === processSignature && Array.isArray(lastProcessResults)) {
      diag('reuse classification summary', {
        tracks: tracks.length,
        primaryTracks: primaryTracks.length,
        scopeKey: scopeContext.scopeKey,
        pageNumber: scopeContext.pageNumber,
      });
      applyTrackStatuses(tracks, lastProcessResults, primaryTracks);
      return;
    }

    log.info('process page', {
      activationId,
      tracks: tracks.length,
      primaryTracks: primaryTracks.length,
      scopeKey: scopeContext.scopeKey,
      scopeLabel: scopeContext.scopeLabel,
      href: location.href,
    });
    running = true;
    try {
      const response = await browser.runtime.sendMessage({
        type: 'MBE_PROCESS_TRACKS',
        scopeKey: scopeContext.scopeKey,
        scopeLabel: scopeContext.scopeLabel,
        url: location.href,
        pageNumber: scopeContext.pageNumber,
        activationId,
        tracks: primaryTracks.map((track) => ({
          id: track.id,
          artist: track.artist,
          title: track.title,
          duration: track.duration,
          baseKey: track.baseKey,
          k: track.k,
          n: track.n,
          v: track.v,
          firstSeenUrl: location.href,
          pageNumber: scopeContext.pageNumber,
        })),
      });

      if (!response || !response.ok) {
        diag('background rejected tracks', { response });
        showError(response && response.error ? response.error : t('errorFailedProcessTracks'));
        return;
      }

      if (!response.summary || !Array.isArray(response.summary.results)) {
        diag('background returned no summary', { response });
        showError(t('errorNoProcessingSummary'));
        return;
      }

      diag('classification summary', { summary: response.summary });
      lastProcessSignature = processSignature;
      lastProcessResults = response.summary.results;
      applyTrackStatuses(tracks, response.summary.results, primaryTracks);
    } catch (error) {
      diag('process page failed', { error: error && error.message ? error.message : String(error) });
      showError(error && error.message ? error.message : String(error));
    } finally {
      running = false;
      if (pendingProcess) {
        pendingProcess = false;
        scheduleProcess();
      }
    }
  }

  // DOM changes on music pages are frequent, so processing is debounced.
  function scheduleProcess() {
    if (runtimeState.disposed || !enabled) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      processPage().catch(() => {});
    }, 100);
  }

  function startObserver() {
    if (runtimeState.disposed || observer) {
      return;
    }
    observer = new MutationObserver(() => {
      scheduleProcess();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function syncEnabledState() {
    if (runtimeState.disposed) {
      return;
    }
    try {
      const response = await browser.runtime.sendMessage({
        type: 'MBE_GET_TAB_STATE',
      });
      enabled = Boolean(response && response.ok && response.tabState && response.tabState.enabled);
      activationId = response && response.ok && response.tabState && response.tabState.activationId
        ? response.tabState.activationId
        : activationId;
      setDebugEnabled(Boolean(response && response.ok && response.tabState && response.tabState.debugEnabled));
      diag('sync state', { enabled, debugEnabled, response });
      if (enabled) {
        startObserver();
        scheduleProcess();
      }
    } catch (error) {
      enabled = false;
      diag('sync state failed', { error: error && error.message ? error.message : String(error) });
    }
  }

  // Runtime commands from background: start/stop processing and toggle debug logs.
  function handleRuntimeMessage(message) {
    if (runtimeState.disposed || !message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'MBE_START') {
      enabled = true;
      activationId = message.activationId || activationId;
      setDebugEnabled(Boolean(message.debugEnabled));
      diag('start message received', {});
      startObserver();
      scheduleProcess();
    }
    if (message.type === 'MBE_REPROCESS_PAGE') {
      enabled = true;
      activationId = message.activationId || activationId;
      setDebugEnabled(Boolean(message.debugEnabled));
      diag('reprocess message received', {});
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      processPage(true).catch(() => {});
    }
    if (message.type === 'MBE_DEBUG_CHANGED') {
      setDebugEnabled(Boolean(message.debugEnabled));
      scheduleProcess();
    }
    if (message.type === 'MBE_DISABLE') {
      enabled = false;
      running = false;
      setDebugEnabled(false);
      activationId = '';
      stopObserver();
      clearPageStatusCache();
      clearPageClasses();
      hideError();
    }
  }

  browser.runtime.onMessage.addListener(handleRuntimeMessage);
  runtimeState.dispose = () => {
    runtimeState.disposed = true;
    running = false;
    stopObserver();
    hideError();
    if (browser.runtime && browser.runtime.onMessage && browser.runtime.onMessage.removeListener) {
      browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
  };

  function init() {
    if (runtimeState.disposed) {
      return;
    }
    syncEnabledState();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
