/**
 * background.js — Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Intercept Adobe Analytics network requests via chrome.webRequest
 *    · AppMeasurement hits: *.omtrdc.net/b/ss/  (GET or POST, URL-encoded)
 *    · AEP Web SDK hits:    *.adobedc.net/ee/   (POST, JSON body)
 *  - Parse payloads (URL-encoded or JSON) using utils/parser.js
 *  - Normalise AppMeasurement context-data variables (c. prefix)
 *  - Extract report-suite ID and hit type from each request
 *  - Run validation against the active contract
 *  - Broadcast validated hit records to connected DevTools panels
 *  - Maintain an in-memory hit log per tab (capped at MAX_HITS_PER_TAB)
 */

'use strict';

// Import shared parser and validator so we don't duplicate logic
importScripts('utils/parser.js');
importScripts('validator.js');

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_HITS_PER_TAB = 500;

// Pattern that identifies an AppMeasurement collection path
const AA_PATH_PATTERN  = /\/b\/ss\//;

// Pattern that identifies an AEP Web SDK (alloy.js) Edge Network path
const AEP_PATH_PATTERN = /\/ee\//;

// ─── In-memory state ─────────────────────────────────────────────────────────

/** @type {Map<number, HitRecord[]>}  tabId → array of hit records */
const hitsByTab = new Map();

/**
 * Connected DevTools panel ports.  Key = tabId (string), value = Port.
 * @type {Map<string, chrome.runtime.Port>}
 */
const panelPorts = new Map();

// ─── URL / request classification ────────────────────────────────────────────

/**
 * Return true when the URL is an AppMeasurement collection hit
 * (*.omtrdc.net/b/ss/ or CNAME-based servers using the same path).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAppMeasurementRequest(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      (hostname.endsWith('.omtrdc.net') || hostname === 'omtrdc.net') &&
      AA_PATH_PATTERN.test(pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Return true when the URL is an AEP Web SDK (alloy.js) Edge Network request.
 * These go to *.adobedc.net/ee/ and carry a JSON POST body.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAEPRequest(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.endsWith('.adobedc.net') && AEP_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Return true when the URL is any Adobe Analytics request the extension should capture.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAnalyticsRequest(url) {
  return isAppMeasurementRequest(url) || isAEPRequest(url);
}

// ─── Payload decoding ─────────────────────────────────────────────────────────

/**
 * Decode a raw ArrayBuffer request body (as returned by chrome.webRequest).
 *
 * @param {chrome.webRequest.UploadData[]} rawBody
 * @returns {string}
 */
function decodeRequestBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return '';
  try {
    const bytes = rawBody[0].bytes;
    if (!bytes) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch (err) {
    console.error('[AnalyticsQA] Failed to decode request body:', err);
    return '';
  }
}

// ─── Metadata extraction ──────────────────────────────────────────────────────

/**
 * Extract the report suite ID from an AppMeasurement URL path (/b/ss/<RSID>/).
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractReportSuiteId(url) {
  try {
    const match = new URL(url).pathname.match(/\/b\/ss\/([^/]+)\//);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect the hit type from a parsed payload.
 *
 * AppMeasurement uses the "pe" (page event) parameter:
 *   lnk_o → custom link
 *   lnk_d → download link
 *   lnk_e → exit link
 *   (absent) → page view
 *
 * AEP Web SDK uses xdm.eventType (stored as _eventType):
 *   web.webpagedetails.pageViews   → pageView
 *   web.webInteraction.linkClicks  → linkTrack
 *
 * @param {Record<string,*>} payload
 * @returns {'pageView'|'customLink'|'downloadLink'|'exitLink'|'linkTrack'|'other'}
 */
function detectHitType(payload) {
  const pe = payload['pe'];
  if (pe === 'lnk_o') return 'customLink';
  if (pe === 'lnk_d') return 'downloadLink';
  if (pe === 'lnk_e') return 'exitLink';

  const eventType = payload['_eventType'] || '';
  if (eventType.includes('pageView') || eventType.includes('pageviews')) return 'pageView';
  if (eventType.includes('link') || eventType.includes('interaction'))   return 'linkTrack';

  return 'pageView'; // default for standard image requests with no "pe"
}

// ─── Validation engine integration ───────────────────────────────────────────

/**
 * Load the active contract from chrome.storage.local.
 * Falls back to the 'default' key if no specific contract is active.
 *
 * @returns {Promise<Record<string,*>>}
 */
async function loadActiveContract() {
  return new Promise(resolve => {
    chrome.storage.local.get(['contracts', 'activeContractKey'], result => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      const contracts = result.contracts || {};
      const key       = result.activeContractKey || 'default';
      resolve(contracts[key] || contracts['default'] || {});
    });
  });
}

// ─── Hit record creation ──────────────────────────────────────────────────────

