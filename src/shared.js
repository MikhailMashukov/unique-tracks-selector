(function (global) {
  'use strict';

  const MBE = (global.MBE = global.MBE || {});
  function isUsableExtensionApi(api) {
    return Boolean(api && api.runtime && api.storage);
  }

  const browserApi = isUsableExtensionApi(global.browser) ? global.browser : null;
  const chromeApi = isUsableExtensionApi(global.chrome) ? global.chrome : null;
  const extensionApi = browserApi || chromeApi || global.browser || global.chrome;
  const preferPromiseApi = Boolean(browserApi && extensionApi === browserApi);
  const extensionRuntime = extensionApi && extensionApi.runtime ? extensionApi.runtime : null;
  const extensionTabs = extensionApi && extensionApi.tabs ? extensionApi.tabs : null;
  const extensionStorage = extensionApi && extensionApi.storage ? extensionApi.storage : null;
  const extensionScripting = extensionApi && extensionApi.scripting ? extensionApi.scripting : null;
  const extensionI18n = extensionApi && extensionApi.i18n ? extensionApi.i18n : null;

  if (!extensionApi || !isUsableExtensionApi(extensionApi)) {
    throw new Error('MusicBrowserExt requires WebExtension runtime and storage APIs.');
  }

  const STORAGE_PREFIX = 'mbe:scope:';
  const SCOPE_OVERRIDES_KEY = 'mbe:scopeOverrides';
  const TAB_PREFIX = 'mbe:tab:';
  const LEGACY_SITE_KEY = '__legacy__';
  const ACTIVE_CLASS_NEW = 'mbe-new';
  const ACTIVE_CLASS_VARIANT = 'mbe-variant';
  const ACTIVE_CLASS_DUPLICATE = 'mbe-duplicate';
  const MATCH_THRESHOLD = 0.93;
  const DURATION_TOLERANCE_SEC = 3;

  function makeCallbackPromise(invoker) {
    return new Promise((resolve, reject) => {
      try {
        invoker((result) => {
          const err = extensionRuntime && extensionRuntime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function callExtensionApi(target, methodName, args) {
    if (!target || typeof target[methodName] !== 'function') {
      return Promise.reject(new Error(`${methodName} API is unavailable.`));
    }

    if (preferPromiseApi) {
      try {
        return Promise.resolve(target[methodName](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return makeCallbackPromise((done) => {
      const result = target[methodName](...args, done);
      if (result && typeof result.then === 'function') {
        result.then(done);
      }
    });
  }

  function getStorageArea(name) {
    if (!extensionStorage) {
      return null;
    }
    if (name === 'session' && extensionStorage.session) {
      return extensionStorage.session;
    }
    return extensionStorage.local;
  }

  function wrapStorageArea(area) {
    return {
      get(keys) {
        return callExtensionApi(area, 'get', [keys]);
      },
      set(items) {
        return callExtensionApi(area, 'set', [items]);
      },
      remove(keys) {
        return callExtensionApi(area, 'remove', [keys]);
      },
      clear() {
        return callExtensionApi(area, 'clear', []);
      },
    };
  }

  function sendRuntimeMessage(message) {
    if (!extensionRuntime) {
      return Promise.reject(new Error('runtime API is unavailable.'));
    }
    return callExtensionApi(extensionRuntime, 'sendMessage', [message]);
  }

  function queryTabs(queryInfo) {
    if (!extensionTabs) {
      return Promise.reject(new Error('tabs API is unavailable.'));
    }
    return callExtensionApi(extensionTabs, 'query', [queryInfo]);
  }

  function sendTabMessage(tabId, message) {
    if (!extensionTabs) {
      return Promise.reject(new Error('tabs API is unavailable.'));
    }
    return callExtensionApi(extensionTabs, 'sendMessage', [tabId, message]);
  }

  function getTab(tabId) {
    if (!extensionTabs) {
      return Promise.reject(new Error('tabs API is unavailable.'));
    }
    return callExtensionApi(extensionTabs, 'get', [tabId]);
  }

  function executeScript(details) {
    if (!extensionScripting) {
      return Promise.reject(new Error('scripting API is unavailable.'));
    }
    return callExtensionApi(extensionScripting, 'executeScript', [details]);
  }

  MBE.browser = {
    runtime: extensionRuntime
      ? {
          sendMessage: sendRuntimeMessage,
          onMessage: extensionRuntime.onMessage,
          getURL: typeof extensionRuntime.getURL === 'function'
            ? extensionRuntime.getURL.bind(extensionRuntime)
            : (path) => path,
        }
      : null,
    tabs: extensionTabs
      ? {
          query: queryTabs,
          sendMessage: sendTabMessage,
          get: getTab,
          onRemoved: extensionTabs.onRemoved || null,
          onUpdated: extensionTabs.onUpdated || null,
        }
      : null,
    storage: extensionStorage
      ? {
          local: wrapStorageArea(extensionStorage.local),
          session: wrapStorageArea(getStorageArea('session')),
          onChanged: extensionStorage.onChanged || null,
        }
      : null,
    scripting: extensionScripting
      ? {
          executeScript,
        }
      : null,
    i18n: extensionI18n || null,
    action: extensionApi.action
      ? {
          setBadgeText(details) {
            return callExtensionApi(extensionApi.action, 'setBadgeText', [details]);
          },
          setBadgeBackgroundColor(details) {
            return callExtensionApi(extensionApi.action, 'setBadgeBackgroundColor', [details]);
          },
          setTitle(details) {
            return callExtensionApi(extensionApi.action, 'setTitle', [details]);
          },
        }
      : null,
  };

  MBE.constants = {
    STORAGE_PREFIX,
    SCOPE_OVERRIDES_KEY,
    TAB_PREFIX,
    LEGACY_SITE_KEY,
    ACTIVE_CLASS_NEW,
    ACTIVE_CLASS_VARIANT,
    ACTIVE_CLASS_DUPLICATE,
    MATCH_THRESHOLD,
    DURATION_TOLERANCE_SEC,
  };

  function createLogger(scope) {
    let enabled = false;
    const prefix = `[MusicBrowserExt:${scope}]`;
    const emit = (level, args) => {
      if (!enabled) {
        return;
      }
      const writer = console[level] || console.log;
      writer.call(console, prefix, ...args);
    };
    return {
      setEnabled(value) {
        enabled = Boolean(value);
      },
      isEnabled() {
        return enabled;
      },
      debug(...args) {
        emit('debug', args);
      },
      info(...args) {
        emit('info', args);
      },
      warn(...args) {
        emit('warn', args);
      },
      error(...args) {
        emit('error', args);
      },
    };
  }

  const DEFAULT_MESSAGES = {
    extName: 'Unique Tracks Selector',
    extDescription: 'Highlights unique tracks while you browse music search pages. It marks previously seen tracks, remixes, and duplicates so you can quickly focus on new results.',
    popupEnable: 'Enable',
    popupDebug: 'Debug',
    popupPrevious: 'Previous',
    popupNew: 'new',
    popupVariant: 'variant',
    popupDuplicate: 'duplicate',
    popupDbTotal: 'DB: total',
    popupDbScope: 'set',
    popupPages: 'Pages',
    scopeEdit: 'Edit Scope',
    scopeSave: 'Save Scope',
    scopeUseAuto: 'Use auto Scope',
    manualScopeTitle: 'Manual Scope for this URL section',
    errorScopeEmpty: 'Scope cannot be empty.',
    errorHttpOnly: 'The extension works only on http(s) pages.',
    errorNoActiveTab: 'No active tab was found.',
    errorNoTabUrl: 'This tab has no URL.',
    errorCouldNotLoadTabState: 'Could not load tab state.',
    errorFailedRefreshClassification: 'Failed to refresh page classification.',
    errorFailedUpdateTabState: 'Failed to update tab state.',
    errorFailedUpdateDebug: 'Failed to update debug mode.',
    errorScopeEditingUnavailable: 'Scope editing is not available.',
    errorTabNotEnabled: 'This tab is not enabled.',
    errorScriptingUnavailable: 'scripting API is not available.',
    errorCouldNotReprocessPage: 'Could not reprocess page',
    errorCouldNotStartContentScript: 'Could not start content script',
    errorFailedProcessTracks: 'Failed to process tracks.',
    errorNoTrackRows: 'No track rows detected. Enable Debug mode and check the page console for MusicBrowserExt logs.',
    errorNoProcessingSummary: 'Track processing returned no summary.',
    errorScopeNotDetected: 'Scope is not detected on this page.',
    actionTitleDefault: 'MusicBrowserExt',
    actionTitleEnabled: 'MusicBrowserExt enabled on this tab',
  };

  function getMessage(key, substitutions) {
    if (extensionI18n && typeof extensionI18n.getMessage === 'function') {
      const localized = extensionI18n.getMessage(key, substitutions);
      if (localized) {
        return localized;
      }
    }
    return DEFAULT_MESSAGES[key] || key;
  }

  function normalizeWhitespace(text) {
    return String(text || '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUnicode(text) {
    return normalizeWhitespace(String(text || '').normalize('NFKC'))
      .replace(/[\u200b-\u200f\uFEFF]/g, '');
  }

  function normalizePunctuationSpacing(text) {
    return normalizeUnicode(text)
      .replace(/[“”«»]/g, '"')
      .replace(/[‘’`´]/g, "'")
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\s*([()\[\]{}|/\\,:;+-])\s*/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeScopeKey(raw) {
    return normalizeUnicode(raw).toLowerCase().replace(/\s+/g, ' ');
  }

  function normalizeScopeLabel(raw) {
    return normalizeWhitespace(raw);
  }

  function cleanScopeCandidate(raw) {
    return normalizeScopeLabel(raw)
      .replace(/\s*[\[(]\s*\d+\s*(?:страниц[аы]?|page)\s*[\])]\s*/i, ' ')
      .replace(/^\[\s*(.*?)\s*\]$/u, '$1')
      .replace(/\s+(слушать|скачать|песни|трек[иов]*|музыка|mp3|онлайн|online|listen|download).*$/i, '')
      .replace(/\s*[-—–]\s*$/u, '')
      .trim();
  }

  function parseDurationSeconds(text) {
    const match = String(text || '').match(/\b(\d{1,2}):(\d{2})\b/);
    if (!match) {
      return null;
    }
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return null;
    }
    return minutes * 60 + seconds;
  }

  function stripDurationFromText(text) {
    return normalizeWhitespace(String(text || '').replace(/\b\d{1,2}:\d{2}\b/g, ' '));
  }

  function splitArtistTitle(text, fallbackArtist) {
    const cleaned = stripDurationFromText(text);
    const separatorMatch = cleaned.match(/^(.*?)\s+[—–-]\s+(.*)$/);
    if (separatorMatch) {
      const artist = normalizeScopeLabel(separatorMatch[1]);
      const title = normalizeScopeLabel(separatorMatch[2]);
      if (artist && title) {
        return { artist, title };
      }
    }
    return {
      artist: normalizeScopeLabel(fallbackArtist || ''),
      title: normalizeScopeLabel(cleaned),
    };
  }

  const PATH_GENERIC_SEGMENTS = new Set([
    'music', 'musics', 'song', 'songs', 'track', 'tracks',
    'artist', 'artists', 'album', 'albums', 'release', 'releases',
    'search', 'browse', 'top', 'best', 'new', 'popular', 'page',
    'index', 'home', 'main', 'mp3', 'genre', 'genres', 'category',
    'categories', 'audio', 'listen', 'play', 'start',
  ]);

  function extractPageNumberFromUrl(url) {
    const page = Number(url.searchParams.get('page') || 0) || 0;
    if (page > 0) {
      return page;
    }

    const start = Number(url.searchParams.get('start') || 0) || 0;
    if (start > 0) {
      return Math.floor(start / 48) + 1;
    }

    const pathMatch = url.pathname.match(/\/start\/(\d+)(?:\/|$)/i);
    if (pathMatch) {
      const pathStart = Number(pathMatch[1] || 0) || 0;
      if (pathStart > 0) {
        return Math.floor(pathStart / 48) + 1;
      }
    }

    if (/(^|\.)ligaudio\.ru$/i.test(url.hostname)) {
      const ligaudioMatch = url.pathname.match(/^\/mp3\/[^/]+\/(\d+)\/?$/i);
      if (ligaudioMatch) {
        const ligaudioPage = Number(ligaudioMatch[1] || 0) || 0;
        if (ligaudioPage > 0) {
          return ligaudioPage;
        }
      }
    }

    return 1;
  }

  function canonicalizeUrlPath(pathname) {
    const decodedSegments = String(pathname || '')
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch (error) {
          return part;
        }
      })
      .map((part) => part.replace(/[-_+]+/g, ' '))
      .map((part) => cleanScopeCandidate(part))
      .filter(Boolean);

    const meaningful = decodedSegments.filter((part) => {
      const lower = part.toLowerCase();
      if (PATH_GENERIC_SEGMENTS.has(lower)) {
        return false;
      }
      if (/^\d+$/.test(part)) {
        return false;
      }
      return true;
    });

    return normalizeScopeLabel(meaningful.join(' '));
  }

  function isGenericScopeText(text) {
    const value = normalizeScopeLabel(text).toLowerCase();
    if (!value) {
      return true;
    }
    return /^(search|hitmo|hitmoz|music|download|mp3|track|tracks|artist|artists|album|albums|song|songs|results?|home|main|page|browse|listen|watch|play|new|top|popular|vpn|please|please use vpn)$/i.test(
      value,
    );
  }

  function extractScopeContext(document, href) {
    const url = new URL(href);
    const query = url.searchParams.get('q');
    let scopeLabel = '';
    let scopeSource = '';

    if (query && normalizeWhitespace(query)) {
      scopeLabel = normalizeScopeLabel(query.replace(/\+/g, ' '));
      scopeSource = 'query';
    }

    if (!scopeLabel) {
      const h1 = document.querySelector('h1');
      const h1Text = h1 ? cleanScopeCandidate(h1.textContent) : '';
      if (h1Text && !isGenericScopeText(h1Text)) {
        scopeLabel = h1Text;
        scopeSource = 'h1';
      }
    }

    if (!scopeLabel) {
      const pathLabel = canonicalizeUrlPath(url.pathname);
      if (pathLabel && !isGenericScopeText(pathLabel)) {
        scopeLabel = pathLabel;
        scopeSource = 'path';
      }
    }

    if (!scopeLabel) {
      const titleParts = normalizeScopeLabel(document.title)
        .split(/\s*[|—–-]\s*/)
        .map((part) => cleanScopeCandidate(part))
        .filter(Boolean);
      if (titleParts.length) {
        const candidate = titleParts.find((part) => !isGenericScopeText(part));
        if (candidate) {
          scopeLabel = candidate;
          scopeSource = 'title';
        }
      }
    }

    if (!scopeLabel) {
      return {
        error: getMessage('errorScopeNotDetected'),
        scopeKey: '',
        scopeLabel: '',
        scopeSource: '',
        pageNumber: extractPageNumberFromUrl(url),
        url,
      };
    }

    return {
      error: '',
      scopeKey: normalizeScopeKey(scopeLabel),
      scopeLabel,
      scopeSource,
      pageNumber: extractPageNumberFromUrl(url),
      url,
    };
  }

  function extractPageContext(document, href, adapter) {
    const context = extractScopeContext(document, href);
    const url = context.url instanceof URL ? context.url : new URL(href);
    if (!adapter || typeof adapter.extractScope !== 'function') {
      return context;
    }

    const overrideLabel = adapter.extractScope(document, url, context);
    if (!overrideLabel) {
      return context;
    }

    const scopeLabel = cleanScopeCandidate(overrideLabel);
    if (!scopeLabel) {
      return context;
    }

    return {
      error: '',
      scopeKey: normalizeScopeKey(scopeLabel),
      scopeLabel,
      scopeSource: 'adapter',
      pageNumber: context.pageNumber,
      url,
    };
  }

  // Variant = «другая обработка того же трека» (radio mix / extended / remix / edit).
  // Длительность здесь не блокирует: ремикс по определению имеет другую длительность.
  // Она используется только как тай-брейкер на пограничных JW-скорах, чтобы отсечь
  // ложные совпадения между разными песнями с похожими названиями.
  MBE.normalize = {
    whitespace: normalizeWhitespace,
    unicode: normalizeUnicode,
    punctuation: normalizePunctuationSpacing,
    scopeKey: normalizeScopeKey,
    scopeLabel: normalizeScopeLabel,
    scopeContext: extractScopeContext,
    pageContext: extractPageContext,
    pageNumberFromUrl(href) {
      return extractPageNumberFromUrl(new URL(href));
    },
  };

  MBE.text = {
    parseDurationSeconds,
    stripDurationFromText,
    splitArtistTitle,
  };

  MBE.messaging = {
    sendRuntimeMessage,
    sendTabMessage,
    queryTabs,
    getTab,
  };

  MBE.runtime = {
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };

  MBE.debug = {
    createLogger,
  };

  MBE.i18n = {
    t: getMessage,
    getMessage,
    getUILanguage() {
      if (extensionI18n && typeof extensionI18n.getUILanguage === 'function') {
        return extensionI18n.getUILanguage();
      }
      return 'en';
    },
  };
})(globalThis);
