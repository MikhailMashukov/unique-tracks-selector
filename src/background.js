importScripts(new URL('shared.js', self.location.href).href);
importScripts(new URL('classification.js', self.location.href).href);
importScripts(new URL('storage.js', self.location.href).href);

(function () {
  'use strict';

  const { browser, storage } = MBE;
  const t = MBE.i18n && MBE.i18n.t ? MBE.i18n.t : (key) => key;

  function makeActivationId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function trace(tabState, event, details) {
    if (!tabState || !tabState.debugEnabled) {
      return;
    }
    console.log('[MusicBrowserExt:background]', event, {
      activationId: tabState.activationId || '',
      ...details,
    });
  }

  function warn(tabState, event, details) {
    if (!tabState || !tabState.debugEnabled) {
      return;
    }
    console.warn('[MusicBrowserExt:background]', event, {
      activationId: tabState.activationId || '',
      ...details,
    });
  }

  function traceError(tabState, event, details) {
    if (!tabState || !tabState.debugEnabled) {
      return;
    }
    console.error('[MusicBrowserExt:background]', event, {
      activationId: tabState.activationId || '',
      ...details,
    });
  }

  function isTransientInjectionError(error) {
    const message = error && error.message ? error.message : String(error || '');
    return /showing error page|chrome-error:\/\/chromewebdata|cannot access contents of url|no frame with id/i.test(message);
  }

  function resolveTabId(message, sender) {
    if (typeof message.tabId === 'number' && message.tabId >= 0) {
      return message.tabId;
    }
    if (typeof sender.tab?.id === 'number' && sender.tab.id >= 0) {
      return sender.tab.id;
    }
    return null;
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

  // Injects scripts explicitly so already-open tabs work after extension reload.
  async function ensureContentScripts(tabId, tabState) {
    if (!browser.scripting || !browser.scripting.executeScript) {
      throw new Error(t('errorScriptingUnavailable'));
    }

    trace(tabState, 'inject content scripts', { tabId });
    for (const file of ['shared.js', 'classification.js', 'parsers.js', 'content.js']) {
      trace(tabState, 'inject script start', { tabId, file });
      await browser.scripting.executeScript({
        target: { tabId },
        files: [file],
      });
      trace(tabState, 'inject script done', { tabId, file });
    }
  }

  async function getTabState(tabId) {
    return storage.readTabState(tabId);
  }

  // Stores enabled state and updates the toolbar badge for one browser tab.
  async function enableTab(tabId, scopeLabel, scopeKey, lastUrl, activationId) {
    const detectedScope = detectScopeFromUrl(lastUrl);
    const tabState = await storage.setTabState(tabId, {
      enabled: true,
      debugEnabled: false,        // Default value
      activationId: activationId || makeActivationId(),
      scopeLabel: scopeLabel || detectedScope.scopeLabel || '',
      scopeKey: scopeKey || detectedScope.scopeKey || '',
      status: 'processing',
      lastError: '',
      lastUrl: lastUrl || '',
    });
    await updateActionState(tabId, tabState);
    trace(tabState, 'tab enabled', {
      tabId,
      scopeLabel: tabState.scopeLabel,
      scopeKey: tabState.scopeKey,
      lastUrl: tabState.lastUrl,
    });
    return tabState;
  }

  async function disableTab(tabId) {
    const tabState = {
      enabled: false,
      debugEnabled: false,
      scopeKey: '',
      scopeLabel: '',
      status: 'disabled',
      lastError: '',
      contextTrackCount: 0,
      contextUniqueTrackCount: 0,
      previousCount: 0,
      previousUniqueCount: 0,
      newCount: 0,
      variantCount: 0,
      duplicateCount: 0,
      storedCount: 0,
      totalCount: 0,
      activationId: '',
      lastUrl: '',
      lastUpdatedAt: Date.now(),
    };
    await storage.setTabState(tabId, tabState);
    await updateActionState(tabId, tabState);
    trace(tabState, 'tab disabled', { tabId });
    return tabState;
  }

  async function setDebugMode(tabId, enabled) {
    const tabState = await storage.setTabState(tabId, {
      debugEnabled: Boolean(enabled),
      lastError: '',
    });
    await updateActionState(tabId, tabState);
    trace(tabState, 'debug mode changed', { tabId, debugEnabled: tabState.debugEnabled });
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'MBE_DEBUG_CHANGED',
        debugEnabled: tabState.debugEnabled,
      });
    } catch (error) {
      warn(tabState, 'could not notify content about debug mode', {
        tabId,
        error: error && error.message ? error.message : String(error),
      });
    }
    return tabState;
  }

  async function reprocessTab(tabId) {
    let tabState = await storage.readTabState(tabId);
    if (!tabState.enabled) {
      throw new Error(t('errorTabNotEnabled'));
    }

    const activationId = tabState.activationId || makeActivationId();
    if (!tabState.activationId) {
      tabState = await storage.setTabState(tabId, {
        activationId,
        lastError: '',
      });
    }

    trace(tabState, 'tab reprocess requested', { tabId, activationId });
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'MBE_REPROCESS_PAGE',
        activationId,
        debugEnabled: tabState.debugEnabled,
      });
    } catch (error) {
      const errorMessage = error && error.message ? error.message : String(error);
      warn(tabState, 'could not notify content about reprocess', {
        tabId,
        error: errorMessage,
      });
      try {
        await ensureContentScripts(tabId, tabState);
      } catch (injectError) {
        const injectMessage = injectError && injectError.message ? injectError.message : String(injectError);
        if (isTransientInjectionError(injectError)) {
          warn(tabState, 'content script reprocess injection deferred', {
            tabId,
            error: injectMessage,
          });
          return tabState;
        }
        tabState = await storage.setTabState(tabId, {
          enabled: true,
          status: 'error',
          lastError: `${t('errorCouldNotReprocessPage')}: ${injectMessage}`,
        });
        await updateActionState(tabId, tabState);
        traceError(tabState, 'could not reprocess page', {
          tabId,
          error: injectMessage,
        });
      }
    }
    return tabState;
  }

  // Chrome action state mirrors the tab state: green ON or orange DBG.
  async function updateActionState(tabId, tabState) {
    if (!browser.action) {
      return;
    }
    const enabled = Boolean(tabState && tabState.enabled);
    const debugEnabled = Boolean(tabState && tabState.debugEnabled);
    const badgeText = enabled ? (debugEnabled ? 'DBG' : 'ON') : '';
    const badgeColor = debugEnabled ? '#f59e0b' : '#16a34a';
    await browser.action.setBadgeText({ tabId, text: badgeText });
    await browser.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
    await browser.action.setTitle({
      tabId,
      title: enabled ? t('actionTitleEnabled') : t('actionTitleDefault'),
    });
  }

  // Main bridge from content script to storage classification.
  async function processTracks(tabId, payload) {
    const currentTabState = await storage.readTabState(tabId);
    trace(currentTabState, 'process tracks request', {
      tabId,
      enabled: currentTabState.enabled,
      debugEnabled: currentTabState.debugEnabled,
      activationId: currentTabState.activationId,
      incomingTracks: payload.tracks ? payload.tracks.length : 0,
      scopeKey: payload.scopeKey || currentTabState.scopeKey,
    });
    if (!currentTabState.enabled) {
      throw new Error(t('errorTabNotEnabled'));
    }

    const pageUrl = payload.url || currentTabState.lastUrl || '';
    let scopeLabel = payload.scopeLabel || currentTabState.scopeLabel || '';
    let scopeKey = payload.scopeKey || currentTabState.scopeKey;
    const scopeOverride = pageUrl ? await storage.getScopeOverrideForUrl(pageUrl) : null;
    if (scopeOverride && scopeOverride.scopeLabel) {
      scopeLabel = scopeOverride.scopeLabel;
      scopeKey = MBE.normalize.scopeKey(scopeLabel);
    }

    if (!scopeKey) {
      const updated = await storage.setTabState(tabId, {
        enabled: true,
        status: 'error',
        lastError: t('errorScopeNotDetected'),
        lastUrl: pageUrl,
      });
      trace(updated, 'scope detection failed', {
        tabId,
        url: pageUrl,
      });
      return {
        tabState: updated,
        summary: null,
      };
    }

    let summary;
    try {
      summary = await storage.classifyTracksForScope(
        scopeKey,
        scopeLabel,
        payload.tracks || [],
        {
          url: pageUrl,
          pageNumber: payload.pageNumber || 1,
          scopeLabel,
        },
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const updated = await storage.setTabState(tabId, {
        enabled: true,
        scopeKey,
        scopeLabel,
        status: 'error',
        lastError: message,
        lastUrl: pageUrl,
      });
      traceError(updated, 'classification failed', {
        tabId,
        scopeKey,
        error: message,
      });
      return {
        tabState: updated,
        summary: null,
      };
    }

    const totalCount = await storage.getTotalStoredCount();
    const updated = await storage.setTabState(tabId, {
      enabled: true,
      scopeKey,
      scopeLabel,
      status: 'ready',
      lastError: '',
      contextTrackCount: summary.contextTrackCount,
      contextUniqueTrackCount: summary.contextUniqueTrackCount,
      previousCount: summary.contextTrackCount,
      previousUniqueCount: summary.contextUniqueTrackCount,
      newCount: summary.newCount,
      variantCount: summary.variantCount,
      duplicateCount: summary.duplicateCount,
      storedCount: summary.storedCount,
      totalCount,
      lastUrl: pageUrl,
    });
    await updateActionState(tabId, updated);
    trace(updated, 'tracks processed', {
      tabId,
      scopeKey,
      contextTrackCount: summary.contextTrackCount,
      contextUniqueTrackCount: summary.contextUniqueTrackCount,
      new: summary.newCount,
      variant: summary.variantCount,
      duplicate: summary.duplicateCount,
      stored: summary.storedCount,
      totalCount,
    });

    return {
      tabState: updated,
      summary,
    };
  }

  // Single MV3 message router for popup and content script requests.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message || typeof message !== 'object') {
        return { ok: false, error: 'Invalid message.' };
      }

      switch (message.type) {
        case 'MBE_GET_TAB_STATE': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('tabId is required.');
          }
          const tabState = await getTabState(tabId);
          trace(tabState, 'tab state requested', { tabId });
          return {
            ok: true,
            tabState,
          };
        }
        case 'MBE_ENABLE_TAB': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('tabId is required.');
          }
          const activationId = message.activationId || makeActivationId();
          let tabState = await enableTab(
            tabId,
            message.scopeLabel || '',
            message.scopeKey || '',
            message.url || '',
            activationId,
          );
          try {
            await ensureContentScripts(tabId, tabState);
          } catch (error) {
            const errorMessage = error && error.message ? error.message : String(error);
            if (isTransientInjectionError(error)) {
              tabState = await storage.setTabState(tabId, {
                enabled: true,
                debugEnabled: tabState.debugEnabled,
                activationId,
                status: 'processing',
                lastError: '',
                lastUrl: message.url || tabState.lastUrl || '',
              });
              await updateActionState(tabId, tabState);
              warn(tabState, 'content script injection deferred', {
                tabId,
                error: errorMessage,
              });
              return {
                ok: true,
                tabState,
              };
            }
            tabState = await storage.setTabState(tabId, {
              enabled: true,
              debugEnabled: tabState.debugEnabled,
              activationId,
              status: 'error',
              lastError: `${t('errorCouldNotStartContentScript')}: ${errorMessage}`,
              lastUrl: message.url || tabState.lastUrl || '',
            });
            await updateActionState(tabId, tabState);
            traceError(tabState, 'could not start content script', {
              tabId,
              error: errorMessage,
            });
          }
          return {
            ok: true,
            tabState,
          };
        }
        case 'MBE_DISABLE_TAB': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('tabId is required.');
          }
          const tabState = await disableTab(tabId);
          try {
            await browser.tabs.sendMessage(tabId, {
              type: 'MBE_DISABLE',
            });
          } catch (error) {
            // The tab may already be gone.
          }
          return {
            ok: true,
            tabState,
          };
        }
        case 'MBE_SET_DEBUG': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('tabId is required.');
          }
          return {
            ok: true,
            tabState: await setDebugMode(tabId, message.debugEnabled),
          };
        }
        case 'MBE_REPROCESS_TAB': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('tabId is required.');
          }
          return {
            ok: true,
            tabState: await reprocessTab(tabId),
          };
        }
        case 'MBE_PROCESS_TRACKS': {
          const tabId = resolveTabId(message, sender);
          if (tabId == null) {
            throw new Error('Tab context is required.');
          }
          const result = await processTracks(tabId, message);
          return {
            ok: true,
            ...result,
          };
        }
        default:
          return {
            ok: false,
            error: `Unknown message type: ${message.type}`,
          };
      }
    })()
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error),
        }),
      );
    return true;
  });

  if (browser.tabs && browser.tabs.onRemoved) {
    browser.tabs.onRemoved.addListener((tabId) => {
      storage.clearTabState(tabId).catch(() => {});
    });
  }

  // Авто-активация после перезагрузки/навигации: если вкладка ранее была включена,
  // на каждом полном новом document вновь инжектим content-script; content.js сам
  // читает tab state через MBE_GET_TAB_STATE и запускает обработку.
  if (browser.tabs && browser.tabs.onUpdated) {
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      let tabState;
      try {
        tabState = await storage.readTabState(tabId);
      } catch (error) {
        return;
      }
      if (!tabState || !tabState.enabled) {
        return;
      }
      updateActionState(tabId, tabState).catch(() => {});
      if (changeInfo.status !== 'complete') {
        return;
      }
      try {
        await ensureContentScripts(tabId, tabState);
      } catch (error) {
        warn(tabState, 'auto re-inject failed', {
          tabId,
          error: error && error.message ? error.message : String(error),
        });
        return;
      }
      trace(tabState, 'auto re-activated tab', {
        tabId,
        scopeLabel: tabState.scopeLabel,
        activationId: tabState.activationId,
      });
    });
  }
})();

