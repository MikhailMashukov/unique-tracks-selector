(function () {
  'use strict';

  const { browser } = MBE;
  const t = MBE.i18n && MBE.i18n.t ? MBE.i18n.t : (key) => key;

  const scopeValue = document.getElementById('scope-value');
  const scopeInput = document.getElementById('scope-input');
  const scopeEditButton = document.getElementById('scope-edit-button');
  const scopeSaveButton = document.getElementById('scope-save-button');
  const scopeResetButton = document.getElementById('scope-reset-button');
  const previousCount = document.getElementById('previous-count');
  const previousUniqueCount = document.getElementById('previous-unique-count');
  const newCount = document.getElementById('new-count');
  const variantCount = document.getElementById('variant-count');
  const duplicateCount = document.getElementById('duplicate-count');
  const totalCount = document.getElementById('total-count');
  const scopeCount = document.getElementById('scope-count');
  const countsContainer = document.getElementById('counts-container');
  const sourceSelectorContainer = document.getElementById('source-selector-container');
  const errorLine = document.getElementById('error-line');
  const enableToggle = document.getElementById('enable-toggle');
  const debugToggle = document.getElementById('debug-toggle');

  const TAB_STATE_READY_STATUS = 'ready';
  let activeTab = null;
  let currentState = null;
  let refreshTimer = null;
  let autoEnableAttempted = false;
  let currentActivationId = '';
  let sourceSelectorTooltip = null;
  let currentScopeOverride = null;
  let scopeEditing = false;
  let scopeSaving = false;
  let scopeEditOriginalValue = '';
  const sourceSelectorPendingKeys = new Set();

  function applyLocalization(root) {
    const container = root || document;
    container.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    container.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.getAttribute('data-i18n-title'));
    });
    container.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
    });
  }

  function makeActivationId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function diag(event, details) {
    if (!currentState || !currentState.debugEnabled) {
      return;
    }
    console.log('[MusicBrowserExt:popup]', event, {
      activationId: currentActivationId,
      ...details,
    });
  }

  function detectScopeFromUrl(url) {
    try {
      const parsedUrl = new URL(url || '');
      const query = parsedUrl.searchParams.get('q');
      const scopeLabel = MBE.normalize.scopeLabel(query || '');
      return {
        scopeLabel,
        scopeKey: scopeLabel ? MBE.normalize.scopeKey(scopeLabel) : '',
      };
    } catch (error) {
      return {
        scopeLabel: '',
        scopeKey: '',
      };
    }
  }

  function setError(message) {
    if (!message) {
      errorLine.hidden = true;
      errorLine.textContent = '';
      return;
    }
    errorLine.hidden = false;
    errorLine.textContent = message;
  }

  function tabStateKey(tabId) {
    return MBE.paths.tabKey(tabId);
  }

  function getCurrentPageFromUrl(url) {
    if (MBE.normalize && typeof MBE.normalize.pageNumberFromUrl === 'function') {
      try {
        return MBE.normalize.pageNumberFromUrl(url || '');
      } catch (_error) {
        return 1;
      }
    }
    try {
      const parsedUrl = new URL(url || '');
      return Math.max(1, Number(parsedUrl.searchParams.get('page') || 1) || 1);
    } catch (_error) {
      return 1;
    }
  }

  function getCurrentPageUrl() {
    return (currentState && currentState.lastUrl) || (activeTab && activeTab.url) || '';
  }

  function isEditablePageUrl(url) {
    try {
      const parsedUrl = new URL(url || '');
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch (_error) {
      return false;
    }
  }

  function normalizeTabState(rawState) {
    if (!rawState) {
      return null;
    }
    return MBE.storage && MBE.storage.normalizeTabState
      ? MBE.storage.normalizeTabState(rawState)
      : rawState;
  }

  function shouldAutoEnable(state) {
    return !autoEnableAttempted && (!state || (!state.enabled && !state.status));
  }

  function scheduleProcessingRefresh(state) {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (state && state.enabled && state.status === 'processing') {
      refreshTimer = setTimeout(() => {
        refresh().catch(() => {});
      }, 250);
    }
  }

  function clearSourceSelector() {
    if (!sourceSelectorContainer) {
      return;
    }
    hideSourceSelectorTooltip();
    sourceSelectorContainer.hidden = true;
    sourceSelectorContainer.replaceChildren();
  }

  function setScopeEditingMode(enabled) {
    scopeEditing = Boolean(enabled);
    scopeValue.hidden = scopeEditing;
    scopeInput.hidden = !scopeEditing;
    scopeSaveButton.hidden = !scopeEditing;
    scopeEditButton.hidden = scopeEditing;
    scopeResetButton.hidden = scopeEditing || !(currentScopeOverride && currentScopeOverride.scopeLabel);
  }

  function renderScopeControls(visibleScope) {
    if (scopeEditing) {
      return;
    }
    scopeValue.textContent = visibleScope || '-';
    scopeValue.title = currentScopeOverride && currentScopeOverride.scopeLabel
      ? t('manualScopeTitle')
      : t('scopeValueTitle');
    const canEdit = isEditablePageUrl(getCurrentPageUrl());
    scopeValue.disabled = !canEdit;
    scopeEditButton.disabled = !canEdit;
    setScopeEditingMode(false);
  }

  function visibleScopeFromState(state) {
    const urlScope = activeTab && activeTab.url ? detectScopeFromUrl(activeTab.url) : null;
    if (currentScopeOverride && currentScopeOverride.scopeLabel) {
      return currentScopeOverride.scopeLabel;
    }
    if (state && state.scopeLabel) {
      return state.scopeLabel;
    }
    if (urlScope && urlScope.scopeLabel) {
      return urlScope.scopeLabel;
    }
    return '-';
  }

  async function refreshScopeOverride(state) {
    if (!MBE.storage || typeof MBE.storage.getScopeOverrideForUrl !== 'function') {
      currentScopeOverride = null;
      renderScopeControls(visibleScopeFromState(state));
      return;
    }
    const url = getCurrentPageUrl();
    if (!isEditablePageUrl(url)) {
      currentScopeOverride = null;
      renderScopeControls(visibleScopeFromState(state));
      return;
    }
    const requestedState = state;
    const override = await MBE.storage.getScopeOverrideForUrl(url);
    if (requestedState !== currentState) {
      return;
    }
    currentScopeOverride = override || null;
    renderScopeControls(visibleScopeFromState(state));
  }

  function startScopeEdit() {
    if (scopeEditing || !isEditablePageUrl(getCurrentPageUrl())) {
      return;
    }
    scopeEditOriginalValue = scopeValue.textContent === '-' ? '' : scopeValue.textContent;
    scopeInput.value = scopeEditOriginalValue;
    track('scope_edit_started');
    setScopeEditingMode(true);
    scopeInput.focus();
    scopeInput.select();
  }

  function cancelScopeEdit() {
    setError('');
    scopeInput.value = scopeEditOriginalValue;
    setScopeEditingMode(false);
    renderScopeControls(visibleScopeFromState(currentState));
  }

  async function saveScopeEdit() {
    if (!scopeEditing || scopeSaving) {
      return;
    }
    const scopeLabel = MBE.normalize.scopeLabel(scopeInput.value || '');
    if (!scopeLabel) {
      setError(t('errorScopeEmpty'));
      scopeInput.focus();
      return;
    }
    const url = getCurrentPageUrl();
    if (!isEditablePageUrl(url)) {
      setError(t('errorHttpOnly'));
      return;
    }
    if (!MBE.storage || typeof MBE.storage.setScopeOverrideForUrl !== 'function') {
      setError(t('errorScopeEditingUnavailable'));
      return;
    }

    scopeSaving = true;
    scopeSaveButton.disabled = true;
    try {
      await MBE.storage.setScopeOverrideForUrl(url, { scopeLabel });
      currentScopeOverride = await MBE.storage.getScopeOverrideForUrl(url);
      if (currentState) {
        currentState = normalizeTabState({
          ...currentState,
          scopeLabel,
          scopeKey: MBE.normalize.scopeKey(scopeLabel),
        });
      }
      setScopeEditingMode(false);
      renderScopeControls(scopeLabel);
      setError('');
      await reprocessActiveTab();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
      scopeInput.focus();
    } finally {
      scopeSaving = false;
      scopeSaveButton.disabled = false;
    }
  }

  async function resetScopeOverride() {
    const url = getCurrentPageUrl();
    if (!isEditablePageUrl(url) || !currentScopeOverride) {
      return;
    }
    if (!MBE.storage || typeof MBE.storage.clearScopeOverrideForUrl !== 'function') {
      setError(t('errorScopeEditingUnavailable'));
      return;
    }
    scopeResetButton.disabled = true;
    try {
      await MBE.storage.clearScopeOverrideForUrl(url);
      currentScopeOverride = null;
      setScopeEditingMode(false);
      renderScopeControls(visibleScopeFromState(currentState));
      setError('');
      await reprocessActiveTab();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    } finally {
      scopeResetButton.disabled = false;
    }
  }

  function getSourceSelectorTooltip() {
    if (!sourceSelectorTooltip) {
      sourceSelectorTooltip = document.createElement('div');
      sourceSelectorTooltip.className = 'source-selector-tooltip';
      sourceSelectorTooltip.hidden = true;
      document.body.append(sourceSelectorTooltip);
    }
    return sourceSelectorTooltip;
  }

  function hideSourceSelectorTooltip() {
    if (!sourceSelectorTooltip) {
      return;
    }
    sourceSelectorTooltip.hidden = true;
    sourceSelectorTooltip.textContent = '';
  }

  function placeSourceSelectorTooltip(anchor, tooltip) {
    const rect = anchor.getBoundingClientRect();
    const bodyRect = document.body.getBoundingClientRect();
    const popupWidth = bodyRect.width || window.innerWidth || 350;
    const popupHeight = window.innerHeight || document.documentElement.clientHeight || bodyRect.height || 240;
    tooltip.style.maxHeight = '330px';
    const left = Math.max(6, Math.min(rect.left, popupWidth - tooltip.offsetWidth - 6));
    const tooltipHeight = tooltip.offsetHeight || 0;
    let top = rect.bottom + 4;
    if (top + tooltipHeight > popupHeight - 6) {
      top = rect.top - tooltipHeight - 4;
    }
    if (top < 6) {
      top = 6;
      tooltip.style.maxHeight = `${Math.max(80, popupHeight - 12)}px`;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showSourceSelectorTooltip(anchor, titles, event) {
    if (!titles || !titles.length || (event && event.buttons)) {
      hideSourceSelectorTooltip();
      return;
    }
    const tooltip = getSourceSelectorTooltip();
    tooltip.textContent = titles.join('\n');
    tooltip.hidden = false;
    placeSourceSelectorTooltip(anchor, tooltip);
  }

  function formatSourceSelectorTitle(titles) {
    const maxChars = 750;

    const body = titles.join('\n');
    const lineCount = titles.length;
    const charCount = body.length; // UTF-16 code units, как считает JS String.length
    // const prefix = `Строк: ${lineCount}, символов: ${charCount}\n`;

    let result = body;

    if (result.length > maxChars) {
      result = result.slice(0, maxChars - 1) + '…';
    }

    return result;
    
    // const visibleTitles = (titles || []).slice(0, 30);
    // if ((titles || []).length > 30) {
    //   visibleTitles.push('...');
    // }
    // return visibleTitles.join('\n');
  }

  function makeSourceSelectorCell(cell, row, scopeKey) {
    const td = document.createElement('td');
    td.className = 'source-selector__cell';
    if (cell.hasData) {
      td.classList.add('source-selector__cell--data');
      td.textContent = String(cell.newCount);
      if (cell.titles && cell.titles.length) {
        td.setAttribute('title', formatSourceSelectorTitle(cell.titles));
      }
    } else {
      td.classList.add('source-selector__cell--empty');
      td.textContent = '-';
    }
    if (cell.isListened) {
      td.classList.add('source-selector__cell--listened');
    }
    if (cell.isCurrent) {
      td.classList.add('source-selector__cell--current');
    }
    if (cell.isProtected) {
      td.classList.add('source-selector__cell--protected');
    }
    td.addEventListener('click', () => {
      hideSourceSelectorTooltip();
      const pendingKey = `${scopeKey}\n${row.host}`;
      const requestedPage = cell.isListened ? cell.page - 1 : cell.page;
      track('source_selector_clicked');
      if (sourceSelectorPendingKeys.has(pendingKey) || cell.isProtected) {
        return;
      }
      sourceSelectorPendingKeys.add(pendingKey);
      MBE.storage.setSourceListenedUntil(scopeKey, row.host, requestedPage, row.autoMinPage)
        .then(async (scopeData) => {
          renderSourceSelector(scopeKey, scopeData);
          await reprocessActiveTab();
        })
        .catch((error) => setError(error && error.message ? error.message : String(error)))
        .finally(() => {
          sourceSelectorPendingKeys.delete(pendingKey);
        });
    });
    return td;
  }

  async function reprocessActiveTab() {
    if (!activeTab || typeof activeTab.id !== 'number') {
      return;
    }
    const response = await browser.runtime.sendMessage({
      type: 'MBE_REPROCESS_TAB',
      tabId: activeTab.id,
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : t('errorFailedRefreshClassification'));
    }
    const responseState = normalizeTabState(response.tabState);
    if (responseState && responseState.status === 'error') {
      renderState(responseState);
    }
    setError(responseState && responseState.lastError ? responseState.lastError : '');
  }

  function renderSourceSelector(scopeKey, scopeData) {
    if (!sourceSelectorContainer || !MBE.sourceSelector) {
      return;
    }
    const currentUrl = (currentState && currentState.lastUrl) || (activeTab && activeTab.url) || '';
    const currentPage = getCurrentPageFromUrl(currentUrl);
    const model = MBE.sourceSelector.buildSourceSelectorModel(scopeData, {
      currentUrl,
      currentPage,
    });
    sourceSelectorContainer.replaceChildren();
    if (!model.rows.length || !model.pages.length) {
      sourceSelectorContainer.hidden = true;
      return;
    }

    const table = document.createElement('table');
    table.className = 'source-selector';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const sourceHeader = document.createElement('th');
    sourceHeader.className = 'source-selector__host';
    sourceHeader.textContent = t('popupPages');
    sourceHeader.title = t('sourceSelectorTitle');
    headerRow.append(sourceHeader);
    for (const page of model.pages) {
      const th = document.createElement('th');
      th.textContent = String(page);
      headerRow.append(th);
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of model.rows) {
      const tr = document.createElement('tr');
      const hostCell = document.createElement('th');
      hostCell.className = 'source-selector__host';
      hostCell.textContent = row.host.length > 15 ? `${row.host.slice(0, 14)}...` : row.host;
      hostCell.title = row.host;
      tr.append(hostCell);
      for (const cell of row.cells) {
        tr.append(makeSourceSelectorCell(cell, row, scopeKey));
      }
      tbody.append(tr);
    }
    table.append(tbody);
    sourceSelectorContainer.append(table);
    sourceSelectorContainer.hidden = false;
  }

  async function refreshSourceSelector(state) {
    const showTable = Boolean(state && state.enabled && state.status === TAB_STATE_READY_STATUS && !state.lastError && state.scopeKey);
    if (!showTable || !MBE.storage || typeof MBE.storage.readScopeData !== 'function') {
      clearSourceSelector();
      return;
    }
    const scopeData = await MBE.storage.readScopeData(state.scopeKey);
    if (state !== currentState) {
      return;
    }
    renderSourceSelector(state.scopeKey, scopeData);
  }

  function renderState(state) {
    currentState = state;
    const showCounts = Boolean(state && state.enabled && state.status === TAB_STATE_READY_STATUS && !state.lastError);
    countsContainer.hidden = !showCounts;
    if (!showCounts) {
      clearSourceSelector();
    }
    renderScopeControls(visibleScopeFromState(state));
    previousCount.textContent = String(state && state.previousCount ? state.previousCount : 0);
    previousUniqueCount.textContent = String(state && state.previousUniqueCount ? state.previousUniqueCount : 0);
    newCount.textContent = String(state && state.newCount ? state.newCount : 0);
    variantCount.textContent = String(state && state.variantCount ? state.variantCount : 0);
    duplicateCount.textContent = String(state && state.duplicateCount ? state.duplicateCount : 0);
    totalCount.textContent = String(state && state.totalCount ? state.totalCount : 0);
    scopeCount.textContent = String(state && state.storedCount ? state.storedCount : 0);
    enableToggle.checked = Boolean(state && state.enabled);
    debugToggle.checked = Boolean(state && state.debugEnabled);
    debugToggle.disabled = !(state && state.enabled);
    currentActivationId = state && state.activationId ? state.activationId : '';
    refreshScopeOverride(state).catch((error) => setError(error && error.message ? error.message : String(error)));
    refreshSourceSelector(state).catch((error) => setError(error && error.message ? error.message : String(error)));
  }

  // Popup always works with the currently active browser tab.
  async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs.length ? tabs[0] : null;
  }

  async function fetchTabState(tabId) {
    if (MBE.storage && typeof MBE.storage.readTabState === 'function') {
      return MBE.storage.readTabState(tabId);
    }

    const response = await browser.runtime.sendMessage({
      type: 'MBE_GET_TAB_STATE',
      tabId,
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : t('errorCouldNotLoadTabState'));
    }
    return normalizeTabState(response.tabState);
  }

  async function refresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    activeTab = await getActiveTab();
    if (!activeTab || typeof activeTab.id !== 'number') {
      diag('refresh no active tab', {});
      setError(t('errorNoActiveTab'));
      enableToggle.disabled = true;
      renderState(null);
      return;
    }

    if (!activeTab.url) {
      diag('refresh no url', { tabId: activeTab.id });
      setError(t('errorNoTabUrl'));
      enableToggle.disabled = true;
      renderState(null);
      return;
    }

    const url = new URL(activeTab.url);
    const supported = url.protocol === 'http:' || url.protocol === 'https:';
    enableToggle.disabled = !supported;

    if (!supported) {
      setError(t('errorHttpOnly'));
      renderState({
        enabled: false,
        scopeLabel: url.hostname,
        status: 'unsupported',
        contextTrackCount: 0,
        contextUniqueTrackCount: 0,
        previousCount: 0,
        previousUniqueCount: 0,
        newCount: 0,
        variantCount: 0,
        duplicateCount: 0,
      });
      return;
    }

    setError('');
    diag('refresh start', { tabId: activeTab.id, url: activeTab.url });
    let tabState;
    try {
      tabState = await fetchTabState(activeTab.id);
    } catch (error) {
      renderState(null);
      setError(error && error.message ? error.message : String(error));
      return;
    }

    renderState(tabState || null);
    diag('refreshed state', {
      tabId: activeTab.id,
      url: activeTab.url,
      tabState: tabState || null,
    });
    if (tabState && tabState.lastError) {
      setError(tabState.lastError);
    } else {
      setError('');
    }

    if (shouldAutoEnable(tabState)) {
      autoEnableAttempted = true;
      await setTabEnabled(true);
      return;
    }

    scheduleProcessingRefresh(tabState);
  }

  // Enable/disable is tab-scoped.
  async function setTabEnabled(enable) {
    if (!activeTab || typeof activeTab.id !== 'number') {
      return;
    }

    const protocol = activeTab.url ? new URL(activeTab.url).protocol : '';
    if (protocol !== 'http:' && protocol !== 'https:') {
      setError(t('errorHttpOnly'));
      return;
    }

    enableToggle.disabled = true;
    try {
      const urlScope = detectScopeFromUrl(activeTab.url || '');
      const activationId = makeActivationId();
      if (enable) {
        renderState({
          ...(currentState || {}),
          enabled: true,
          debugEnabled: false,
          scopeLabel: currentState && currentState.scopeLabel ? currentState.scopeLabel : urlScope.scopeLabel,
          scopeKey: currentState && currentState.scopeKey ? currentState.scopeKey : urlScope.scopeKey,
          status: 'processing',
          lastError: '',
          activationId,
        });
      }
      diag(enable ? 'enable requested' : 'disable requested', {
        tabId: activeTab.id,
        url: activeTab.url,
        scope: urlScope,
        activationId,
      });
      const response = await browser.runtime.sendMessage({
        type: enable ? 'MBE_ENABLE_TAB' : 'MBE_DISABLE_TAB',
        tabId: activeTab.id,
        url: activeTab.url,
        scopeLabel: currentState && currentState.scopeLabel ? currentState.scopeLabel : urlScope.scopeLabel,
        scopeKey: currentState && currentState.scopeKey ? currentState.scopeKey : urlScope.scopeKey,
        activationId,
      });

      if (!response || !response.ok) {
        renderState(currentState || null);
        setError(response && response.error ? response.error : t('errorFailedUpdateTabState'));
      } else {
        renderState(response.tabState || null);
        diag('toggle response', { response });
        setError(response.tabState && response.tabState.lastError ? response.tabState.lastError : '');
        if (enable) {
          scheduleProcessingRefresh(response.tabState || null);
          await refresh();
        }
      }
    } catch (error) {
      renderState(currentState || null);
      setError(error && error.message ? error.message : String(error));
    } finally {
      enableToggle.disabled = false;
    }
  }

  // Debug mode is persisted in tab state and forwarded to the content script.
  async function setDebugMode(debugEnabled) {
    if (!activeTab || typeof activeTab.id !== 'number') {
      return;
    }
    debugToggle.disabled = true;
    try {
      diag('debug toggle requested', { tabId: activeTab.id, debugEnabled });
      const response = await browser.runtime.sendMessage({
        type: 'MBE_SET_DEBUG',
        tabId: activeTab.id,
        debugEnabled,
      });
      if (!response || !response.ok) {
        setError(response && response.error ? response.error : t('errorFailedUpdateDebug'));
        return;
      }
      renderState(response.tabState || null);
      setError(response.tabState && response.tabState.lastError ? response.tabState.lastError : '');
      await refresh();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    } finally {
      debugToggle.disabled = !(currentState && currentState.enabled);
    }
  }

  enableToggle.addEventListener('change', () => {
    const enable = enableToggle.checked;
    track(enable ? 'enable_clicked' : 'disable_clicked', {
      tabId: activeTab && activeTab.id,
    });
    setTabEnabled(enable).catch((error) => setError(error && error.message ? error.message : String(error)));
  });

  debugToggle.addEventListener('change', () => {
    setDebugMode(debugToggle.checked).catch((error) => setError(error && error.message ? error.message : String(error)));
  });

  scopeValue.addEventListener('click', startScopeEdit);
  scopeEditButton.addEventListener('click', startScopeEdit);
  scopeSaveButton.addEventListener('click', () => {
    saveScopeEdit().catch((error) => setError(error && error.message ? error.message : String(error)));
  });
  scopeResetButton.addEventListener('click', () => {
    resetScopeOverride().catch((error) => setError(error && error.message ? error.message : String(error)));
  });
  scopeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelScopeEdit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      saveScopeEdit().catch((error) => setError(error && error.message ? error.message : String(error)));
    }
  });
  scopeInput.addEventListener('blur', () => {
    if (scopeEditing) {
      saveScopeEdit().catch((error) => setError(error && error.message ? error.message : String(error)));
    }
  });

  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !activeTab || typeof activeTab.id !== 'number') {
        return;
      }
      const change = changes[tabStateKey(activeTab.id)];
      if (!change) {
        return;
      }
      const state = normalizeTabState(change.newValue);
      renderState(state);
      diag('storage session changed', { state });
      setError(state && state.lastError ? state.lastError : '');
      scheduleProcessingRefresh(state);
    });
  }

  applyLocalization(document);
  track('popup_opened');
  refresh().catch((error) => {
    renderState(null);
    setError(error && error.message ? error.message : String(error));
  });

  window.addEventListener('unload', () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  });
})();
