(function (global) {
  'use strict';

  const MBE = global.MBE;
  if (!MBE || !MBE.browser || !MBE.constants || !MBE.normalize || !MBE.classification) {
    throw new Error('storage.js must be loaded after shared.js and classification.js.');
  }

  const { browser, constants, normalize, classification } = MBE;
  const t = MBE.i18n && MBE.i18n.t ? MBE.i18n.t : (key) => key;
  const STORAGE_PREFIX = constants.STORAGE_PREFIX;
  const SCOPE_OVERRIDES_KEY = constants.SCOPE_OVERRIDES_KEY || 'mbe:scopeOverrides';
  const TAB_PREFIX = constants.TAB_PREFIX;
  const LEGACY_SITE_KEY = constants.LEGACY_SITE_KEY || '__legacy__';

  const normalizeScopeLabel = normalize.scopeLabel;

  function makeStorageKey(scopeKey) {
    return `${STORAGE_PREFIX}${scopeKey}`;
  }

  function makeTabKey(tabId) {
    return `${TAB_PREFIX}${tabId}`;
  }

  function assertScopeStorageKey(key) {
    if (typeof key !== 'string' || !key.startsWith(STORAGE_PREFIX) || key.length === STORAGE_PREFIX.length) {
      throw new Error(`Invalid scope storage key: ${key}`);
    }
  }

  function assertScopeOverridesKey(key) {
    if (key !== SCOPE_OVERRIDES_KEY) {
      throw new Error(`Invalid scope overrides key: ${key}`);
    }
  }

  function assertTabStorageKey(key) {
    if (typeof key !== 'string' || !key.startsWith(TAB_PREFIX) || !/^\d+$/.test(key.slice(TAB_PREFIX.length))) {
      throw new Error(`Invalid tab storage key: ${key}`);
    }
  }

  async function readScopeStorageKey(key) {
    assertScopeStorageKey(key);
    const stored = await browser.storage.local.get(key);
    return stored[key];
  }

  async function writeScopeStorageKey(key, value) {
    assertScopeStorageKey(key);
    await browser.storage.local.set({ [key]: value });
  }

  async function readScopeOverridesStorageKey(key) {
    assertScopeOverridesKey(key);
    const stored = await browser.storage.local.get(key);
    return stored[key];
  }

  async function writeScopeOverridesStorageKey(key, value) {
    assertScopeOverridesKey(key);
    await browser.storage.local.set({ [key]: value });
  }

  async function readAllScopeStorage() {
    const stored = await browser.storage.local.get(null);
    const result = {};
    for (const key of Object.keys(stored || {})) {
      if (key.startsWith(STORAGE_PREFIX)) {
        result[key] = stored[key];
      }
    }
    return result;
  }

  async function readTabStorageKey(key) {
    assertTabStorageKey(key);
    const stored = await browser.storage.session.get(key);
    return stored[key];
  }

  async function writeTabStorageKey(key, value) {
    assertTabStorageKey(key);
    await browser.storage.session.set({ [key]: value });
  }

  async function removeTabStorageKey(key) {
    assertTabStorageKey(key);
    await browser.storage.session.remove(key);
  }

  // Storage boundary.
  // Code below this line, and all other project modules, must not call
  // MBE.browser.storage.local/session get/set/remove directly. Use the
  // helpers above through the public MBE.storage API instead.

  function makeSiteKey(rawUrl) {
    const text = normalizeScopeLabel(rawUrl || '');
    if (!text) {
      return LEGACY_SITE_KEY;
    }
    let url;
    try {
      url = new URL(text);
    } catch (_err) {
      return LEGACY_SITE_KEY;
    }

    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname
      .replace(/\/start\/\d+\/?$/i, '')
      .replace(/\/page\/\d+\/?$/i, '')
      .replace(/\/p\/\d+\/?$/i, '')
      .replace(/\/+$/g, '') || '/';

    if (/(^|\.)ligaudio\.ru$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/^(\/mp3\/[^/]+)\/\d+$/i, '$1');
    }

    for (const key of ['page', 'p', 'start', 'offset']) {
      url.searchParams.delete(key);
    }
    url.searchParams.sort();

    return url.toString().replace(/\/$/g, '');
  }

  function normalizeRecord(record) {
    if (!record) {
      return null;
    }
    if (Array.isArray(record)) {
      return {
        b: normalizeScopeLabel(record[0] || ''),
        k: normalizeScopeLabel(record[1] || ''),
        d: Number(record[2]) || 0,
        p: Number(record[3]) || 0,
        u: normalizeScopeLabel(record[4] || ''),
        a: normalizeScopeLabel(record[5] || ''),
        t: normalizeScopeLabel(record[6] || ''),
        n: normalizeScopeLabel(record[7] || ''),
        v: normalizeScopeLabel(record[8] || ''),
      };
    }
    if (typeof record === 'object') {
      return {
        b: normalizeScopeLabel(record.b || record.baseKey || ''),
        k: normalizeScopeLabel(record.k || record.variantKey || ''),
        d: Number(record.d || record.duration || 0) || 0,
        p: Number(record.p || record.page || 0) || 0,
        u: normalizeScopeLabel(record.u || record.url || ''),
        a: normalizeScopeLabel(record.a || record.artist || ''),
        t: normalizeScopeLabel(record.t || record.title || ''),
        n: normalizeScopeLabel(record.n || record.baseName || ''),
        v: normalizeScopeLabel(record.v || record.variantStr || ''),
      };
    }
    return null;
  }

  function stripDefaultUrl(record, siteKey) {
    if (!record) {
      return null;
    }
    const normalized = { ...record };
    if (!normalized.u || makeSiteKey(normalized.u) === siteKey) {
      delete normalized.u;
    }
    return normalized;
  }

  function addRecordToSite(items, siteKey, record) {
    const normalized = normalizeRecord(record);
    if (!normalized || !normalized.b) {
      return;
    }
    const key = siteKey || makeSiteKey(normalized.u);
    if (!items[key]) {
      items[key] = [];
    }
    items[key].push(stripDefaultUrl(normalized, key));
  }

  function normalizeSiteHost(rawHost) {
    const host = normalizeScopeLabel(rawHost || '').toLowerCase().replace(/^www\./, '');
    return host;
  }

  function makeSiteHost(rawUrl) {
    const text = normalizeScopeLabel(rawUrl || '');
    if (!text) {
      return '';
    }
    try {
      return normalizeSiteHost(new URL(text).hostname);
    } catch (_error) {
      return normalizeSiteHost(text);
    }
  }

  function normalizeSources(rawSources) {
    const sources = {};
    if (!rawSources || typeof rawSources !== 'object' || Array.isArray(rawSources)) {
      return sources;
    }
    for (const rawHost of Object.keys(rawSources)) {
      const host = normalizeSiteHost(rawHost);
      if (!host) {
        continue;
      }
      const source = rawSources[rawHost] && typeof rawSources[rawHost] === 'object'
        ? rawSources[rawHost]
        : {};
      const listenedUntilPage = Math.max(0, Math.floor(Number(source.listenedUntilPage || 0) || 0));
      if (listenedUntilPage > 0) {
        sources[host] = { listenedUntilPage };
      }
    }
    return sources;
  }

  function normalizeScopeOverrides(data) {
    const bySiteKey = {};
    const rawBySiteKey = data && typeof data === 'object' && data.bySiteKey && typeof data.bySiteKey === 'object'
      ? data.bySiteKey
      : {};
    for (const rawSiteKey of Object.keys(rawBySiteKey)) {
      const siteKey = makeSiteKey(rawSiteKey);
      const entry = rawBySiteKey[rawSiteKey] && typeof rawBySiteKey[rawSiteKey] === 'object'
        ? rawBySiteKey[rawSiteKey]
        : {};
      const scopeLabel = normalizeScopeLabel(entry.scopeLabel || '');
      if (!siteKey || siteKey === LEGACY_SITE_KEY || !scopeLabel) {
        continue;
      }
      const updatedAt = Math.max(0, Math.floor(Number(entry.updatedAt || 0) || 0));
      bySiteKey[siteKey] = {
        scopeLabel,
        updatedAt,
      };
    }
    return {
      version: 1,
      bySiteKey,
    };
  }

  function normalizeScopeData(data) {
    const items = {};
    const needsMigration = !data || data.version !== 2 ||
      !data.items || typeof data.items !== 'object' || Array.isArray(data.items);
    if (data && typeof data === 'object') {
      if (data.items && typeof data.items === 'object' && !Array.isArray(data.items)) {
        for (const siteKey of Object.keys(data.items)) {
          const records = Array.isArray(data.items[siteKey]) ? data.items[siteKey] : [];
          const normalizedSiteKey = siteKey || LEGACY_SITE_KEY;
          for (const item of records) {
            addRecordToSite(items, normalizedSiteKey, item);
          }
        }
      } else {
        const source = Array.isArray(data.items) ? data.items : Array.isArray(data.e) ? data.e : [];
        for (const item of source) {
          const normalized = normalizeRecord(item);
          const siteKey = normalized && normalized.u ? makeSiteKey(normalized.u) : LEGACY_SITE_KEY;
          addRecordToSite(items, siteKey, normalized);
        }
      }
    }
    const result = {
      version: 2,
      items,
      sources: normalizeSources(data && data.sources),
    };
    Object.defineProperty(result, 'needsMigration', {
      value: needsMigration,
      enumerable: false,
    });
    return result;
  }

  function getSiteItems(scopeData, siteKey) {
    return (scopeData && scopeData.items && Array.isArray(scopeData.items[siteKey]))
      ? scopeData.items[siteKey]
      : [];
  }

  function getListenedContextItems(scopeData, sources, currentSiteHost) {
    const result = [];
    const itemsBySite = scopeData && scopeData.items && typeof scopeData.items === 'object'
      ? scopeData.items
      : {};
    for (const siteKey of Object.keys(itemsBySite)) {
      const records = Array.isArray(itemsBySite[siteKey]) ? itemsBySite[siteKey] : [];
      for (const item of records) {
        const host = makeSiteHost(item && item.u ? item.u : siteKey);
        if (!host || host === currentSiteHost) {
          continue;
        }
        const listenedUntilPage = Number(sources[host] && sources[host].listenedUntilPage || 0) || 0;
        if (listenedUntilPage > 0 && Number(item && item.p || 0) <= listenedUntilPage) {
          result.push(item);
        }
      }
    }
    return result;
  }

  function countScopeItems(scopeData) {
    if (!scopeData || !scopeData.items) {
      return 0;
    }
    if (Array.isArray(scopeData.items)) {
      return scopeData.items.length;
    }
    let total = 0;
    for (const siteKey of Object.keys(scopeData.items)) {
      if (Array.isArray(scopeData.items[siteKey])) {
        total += scopeData.items[siteKey].length;
      }
    }
    return total;
  }

  function normalizeTabState(data) {
    const state = data && typeof data === 'object' ? data : {};
    const hasContextTrackCount = Object.prototype.hasOwnProperty.call(state, 'contextTrackCount');
    const hasContextUniqueTrackCount = Object.prototype.hasOwnProperty.call(state, 'contextUniqueTrackCount');
    const contextTrackCount = Number(hasContextTrackCount ? state.contextTrackCount : state.previousCount || 0) || 0;
    const contextUniqueTrackCount = Number(hasContextUniqueTrackCount ? state.contextUniqueTrackCount : state.previousUniqueCount || 0) || 0;
    return {
      enabled: Boolean(state.enabled),
      debugEnabled: Boolean(state.debugEnabled),
      activationId: normalizeScopeLabel(state.activationId || ''),
      scopeKey: normalizeScopeLabel(state.scopeKey || ''),
      scopeLabel: normalizeScopeLabel(state.scopeLabel || ''),
      status: normalizeScopeLabel(state.status || ''),
      lastError: normalizeScopeLabel(state.lastError || ''),
      contextTrackCount,
      contextUniqueTrackCount,
      previousCount: contextTrackCount,
      previousUniqueCount: contextUniqueTrackCount,
      newCount: Number(state.newCount || 0) || 0,
      variantCount: Number(state.variantCount || 0) || 0,
      duplicateCount: Number(state.duplicateCount || 0) || 0,
      storedCount: Number(state.storedCount || 0) || 0,
      totalCount: Number(state.totalCount || 0) || 0,
      lastUrl: normalizeScopeLabel(state.lastUrl || ''),
      lastUpdatedAt: Number(state.lastUpdatedAt || 0) || 0,
    };
  }

  async function readScopeData(scopeKey) {
    const raw = await readScopeStorageKey(makeStorageKey(scopeKey));
    return normalizeScopeData(raw);
  }

  async function writeScopeData(scopeKey, scopeData) {
    await writeScopeStorageKey(makeStorageKey(scopeKey), normalizeScopeData(scopeData));
  }

  async function readScopeOverrides() {
    const raw = await readScopeOverridesStorageKey(SCOPE_OVERRIDES_KEY);
    return normalizeScopeOverrides(raw);
  }

  async function writeScopeOverrides(overrides) {
    await writeScopeOverridesStorageKey(SCOPE_OVERRIDES_KEY, normalizeScopeOverrides(overrides));
  }

  async function getScopeOverrideForUrl(url) {
    const siteKey = makeSiteKey(url);
    if (!siteKey || siteKey === LEGACY_SITE_KEY) {
      return null;
    }
    const overrides = await readScopeOverrides();
    const entry = overrides.bySiteKey[siteKey];
    if (!entry || !entry.scopeLabel) {
      return null;
    }
    return {
      siteKey,
      scopeLabel: entry.scopeLabel,
      updatedAt: entry.updatedAt,
    };
  }

  async function setScopeOverrideForUrl(url, override) {
    const siteKey = makeSiteKey(url);
    if (!siteKey || siteKey === LEGACY_SITE_KEY) {
      throw new Error(`Invalid site URL for scope override: ${url}`);
    }
    const scopeLabel = normalizeScopeLabel(override && override.scopeLabel || '');
    if (!scopeLabel) {
      throw new Error(t('errorScopeEmpty'));
    }
    const overrides = await readScopeOverrides();
    const next = {
      version: 1,
      bySiteKey: {
        ...overrides.bySiteKey,
        [siteKey]: {
          scopeLabel,
          updatedAt: Math.max(1, Math.floor(Number(override && override.updatedAt || Date.now()) || Date.now())),
        },
      },
    };
    await writeScopeOverrides(next);
    return normalizeScopeOverrides(next);
  }

  async function clearScopeOverrideForUrl(url) {
    const siteKey = makeSiteKey(url);
    if (!siteKey || siteKey === LEGACY_SITE_KEY) {
      throw new Error(`Invalid site URL for scope override: ${url}`);
    }
    const overrides = await readScopeOverrides();
    if (!overrides.bySiteKey[siteKey]) {
      return overrides;
    }
    const bySiteKey = { ...overrides.bySiteKey };
    delete bySiteKey[siteKey];
    const next = {
      version: 1,
      bySiteKey,
    };
    await writeScopeOverrides(next);
    return normalizeScopeOverrides(next);
  }

  async function readTabState(tabId) {
    const raw = await readTabStorageKey(makeTabKey(tabId));
    return normalizeTabState(raw);
  }

  async function writeTabState(tabId, tabState) {
    await writeTabStorageKey(makeTabKey(tabId), normalizeTabState(tabState));
  }

  async function clearTabState(tabId) {
    await removeTabStorageKey(makeTabKey(tabId));
  }

  async function classifyTracksForScope(scopeKey, scopeLabel, tracks, pageMeta) {
    const scopeData = await readScopeData(scopeKey);
    const currentSiteKey = makeSiteKey(pageMeta && pageMeta.url ? pageMeta.url : '');
    const currentSiteHost = makeSiteHost(pageMeta && pageMeta.url ? pageMeta.url : '');
    const currentPage = Math.max(1, Math.floor(Number(pageMeta && pageMeta.pageNumber ? pageMeta.pageNumber : 1) || 1));
    const autoListenedUntilPage = Math.max(0, currentPage - 1);
    const sources = { ...scopeData.sources };
    if (currentSiteHost) {
      if (autoListenedUntilPage > 0) {
        sources[currentSiteHost] = { listenedUntilPage: autoListenedUntilPage };
      } else {
        delete sources[currentSiteHost];
      }
    }
    const siteItems = getSiteItems(scopeData, currentSiteKey);
    const contextItems = getListenedContextItems(scopeData, sources, currentSiteHost);
    const classified = classification.classifyPageTracks(siteItems, tracks || [], {
      ...(pageMeta || {}),
      contextItems,
    });

    const nextScopeData = {
      version: 2,
      items: {
        ...scopeData.items,
        [currentSiteKey]: classified.items.map((item) => stripDefaultUrl(item, currentSiteKey)),
      },
      sources,
    };

    if (
      scopeData.needsMigration ||
      JSON.stringify(sources) !== JSON.stringify(scopeData.sources) ||
      classified.hadCurrentPageItems ||
      classified.newCount > 0 ||
      classified.variantCount > 0
    ) {
      await writeScopeData(scopeKey, nextScopeData);
    }

    return {
      scopeKey,
      scopeLabel,
      contextTrackCount: classified.contextTrackCount,
      contextUniqueTrackCount: classified.contextUniqueTrackCount,
      previousCount: classified.contextTrackCount,
      previousUniqueCount: classified.contextUniqueTrackCount,
      newCount: classified.newCount,
      variantCount: classified.variantCount,
      duplicateCount: classified.duplicateCount,
      storedCount: countScopeItems(nextScopeData),
      results: classified.results,
    };
  }

  async function getTotalStoredCount() {
    const result = await readAllScopeStorage();
    let total = 0;
    for (const key of Object.keys(result)) {
      total += countScopeItems(normalizeScopeData(result[key]));
    }
    return total;
  }

  async function setSourceListenedUntil(scopeKey, siteHost, listenedUntilPage, minPage = 0) {
    const scopeData = await readScopeData(scopeKey);
    const host = normalizeSiteHost(siteHost);
    if (!host) {
      throw new Error(`Invalid source host: ${siteHost}`);
    }
    const nextPage = Math.max(
      Math.floor(Number(listenedUntilPage || 0) || 0),
      Math.floor(Number(minPage || 0) || 0),
      0,
    );
    const sources = { ...scopeData.sources };
    if (nextPage > 0) {
      sources[host] = { listenedUntilPage: nextPage };
    } else {
      delete sources[host];
    }
    const nextScopeData = {
      version: 2,
      items: scopeData.items,
      sources,
    };
    await writeScopeData(scopeKey, nextScopeData);
    return normalizeScopeData(nextScopeData);
  }

  async function setTabState(tabId, patch) {
    const current = await readTabState(tabId);
    const next = normalizeTabState({ ...current, ...patch, lastUpdatedAt: Date.now() });
    await writeTabState(tabId, next);
    return next;
  }

  MBE.paths = {
    scopeKey: makeStorageKey,
    scopeOverridesKey() {
      return SCOPE_OVERRIDES_KEY;
    },
    siteKey: makeSiteKey,
    siteHost: makeSiteHost,
    tabKey: makeTabKey,
  };

  MBE.storage = {
    readScopeData,
    writeScopeData,
    readTabState,
    writeTabState,
    clearTabState,
    setTabState,
    classifyTracksForScope,
    getTotalStoredCount,
    setSourceListenedUntil,
    readScopeOverrides,
    writeScopeOverrides,
    getScopeOverrideForUrl,
    setScopeOverrideForUrl,
    clearScopeOverrideForUrl,
    normalizeScopeData,
    normalizeScopeOverrides,
    normalizeTabState,
  };
})(globalThis);
