(function (global) {
  'use strict';

  const MBE = global.MBE;
  if (!MBE || !MBE.constants || !MBE.normalize || !MBE.text) {
    throw new Error('classification.js must be loaded after shared.js.');
  }

  const { constants, normalize, text } = MBE;
  const MATCH_THRESHOLD = constants.MATCH_THRESHOLD;
  const DURATION_TOLERANCE_SEC = constants.DURATION_TOLERANCE_SEC;

  const normalizeWhitespace = normalize.whitespace;
  const normalizeUnicode = normalize.unicode;
  const normalizePunctuationSpacing = normalize.punctuation;
  const normalizeScopeLabel = normalize.scopeLabel;

  function stripFeatureClause(value) {
    return normalizePunctuationSpacing(value)
      .replace(/\s*[\[(]?\s*(?:feat\.?|ft\.?)\s+[^)\]]+[\])]?\s*$/gi, '')
      .trim();
  }

  function removeBracketGroups(value) {
    let current = normalizePunctuationSpacing(value);
    let previous = null;
    while (current !== previous) {
      previous = current;
      current = current
        .replace(/\([^()]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\{[^{}]*\}/g, ' ');
      current = normalizeWhitespace(current);
    }
    return current;
  }

  function extractVariantStr(title) {
    const matches = [];
    const value = normalizePunctuationSpacing(title);
    const pattern = /\([^()]*\)|\[[^\]]*\]|\{[^{}]*\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      const content = normalizeWhitespace(match[0].slice(1, -1));
      if (content) {
        matches.push(content.toLowerCase());
      }
    }
    return matches.join(' ');
  }

  function bracketContentIncludesScope(title, scopeLabel) {
    const exactScope = normalizeArtistExact(scopeLabel || '');
    if (!exactScope) {
      return false;
    }
    return extractVariantStr(title)
      .split(/\s*[/,;&+]\s*|\s+\band\b\s+/i)
      .map((part) => normalizeArtistExact(part))
      .includes(exactScope);
  }

  function removeStopSuffixes(value) {
    let current = normalizePunctuationSpacing(value);
    let previous = null;
    const suffixes = [
      /(?:^|[\s-])(radio\s+mix|radio\s+edit|extended\s+mix|extended\s+version|extended|club\s+mix|club\s+edit|re-?mix|remix|edit|mix|version|instrumental|acoustic|live)\s*$/i,
      /(?:^|[\s-])v\d+\s*$/i,
    ];
    while (current && current !== previous) {
      previous = current;
      for (const suffix of suffixes) {
        const next = current.replace(suffix, '');
        if (next !== current) {
          current = normalizeWhitespace(next);
        }
      }
    }
    return current;
  }

  function normalizeArtistExact(artist) {
    return stripFeatureClause(artist).toLowerCase();
  }

  function normalizeArtistVariant(artist, scopeLabel) {
    const exactArtist = normalizeArtistExact(artist);
    const exactScope = normalizeArtistExact(scopeLabel);
    if (!exactArtist || !exactScope || exactArtist === exactScope) {
      return exactArtist;
    }

    if (normalizeArtistExact(removeBracketGroups(artist)) === exactScope) {
      return exactScope;
    }

    const artistParts = normalizePunctuationSpacing(artist)
      .toLowerCase()
      .split(/\s*(?:,|&|\+|\band\b|feat\.?|ft\.?)\s*/i)
      .map((part) => normalizeArtistExact(part))
      .filter(Boolean);
    if (artistParts.includes(exactScope)) {
      return exactScope;
    }
    return exactArtist;
  }

  function normalizeScopeSuffixPattern(scopeLabel) {
    const compactScope = normalizeForSimilarity(scopeLabel || '');
    if (!compactScope) {
      return null;
    }
    return new RegExp(`${compactScope}\\s*$`, 'i');
  }

  function normalizeTitleExact(title) {
    let result = stripFeatureClause(title);
    result = normalizeWhitespace(result)
      .replace(/\s+\+\s*$/g, '')
      .replace(/\s*[-|:;,.]+\s*$/g, '')
      .replace(/\s+\(\s*$/g, '')
      .replace(/\s+\[\s*$/g, '')
      .replace(/\s+\{\s*$/g, '')
      .trim();
    return result.toLowerCase();
  }

  function normalizeTitleVariant(title, scopeLabel) {
    let result = stripFeatureClause(removeBracketGroups(title));
    const exactScope = normalizeArtistExact(scopeLabel);
    const titleParts = normalizePunctuationSpacing(result)
      .split(/\s*(?:,|&|\+|\band\b|feat\.?|ft\.?)\s*/i)
      .map((part) => normalizeArtistExact(part))
      .filter(Boolean);
    if (exactScope && titleParts.length > 1 && titleParts.includes(exactScope)) {
      return scopeLabel;
    }
    // Strip social-media annotations appended by users: $$$ separators and bare URLs.
    result = result.replace(/\s+\${2,}[\s\S]*$/, '').trim();
    result = result.replace(/\s+\b[\w-]+\.\w{2,}\s*\/.*$/, '').trim();
    // Some uploads append source/uploader tags after the useful remix marker.
    result = result.replace(/\s+Edit\.Studio\b[\s\S]*$/i, '').trim();
    result = removeStopSuffixes(result);
    result = normalizePunctuationSpacing(result);
    // Remove trailing unclosed bracket (truncated titles from data-musmeta or page rendering).
    result = result.replace(/\s*[([][\s\S]*$/, '').trim();
    result = result.replace(/\s*-\s*$/g, '').trim();
    const scopeSuffix = normalizeScopeSuffixPattern(scopeLabel);
    if (scopeSuffix) {
      const compactResult = normalizeForSimilarity(result);
      if (compactResult !== normalizeForSimilarity(scopeLabel) && scopeSuffix.test(compactResult)) {
        result = result.slice(0, result.length - String(scopeLabel || '').length).trim();
      }
    }
    return result || normalizeTitleExact(title);
  }

  function transliterateForSimilarity(value) {
    const cyrillicMap = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'shch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };
    return String(value || '')
      .split('')
      .map((ch) => {
        const lower = ch.toLowerCase();
        const replacement = cyrillicMap[lower];
        if (replacement === undefined) {
          return ch;
        }
        return ch === lower ? replacement : replacement.toUpperCase();
      })
      .join('');

    /*
    const map = {
      Р°: 'a',
      Р±: 'b',
      РІ: 'v',
      Рі: 'g',
      Рґ: 'd',
      Рµ: 'e',
      С‘: 'e',
      Р¶: 'zh',
      Р·: 'z',
      Рё: 'i',
      Р№: 'y',
      Рє: 'k',
      Р»: 'l',
      Рј: 'm',
      РЅ: 'n',
      Рѕ: 'o',
      Рї: 'p',
      СЂ: 'r',
      СЃ: 's',
      С‚: 't',
      Сѓ: 'u',
      С„: 'f',
      С…: 'h',
      С†: 'ts',
      С‡: 'ch',
      С€: 'sh',
      С‰: 'shch',
      СЉ: '',
      С‹: 'y',
      СЊ: '',
      СЌ: 'e',
      СЋ: 'yu',
      СЏ: 'ya',
    };
    return String(value || '')
      .split('')
      .map((ch) => {
        const lower = ch.toLowerCase();
        const replacement = map[lower];
        if (replacement === undefined) {
          return ch;
        }
        return ch === lower ? replacement : replacement.toUpperCase();
      })
      .join('');
    */
  }

  function normalizeForSimilarity(value) {
    const folded = transliterateForSimilarity(
      normalizeUnicode(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, ''),
    );
    return folded.replace(/[^a-z0-9]+/g, '');
  }

  function jaroWinkler(a, b) {
    const s1 = String(a || '');
    const s2 = String(b || '');
    if (!s1.length || !s2.length) {
      return 0;
    }
    if (s1 === s2) {
      return 1;
    }

    const maxDist = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    let matches = 0;
    for (let i = 0; i < s1.length; i += 1) {
      const start = Math.max(0, i - maxDist);
      const end = Math.min(i + maxDist + 1, s2.length);
      for (let j = start; j < end; j += 1) {
        if (s2Matches[j]) {
          continue;
        }
        if (s1[i] !== s2[j]) {
          continue;
        }
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches += 1;
        break;
      }
    }

    if (!matches) {
      return 0;
    }

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < s1.length; i += 1) {
      if (!s1Matches[i]) {
        continue;
      }
      while (!s2Matches[k]) {
        k += 1;
      }
      if (s1[i] !== s2[k]) {
        transpositions += 1;
      }
      k += 1;
    }

    transpositions /= 2;
    const m = matches;
    const jaro =
      (m / s1.length + m / s2.length + (m - transpositions) / m) / 3;

    let prefix = 0;
    const prefixLimit = 4;
    for (let i = 0; i < Math.min(prefixLimit, s1.length, s2.length); i += 1) {
      if (s1[i] === s2[i]) {
        prefix += 1;
      } else {
        break;
      }
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function isDurationCompatible(existingSeconds, candidateSeconds) {
    if (!existingSeconds || !candidateSeconds) {
      return false;
    }
    return Math.abs(existingSeconds - candidateSeconds) <= DURATION_TOLERANCE_SEC;
  }

  function titleSimilarityKey(item) {
    return normalizeForSimilarity(item.n || normalizeTitleVariant(item.t || '') || normalizeTitleExact(item.t || ''));
  }

  function isVariantMatch(existing, candidate) {
    const existingArtist = normalizeArtistExact(existing.a || '');
    const candidateArtist = normalizeArtistExact(candidate.a || '');
    const existingTitle = normalizeTitleExact(existing.t || '');
    const candidateTitle = normalizeTitleExact(candidate.t || '');
    if (
      existingArtist &&
      candidateArtist &&
      existingTitle &&
      candidateTitle &&
      existingArtist === candidateTitle &&
      existingTitle === candidateArtist
    ) {
      return true;
    }

    const existingKey = normalizeForSimilarity(existing.k || existing.b);
    const candidateKey = normalizeForSimilarity(candidate.k || candidate.b);
    if (!existingKey || !candidateKey) {
      return false;
    }

    if (existing.k && candidate.k && existing.k === candidate.k) {
      return true;
    }

    const score = jaroWinkler(existingKey, candidateKey);
    // The full key contains artist + title. For short unrelated titles by the
    // same artist, the shared artist part can inflate fuzzy similarity.
    const titleScore = jaroWinkler(titleSimilarityKey(existing), titleSimilarityKey(candidate));
    if (score >= MATCH_THRESHOLD && titleScore >= MATCH_THRESHOLD) {
      return true;
    }
    if (
      score >= MATCH_THRESHOLD - 0.05 &&
      titleScore >= MATCH_THRESHOLD - 0.05 &&
      isDurationCompatible(existing.d, candidate.d)
    ) {
      return true;
    }
    return false;
  }

  function makeCandidateRecord(candidate, fallback) {
    const artist = normalizeScopeLabel(candidate.artist || fallback.scopeLabel || '');
    const title = normalizeScopeLabel(candidate.title || '');
    const exactArtist = normalizeArtistExact(artist);
    const scopeLabel = fallback.scopeLabel || '';
    let variantArtist = normalizeArtistVariant(artist, scopeLabel);
    if (variantArtist !== normalizeArtistExact(scopeLabel) && bracketContentIncludesScope(title, scopeLabel)) {
      variantArtist = normalizeArtistExact(scopeLabel);
    }
    const exactTitle = normalizeTitleExact(title);
    const variantTitle = normalizeTitleVariant(title, scopeLabel);
    const baseKey = `${exactArtist}|${exactTitle}`;
    const variantKey = `${variantArtist}|${normalizeForSimilarity(variantTitle || exactTitle)}`;

    return {
      b: baseKey,
      k: variantKey,
      n: variantTitle || title,
      v: extractVariantStr(title),
      d: Number(candidate.duration || 0) || 0,
      p: Number(candidate.pageNumber || fallback.pageNumber || 1) || 1,
      u: normalizeScopeLabel(candidate.firstSeenUrl || fallback.url || ''),
      a: artist,
      t: title,
    };
  }

  function isDuplicateOrVariant(seenItems, candidate) {
    for (const item of seenItems) {
      if (item.b && item.b === candidate.b) {
        return true;
      }
      if (isVariantMatch(item, candidate)) {
        return true;
      }
    }
    return false;
  }

  function countUniqueContextItems(items) {
    const seenItems = [];
    let count = 0;
    for (const item of items || []) {
      if (!item || !item.b) {
        continue;
      }
      if (!isDuplicateOrVariant(seenItems, item)) {
        count += 1;
      }
      seenItems.push(item);
    }
    return count;
  }

  function classifyPageTracks(siteItems, tracks, pageMeta) {
    const currentPage = Number(pageMeta && pageMeta.pageNumber ? pageMeta.pageNumber : 1) || 1;
    const contextItems = Array.isArray(pageMeta && pageMeta.contextItems)
      ? pageMeta.contextItems
      : [];
    const otherPageItems = siteItems.filter((item) => Number(item.p || 1) !== currentPage);
    const hadCurrentPageItems = siteItems.length > otherPageItems.length;
    const items = otherPageItems.slice();

    const earlierSameSiteItems = items.filter((item) => Number(item.p || 1) < currentPage);
    const earlierPageItems = contextItems.concat(earlierSameSiteItems);
    const earlierPageBaseIndex = new Map();
    for (const item of earlierPageItems) {
      if (!earlierPageBaseIndex.has(item.b)) {
        earlierPageBaseIndex.set(item.b, item);
      }
    }
    const allBaseKeys = new Set(items.concat(contextItems).map((item) => item.b));
    // Matching context includes selected SourceSelector pages from other sites
    // plus earlier pages of the current site. These are the records available
    // for duplicate/variant matching before the current page is classified.
    const contextTrackCount = earlierPageItems.length;
    const contextUniqueTrackCount = countUniqueContextItems(earlierPageItems);

    const results = [];
    let newCount = 0;
    let variantCount = 0;
    let duplicateCount = 0;

    const sameRunBaseKeys = new Set();
    const sameRunItems = [];

    for (const track of tracks) {
      const candidate = makeCandidateRecord(track, pageMeta);
      let status = 'new';

      const exactDuplicate = earlierPageBaseIndex.has(candidate.b) || sameRunBaseKeys.has(candidate.b);
      if (exactDuplicate) {
        status = 'duplicate';
        duplicateCount += 1;
      } else {
        let matched = false;
        for (let i = 0; i < earlierPageItems.length; i += 1) {
          if (isVariantMatch(earlierPageItems[i], candidate)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (let i = 0; i < sameRunItems.length; i += 1) {
            if (isVariantMatch(sameRunItems[i], candidate)) {
              matched = true;
              break;
            }
          }
        }

        if (matched) {
          status = 'variant';
          variantCount += 1;
        } else {
          status = 'new';
          newCount += 1;
        }
      }

      sameRunItems.push(candidate);
      sameRunBaseKeys.add(candidate.b);

      if (!allBaseKeys.has(candidate.b)) {
        items.push(candidate);
        allBaseKeys.add(candidate.b);
      }

      results.push({
        id: track.id,
        status,
        artist: candidate.a,
        title: candidate.t,
        duration: candidate.d,
        baseKey: candidate.b,
        variantKey: candidate.k,
        baseName: candidate.n,
        variantStr: candidate.v,
      });
    }

    return {
      items,
      hadCurrentPageItems,
      contextTrackCount,
      contextUniqueTrackCount,
      previousCount: contextTrackCount,
      previousUniqueCount: contextUniqueTrackCount,
      newCount,
      variantCount,
      duplicateCount,
      results,
    };
  }

  MBE.normalize = {
    ...normalize,
    artistExact: normalizeArtistExact,
    artistVariant: normalizeArtistVariant,
    titleExact: normalizeTitleExact,
    titleVariant: normalizeTitleVariant,
    forSimilarity: normalizeForSimilarity,
    extractVariantStr,
  };

  MBE.text = {
    ...text,
    normalizeForSimilarity,
  };

  MBE.similarity = {
    jaroWinkler,
    isVariantMatch,
  };

  MBE.classification = {
    makeCandidateRecord,
    classifyPageTracks,
  };
})(globalThis);
