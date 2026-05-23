(function (global) {
  'use strict';

  const MBE = global.MBE;
  if (!MBE || !MBE.normalize || !MBE.similarity) {
    throw new Error('source_selector.js must be loaded after shared.js and classification.js.');
  }

  const { normalize, similarity } = MBE;
  const LEGACY_SITE_KEY = MBE.constants && MBE.constants.LEGACY_SITE_KEY
    ? MBE.constants.LEGACY_SITE_KEY
    : '__legacy__';

  function siteHostFromUrl(rawUrl) {
    const text = normalize.scopeLabel(rawUrl || '');
    if (!text || text === LEGACY_SITE_KEY) {
      return text;
    }
    try {
      return new URL(text).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_error) {
      return text.toLowerCase().replace(/^www\./, '');
    }
  }

  function siteHostFromRecord(record, siteKey) {
    return siteHostFromUrl(record && record.u ? record.u : siteKey);
  }

  function normalizeRecord(record) {
    return {
      b: normalize.scopeLabel(record && record.b ? record.b : ''),
      k: normalize.scopeLabel(record && record.k ? record.k : ''),
      d: Number(record && record.d ? record.d : 0) || 0,
      p: Math.max(1, Math.floor(Number(record && record.p ? record.p : 1) || 1)),
      u: normalize.scopeLabel(record && record.u ? record.u : ''),
      a: normalize.scopeLabel(record && record.a ? record.a : ''),
      t: normalize.scopeLabel(record && record.t ? record.t : ''),
      n: normalize.scopeLabel(record && record.n ? record.n : ''),
      v: normalize.scopeLabel(record && record.v ? record.v : ''),
    };
  }

  function isDuplicateOrVariant(seenItems, candidate) {
    for (const item of seenItems) {
      if (item.b && item.b === candidate.b) {
        return true;
      }
      if (similarity.isVariantMatch(item, candidate)) {
        return true;
      }
    }
    return false;
  }

  function countNewItemsForPage(rowItems, page, contextItems) {
    const previousSameSite = rowItems.filter((item) => item.p < page);
    const pageItems = rowItems.filter((item) => item.p === page);
    const seenItems = contextItems.concat(previousSameSite);
    const samePageItems = [];
    const newItems = [];

    for (const item of pageItems) {
      if (!isDuplicateOrVariant(seenItems, item) && !isDuplicateOrVariant(samePageItems, item)) {
        newItems.push(item);
      }
      samePageItems.push(item);
    }

    return {
      count: newItems.length,
      titles: newItems.map((item) => {
        const artist = item.a || '';
        const title = item.t || item.n || item.b || '';
        return artist && title ? `${artist} - ${title}` : title || artist;
      }).filter(Boolean),
    };
  }

  function buildRows(scopeData) {
    const rowsByHost = new Map();
    const itemsBySite = scopeData && scopeData.items && typeof scopeData.items === 'object'
      ? scopeData.items
      : {};

    for (const siteKey of Object.keys(itemsBySite)) {
      const records = Array.isArray(itemsBySite[siteKey]) ? itemsBySite[siteKey] : [];
      for (const record of records) {
        const item = normalizeRecord(record);
        if (!item.b) {
          continue;
        }
        const host = siteHostFromRecord(item, siteKey);
        if (!host) {
          continue;
        }
        if (!rowsByHost.has(host)) {
          rowsByHost.set(host, []);
        }
        rowsByHost.get(host).push(item);
      }
    }

    return Array.from(rowsByHost.entries())
      .map(([host, items]) => ({
        host,
        items: items.slice().sort((a, b) => a.p - b.p),
      }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  function buildSourceSelectorModel(scopeData, options = {}) {
    const currentHost = siteHostFromUrl(options.currentUrl || '');
    const currentPage = Math.max(1, Math.floor(Number(options.currentPage || 1) || 1));
    const sources = scopeData && scopeData.sources && typeof scopeData.sources === 'object'
      ? scopeData.sources
      : {};
    const rows = buildRows(scopeData);
    const maxPage = rows.reduce((max, row) => {
      const rowMax = row.items.reduce((pageMax, item) => Math.max(pageMax, item.p), 0);
      return Math.max(max, rowMax);
    }, 0);
    const pages = [];
    for (let page = 1; page <= maxPage; page += 1) {
      pages.push(page);
    }

    const listenedItemsFromOtherSites = [];
    for (const row of rows) {
      if (row.host === currentHost) {
        continue;
      }
      const listenedUntilPage = Number(sources[row.host] && sources[row.host].listenedUntilPage || 0) || 0;
      listenedItemsFromOtherSites.push(...row.items.filter((item) => item.p <= listenedUntilPage));
    }

    const precedingListenedItems = [];
    const modelRows = rows.map((row) => {
      const storedListenedUntilPage = Number(sources[row.host] && sources[row.host].listenedUntilPage || 0) || 0;
      const autoMinPage = row.host === currentHost ? Math.max(0, currentPage - 1) : 0;
      const listenedUntilPage = row.host === currentHost
        ? autoMinPage
        : storedListenedUntilPage;
      const rowContextItems = row.host === currentHost
        ? listenedItemsFromOtherSites
        : precedingListenedItems.slice();
      const cells = pages.map((page) => {
        const pageItems = row.items.filter((item) => item.p === page);
        const hasData = pageItems.length > 0;
        const newInfo = hasData
          ? countNewItemsForPage(row.items, page, rowContextItems)
          : { count: null, titles: [] };
        return {
          page,
          hasData,
          newCount: newInfo.count,
          titles: newInfo.titles,
          isCurrent: row.host === currentHost && page === currentPage,
          isListened: page <= listenedUntilPage,
          isProtected: row.host === currentHost || page <= autoMinPage,
        };
      });

      if (row.host !== currentHost) {
        precedingListenedItems.push(...row.items.filter((item) => item.p <= listenedUntilPage));
      }

      return {
        host: row.host,
        listenedUntilPage,
        autoMinPage,
        cells,
      };
    });

    return {
      currentHost,
      currentPage,
      pages,
      rows: modelRows,
    };
  }

  MBE.sourceSelector = {
    buildSourceSelectorModel,
    siteHostFromUrl,
  };
})(globalThis);
