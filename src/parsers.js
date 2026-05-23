'use strict';

// Parsers for track lists from various music sites.
// Designed to work both in browser (content script) and Node.js (via jsdom).

function createParsers({ normalize, text, log }) {

  function isVisible(element) {
    // In Node.js (jsdom) environment, assume all elements are visible
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return true;
    }
    if (!(element instanceof Element)) {
      return false;
    }
    const rects = element.getClientRects();
    if (!rects || rects.length === 0) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function chooseTrackNode(node) {
    let current = node;
    for (let depth = 0; depth < 4 && current && current.parentElement; depth += 1) {
      const parent = current.parentElement;
      const tag = parent.tagName;
      if (tag === 'LI' || tag === 'TR' || tag === 'ARTICLE' || tag === 'SECTION' || parent.getAttribute('role') === 'row') {
        return parent;
      }
      if (parent.children.length > 0 && parent.children.length <= 6 && normalize.whitespace(parent.innerText || '').length <= 220) {
        return parent;
      }
      current = parent;
    }
    return node;
  }

  function extractDurationFromNode(node) {
    const textContent = normalize.whitespace(node.innerText || node.textContent || '');
    const duration = text.parseDurationSeconds(textContent);
    if (duration != null) {
      return duration;
    }

    const siblings = [];
    if (node.parentElement) {
      siblings.push(...Array.from(node.parentElement.querySelectorAll('span, small, time, div, p')));
    }

    for (const sibling of siblings) {
      if (sibling === node || !isVisible(sibling)) {
        continue;
      }
      const siblingDuration = text.parseDurationSeconds(normalize.whitespace(sibling.innerText || sibling.textContent || ''));
      if (siblingDuration != null) {
        return siblingDuration;
      }
    }
    return null;
  }

  function parseArtistAndTitle(rowText, scopeContext) {
    const stripped = text.stripDurationFromText(rowText);
    const parts = stripped.split(/\s+[—–-]\s+/);
    if (parts.length >= 2) {
      const artist = normalize.scopeLabel(parts.shift());
      const title = normalize.scopeLabel(parts.join(' - '));
      if (artist && title) {
        return { artist, title };
      }
    }

    return {
      artist: scopeContext.scopeLabel || '',
      title: normalize.scopeLabel(stripped),
    };
  }

  function isTrackishText(textValue) {
    const text = normalize.whitespace(textValue);
    if (text.length < 4 || text.length > 220) {
      return false;
    }
    if (/\b\d{1,2}:\d{2}\b/.test(text)) {
      return true;
    }
    if (/\s+[—–-]\s+/.test(text)) {
      return true;
    }
    if (/\b(?:mp3|track|song|download|remix|mix|edit|version|live)\b/i.test(text)) {
      return true;
    }
    return false;
  }

  function scoreCandidateNode(node) {
    if (!(node instanceof Element) || !isVisible(node)) {
      return -Infinity;
    }

    if (node.closest('nav, header, footer, aside, [role="navigation"]')) {
      return -Infinity;
    }

    const textValue = normalize.whitespace(node.innerText || node.textContent || '');
    if (!isTrackishText(textValue) && node.tagName !== 'A') {
      return -Infinity;
    }

    let score = 0;
    if (/\b\d{1,2}:\d{2}\b/.test(textValue)) {
      score += 3;
    }
    if (/\s+[—–-]\s+/.test(textValue)) {
      score += 2;
    }
    if (/\b(?:remix|mix|edit|version|live|extended|radio)\b/i.test(textValue)) {
      score += 1;
    }
    if (node.tagName === 'A') {
      score += 2;
    }
    if (node.tagName === 'LI' || node.tagName === 'TR' || node.getAttribute('role') === 'row') {
      score += 2;
    }
    if (node.className && /track|song|result|release/i.test(String(node.className))) {
      score += 1;
    }
    if (node.textContent && normalize.whitespace(node.textContent).length > 0) {
      score += 1;
    }
    return score;
  }

  function collectCandidateNodes(root) {
    const selector = [
      'a',
      'li',
      'tr',
      '[role="row"]',
      '[class*="track"]',
      '[class*="song"]',
      '[class*="result"]',
      '[class*="release"]',
    ].join(',');

    const nodes = new Set();
    for (const node of root.querySelectorAll(selector)) {
      if (!(node instanceof Element)) {
        continue;
      }
      if (scoreCandidateNode(node) < 0) {
        continue;
      }
      nodes.add(chooseTrackNode(node));
    }
    const filtered = Array.from(nodes)
      .filter((node) => node instanceof Element && isVisible(node))
      .filter((node) => scoreCandidateNode(node) >= 0);
    const result = filtered.filter((node) => {
      for (const other of filtered) {
        if (other !== node && other.contains(node)) {
          return false;
        }
      }
      return true;
    });
    if (log) log.debug('candidate nodes collected', {
      selector,
      selected: result.length,
      sample: result.slice(0, 8).map((node) => normalize.whitespace(node.innerText || node.textContent || '').slice(0, 160)),
    });
    return result;
  }

  function buildTrackRecord(id, node, rawArtist, rawTitle, duration, scopeLabel) {
    const baseArtist = rawArtist || scopeLabel || '';
    const exactTitle = normalize.titleExact(rawTitle);
    const variantTitle = normalize.titleVariant(rawTitle, scopeLabel);
    const variantArtist = normalize.artistVariant
      ? normalize.artistVariant(baseArtist, scopeLabel)
      : normalize.artistExact(baseArtist);
    return {
      id,
      node,
      artist: baseArtist,
      title: rawTitle,
      duration: duration != null ? duration : undefined,
      baseKey: `${normalize.artistExact(baseArtist)}|${exactTitle}`,
      k: `${variantArtist}|${normalize.forSimilarity(variantTitle)}`,
      n: variantTitle || rawTitle,
      v: normalize.extractVariantStr(rawTitle),
    };
  }

  // Structured adapter for hitmoz sites
  function extractHitmozTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const structuredRows = Array.from(document.querySelectorAll('li.tracks__item[data-musmeta]'));

    if (structuredRows.length > 0) {
      const tracks = [];

      for (const row of structuredRows) {
        if (!isVisible(row)) {
          continue;
        }

        let musMeta = null;
        try {
          musMeta = JSON.parse(row.getAttribute('data-musmeta') || '');
        } catch (e) {
          // ignore malformed JSON
        }

        const titleEl = row.querySelector('.track__title');
        const descEl = row.querySelector('.track__desc');
        const timeEl = row.querySelector('.track__fulltime');

        const rawTitle = normalize.whitespace(
          (titleEl && (titleEl.innerText || titleEl.textContent)) ||
          (musMeta && musMeta.title) || '',
        );
        const rawArtist = normalize.whitespace(
          (descEl && (descEl.innerText || descEl.textContent)) ||
          (musMeta && musMeta.artist) || scopeLabel,
        );

        if (!rawTitle) {
          continue;
        }

        const durationSec = timeEl
          ? text.parseDurationSeconds(normalize.whitespace(timeEl.innerText || timeEl.textContent || ''))
          : null;

        tracks.push(buildTrackRecord(tracks.length, row, rawArtist, rawTitle, durationSec, scopeLabel));
      }

      if (log) log.debug('hitmoz structured tracks extracted', {
        scopeLabel,
        rows: structuredRows.length,
        tracks: tracks.length,
        sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
      });
      return tracks;
    }

    return extractGenericTracks(document, scopeContext);
  }

  // Adapter for mp3party.net
  function extractMp3partyTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('div.track.song-item'));

    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }

      const panel = row.querySelector('[data-js-artist-name]');
      const rawArtist = panel
        ? normalize.whitespace(panel.getAttribute('data-js-artist-name') || '')
        : scopeLabel;
      const rawTitle = panel
        ? normalize.whitespace(panel.getAttribute('data-js-song-title') || '')
        : '';

      if (!rawTitle) {
        continue;
      }

      const durationEl = row.querySelector('.track__info-item');
      const durationSec = durationEl
        ? text.parseDurationSeconds(normalize.whitespace(durationEl.textContent || ''))
        : null;

      tracks.push(buildTrackRecord(tracks.length, row, rawArtist, rawTitle, durationSec, scopeLabel));
    }

    if (log) log.debug('mp3party tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });

    return tracks.length > 0 ? tracks : extractGenericTracks(document, scopeContext);
  }

  // Adapter for themp3.info artist pages.
  function extractTheMp3Tracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('li.__adv_list_track'));
    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }

      const artistEl = row.querySelector('.playlist-name-artist a');
      const titleEl = row.querySelector('.playlist-name-title a');
      const durationEl = row.querySelector('.playlist-duration');

      const rawArtist = normalize.whitespace(
        artistEl ? (artistEl.textContent || artistEl.getAttribute('title') || '') : '',
      ) || scopeLabel;
      const rawTitle = normalize.whitespace(
        titleEl ? (titleEl.textContent || titleEl.getAttribute('title') || '') : '',
      );

      if (!rawTitle) {
        continue;
      }

      const durationSec = durationEl
        ? text.parseDurationSeconds(normalize.whitespace(durationEl.textContent || ''))
        : null;

      tracks.push(buildTrackRecord(tracks.length, row, rawArtist, rawTitle, durationSec, scopeLabel));
    }

    if (log) log.debug('themp3 tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });

    return tracks.length > 0 ? tracks : extractGenericTracks(document, scopeContext);
  }

  // Adapter for vk.com/audio
  function extractVkTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('div.audio_row'));

    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }

      let tuple = null;
      try {
        const raw = row.getAttribute('data-audio');
        if (raw) tuple = JSON.parse(raw);
      } catch (e) {}
      if (!Array.isArray(tuple)) {
        continue;
      }

      const rawTitle = normalize.whitespace(String(tuple[3] || '').replace(/<[^>]+>/g, ''));
      const rawArtist = normalize.whitespace(String(tuple[4] || '').replace(/<[^>]+>/g, '')) || scopeLabel;
      if (!rawTitle) {
        continue;
      }

      const durationSec = tuple[5] ? Number(tuple[5]) || null : null;

      tracks.push(buildTrackRecord(tracks.length, row, rawArtist, rawTitle, durationSec, scopeLabel));
    }

    if (log) log.debug('vk tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });

    return tracks.length > 0 ? tracks : extractGenericTracks(document, scopeContext);
  }

  // Generic heuristic extractor
  function extractGenericTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rawNodes = collectCandidateNodes(document);
    const tracks = [];

    for (const node of rawNodes) {
      const rowNode = chooseTrackNode(node);
      const rowText = normalize.whitespace(rowNode.innerText || rowNode.textContent || '');
      const hasLinkChild = rowNode.tagName === 'A' || Boolean(rowNode.querySelector('a'));
      if (!isTrackishText(rowText) && !hasLinkChild && rowText.length < 6) {
        continue;
      }

      const duration = extractDurationFromNode(rowNode);
      const { artist, title } = parseArtistAndTitle(rowText, scopeContext);
      const textOnlyTitle = title || rowText;
      const baseArtist = artist || scopeLabel || '';

      tracks.push(buildTrackRecord(tracks.length, rowNode, baseArtist, textOnlyTitle, duration, scopeLabel));
    }

    if (log) log.debug('generic tracks extracted', {
      scopeLabel,
      rawNodes: rawNodes.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });
    return tracks;
  }

  // my.mail.ru artist/top page
  function extractMailRuTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('.song-item'));
    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }
      const dataFile = row.getAttribute('data-file') || '';

      const titleAnchor = row.querySelector('.songs-table__row__col__title--name a');
      const authorAnchor = row.querySelector('.songs-table__row__col__title--author a');
      const timeNode = row.querySelector('.songs-table__row__col--time');

      const title = normalize.whitespace(
        (titleAnchor && (titleAnchor.getAttribute('title') || titleAnchor.textContent)) || '',
      );
      const artist = normalize.whitespace(
        (authorAnchor && authorAnchor.textContent) || scopeLabel || '',
      );
      const duration = timeNode ? text.parseDurationSeconds(normalize.whitespace(timeNode.textContent || '')) : null;

      if (!title) {
        continue;
      }

      const baseArtist = artist || scopeLabel || '';
      const exactTitle = normalize.titleExact(title);
      const variantTitle = normalize.titleVariant(title, scopeLabel);
      const variantArtist = normalize.artistVariant
        ? normalize.artistVariant(baseArtist, scopeLabel)
        : normalize.artistExact(baseArtist);
      const domKey = dataFile
        ? `mailru:${dataFile}`
        : `${normalize.artistExact(baseArtist)}|${exactTitle}|${duration || 0}`;
      const renderPriority = row.closest('.b-music__songs__body') ? 100 : 0;

      tracks.push({
        id: tracks.length,
        node: row,
        artist: baseArtist,
        title,
        duration: duration != null ? duration : undefined,
        baseKey: dataFile
          ? `mailru:${dataFile}`
          : `${normalize.artistExact(baseArtist)}|${exactTitle}`,
        k: `${variantArtist}|${normalize.forSimilarity(variantTitle)}`,
        n: variantTitle || title,
        v: normalize.extractVariantStr(title),
        domKey,
        renderPriority,
      });
    }

    if (log) log.debug('mailru tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((track) => ({
        artist: track.artist,
        title: track.title,
        duration: track.duration || null,
      })),
    });
    return tracks;
  }

  // Web.ligaudio.ru (LightAudio) adapter
  function extractLigAudioTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('div.item.amplitude-song-container'));
    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }
      const dataAudio = row.getAttribute('data-audio') || '';
      const titleEl = row.querySelector('span.title[itemprop="name"]') ||
        row.querySelector('.amplitude-song-name') ||
        row.querySelector('.song-name');
      const artistEl = row.querySelector('span.autor[itemprop="byArtist"]') ||
        row.querySelector('.amplitude-song-artist') ||
        row.querySelector('.song-artist');
      const rawTitle = normalize.whitespace(titleEl ? (titleEl.textContent || titleEl.getAttribute('title') || '') : '');
      const rawArtist = normalize.whitespace(artistEl ? (artistEl.textContent || '') : '') || scopeLabel;
      if (!rawTitle) {
        continue;
      }

      const durationEl = row.querySelector('span.d') ||
        row.querySelector('.amplitude-duration') ||
        row.querySelector('.duration');
      const duration = durationEl ? text.parseDurationSeconds(normalize.whitespace(durationEl.textContent || '')) : null;

      tracks.push(buildTrackRecord(tracks.length, row, rawArtist, rawTitle, duration, scopeLabel));
    }

    if (log) log.debug('ligaudio tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });

    return tracks.length > 0 ? tracks : extractGenericTracks(document, scopeContext);
  }

  function extractAlFannTracks(document, scopeContext) {
    const scopeLabel = scopeContext.scopeLabel || '';
    const rows = Array.from(document.querySelectorAll('li.list-group-item[id^="songli"]'));
    const tracks = [];

    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }

      const titleLink = row.querySelector('a.jp-play-me[data-name]');
      const titleSpan = titleLink ? titleLink.querySelector('span') : null;
      const rawTitle = normalize.whitespace(
        (titleSpan && (titleSpan.innerText || titleSpan.textContent)) ||
        (titleLink && titleLink.getAttribute('data-name')) ||
        '',
      );
      if (!rawTitle) {
        continue;
      }

      const durationNode = row.querySelector('.text-muted.pull-right');
      const duration = durationNode
        ? text.parseDurationSeconds(normalize.whitespace(durationNode.innerText || durationNode.textContent || ''))
        : null;

      tracks.push(buildTrackRecord(tracks.length, row, scopeLabel, rawTitle, duration, scopeLabel));
    }

    if (log) log.debug('al-fann tracks extracted', {
      scopeLabel,
      rows: rows.length,
      tracks: tracks.length,
      sample: tracks.slice(0, 8).map((t) => ({ artist: t.artist, title: t.title, duration: t.duration || null })),
    });

    return tracks.length > 0 ? tracks : extractGenericTracks(document, scopeContext);
  }

  return {
    isVisible,
    chooseTrackNode,
    extractDurationFromNode,
    parseArtistAndTitle,
    isTrackishText,
    scoreCandidateNode,
    collectCandidateNodes,
    buildTrackRecord,
    extractHitmozTracks,
    extractMp3partyTracks,
    extractTheMp3Tracks,
    extractVkTracks,
    extractGenericTracks,
    extractMailRuTracks,
    extractLigAudioTracks,
    extractAlFannTracks,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  // Node.js: create and export parsers directly
  const { MBE } = require('../tests/helpers.js');
  module.exports = createParsers({
    normalize: MBE.normalize,
    text: MBE.text,
    log: null,
  });
} else if (typeof MBE !== 'undefined') {
  MBE.parsers = createParsers({
    normalize: MBE.normalize,
    text: MBE.text,
    log: MBE.debug ? MBE.debug.createLogger('parsers') : null,
  });
}