/**
 * Build a HitRecord from a web request and its decoded payload string.
 * Handles both AppMeasurement (URL-encoded) and AEP Web SDK (JSON) payloads.
 *
 * @param {chrome.webRequest.WebRequestBodyDetails} details
 * @param {'GET'|'POST'} method
 * @param {string} rawPayload  - Decoded POST body or URL querystring
 * @param {boolean} isAEP      - True when the request is an AEP Web SDK call
 * @returns {Promise<HitRecord[]>}  Usually one item; AEP batches may yield several
 */
async function buildHitRecords(details, method, rawPayload, isAEP) {
  const contract = await loadActiveContract();

  let payloads;
  if (isAEP) {
    // AEP Web SDK → parse JSON, returns one object per event in the batch
    payloads = parseAEPPayload(rawPayload);
  } else {
    // AppMeasurement → parse URL-encoded, then normalise context-data
    payloads = [flattenContextData(parsePayload(rawPayload))];
  }

  return payloads.map((payload, index) => {
    const validation    = validateHit(payload, contract);
    const reportSuiteId = isAEP ? null : extractReportSuiteId(details.url);
    const hitType       = detectHitType(payload);

    return {
      id: `${details.tabId}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      timestamp:    Date.now(),
      url:          details.url,
      method,
      rawPayload,
      payload,
      tabId:        details.tabId,
      validation,
      reportSuiteId,
      hitType,
      isAEP,
    };
  });
}

// ─── State management ─────────────────────────────────────────────────────────

/**
 * Store hit records for a tab and notify the connected DevTools panel.
 *
 * @param {HitRecord} record
 */
function storeAndBroadcast(record) {
  const { tabId } = record;

  if (!hitsByTab.has(tabId)) hitsByTab.set(tabId, []);
  const hits = hitsByTab.get(tabId);
  hits.push(record);
  if (hits.length > MAX_HITS_PER_TAB) hits.shift();

  persistHitsForTab(tabId, hits);

  const port = panelPorts.get(String(tabId));
  if (port) {
    try {
      port.postMessage({ type: 'NEW_HIT', hit: record });
    } catch {
      panelPorts.delete(String(tabId));
    }
  }
}

/**
 * Persist hit array to chrome.storage.local (JSON-safe).
 *
 * @param {number} tabId
 * @param {HitRecord[]} hits
 */
function persistHitsForTab(tabId, hits) {
  const key = `hits_${tabId}`;
  chrome.storage.local.set({ [key]: hits }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[AnalyticsQA] Storage error:', chrome.runtime.lastError.message);
    }
  });
}

// ─── Web Request Listener ─────────────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  async details => {
    if (!isAnalyticsRequest(details.url)) return;

    const method = details.method || 'GET';
    const isAEP  = isAEPRequest(details.url);
    let rawPayload = '';

    if (method === 'POST' && details.requestBody) {
      const body = details.requestBody;
      if (body.raw) {
        rawPayload = decodeRequestBody(body.raw);
      } else if (body.formData) {
        const params = new URLSearchParams();
        for (const [k, vals] of Object.entries(body.formData)) {
          for (const v of vals) params.append(k, v);
        }
        rawPayload = params.toString();
      }
    } else {
      try {
        rawPayload = new URL(details.url).search.slice(1);
      } catch {
        rawPayload = '';
      }
    }

    const records = await buildHitRecords(details, method, rawPayload, isAEP);
    for (const record of records) {
      storeAndBroadcast(record);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ─── Message / Port Handling ──────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  const match = port.name.match(/^analytics-qa-panel-(\d+)$/);
  if (!match) return;

  const tabId = match[1];
  panelPorts.set(tabId, port);

  port.onDisconnect.addListener(() => {
    panelPorts.delete(tabId);
  });

  const existing = hitsByTab.get(Number(tabId)) || [];
  port.postMessage({ type: 'INITIAL_HITS', hits: existing });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_HITS') {
    sendResponse({ hits: hitsByTab.get(message.tabId) || [] });
    return true;
  }

  if (message.type === 'CLEAR_HITS') {
    hitsByTab.delete(message.tabId);
    chrome.storage.local.remove(`hits_${message.tabId}`);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'SAVE_BASELINE') {
    const { tabId, hitId } = message;
    const hits = hitsByTab.get(tabId) || [];
    const hit  = hits.find(h => h.id === hitId);
    if (hit) {
      chrome.storage.local.set({ [`baseline_${tabId}`]: hit }, () => {
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: false, error: 'Hit not found' });
    }
    return true;
  }

  if (message.type === 'GET_BASELINE') {
    chrome.storage.local.get(`baseline_${message.tabId}`, result => {
      sendResponse({ baseline: result[`baseline_${message.tabId}`] || null });
    });
    return true;
  }
});

