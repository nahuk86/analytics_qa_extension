/**
 * background.js — Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Intercept Adobe Analytics network requests via chrome.webRequest
 *  - Parse GET (querystring) and POST (body) payloads
 *  - Run validation against the active contract for the tab's environment
 *  - Broadcast validated hit records to connected DevTools panels
 *  - Maintain an in-memory hit log per tab (capped at MAX_HITS_PER_TAB)
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_HITS_PER_TAB = 500;

// Pattern that identifies an Adobe Analytics collection request
const AA_PATH_PATTERN = /\/b\/ss\//;

// Domains used by Adobe Analytics
const AA_DOMAINS = ['*.omtrdc.net'];

// ─── In-memory state ─────────────────────────────────────────────────────────

/** @type {Map<number, HitRecord[]>}  tabId → array of hit records */
const hitsByTab = new Map();

/**
 * Connected DevTools panel ports.  Key = tabId (string), value = Port.
 * @type {Map<string, chrome.runtime.Port>}
 */
const panelPorts = new Map();

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Parse a URL query-string or POST body into a plain object.
 * Splits comma-separated values into arrays where appropriate.
 *
 * @param {string} raw  - Raw query-string or body text
 * @returns {Record<string, string|string[]>}
 */
function parsePayload(raw) {
  if (!raw) return {};
  const result = {};
  try {
    const params = new URLSearchParams(raw);
    for (const [key, value] of params.entries()) {
      // Merge duplicate keys into an array
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        result[key] = [].concat(result[key], value);
      } else {
        // Split comma-separated values (common in Adobe Analytics "events" param)
        result[key] = value.includes(',') ? value.split(',').map(v => v.trim()) : value;
      }
    }
  } catch (err) {
    console.error('[AnalyticsQA] Failed to parse payload:', err);
  }
  return result;
}

/**
 * Decode a base64-encoded request body (as returned by chrome.webRequest).
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

/**
 * Determine whether a URL is an Adobe Analytics collection hit.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAnalyticsRequest(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname.endsWith('.omtrdc.net') || parsed.hostname.includes('omtrdc')) &&
      AA_PATH_PATTERN.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// ─── Validation engine integration ───────────────────────────────────────────

/**
 * Load the active contract from chrome.storage.local.
 * Falls back to the bundled contracts.json default.
 *
 * @returns {Promise<ContractMap>}
 */
async function loadActiveContract() {
  return new Promise(resolve => {
    chrome.storage.local.get(['contracts', 'activeContractKey'], result => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      const contracts = result.contracts || {};
      const key = result.activeContractKey || 'default';
      resolve(contracts[key] || contracts['default'] || {});
    });
  });
}

/**
 * Simple inline validator (mirrors validator.js logic for service-worker context).
 * Full validator.js is used in the panel context.
 *
 * @param {Record<string,*>} payload
 * @param {ContractMap} contract
 * @returns {ValidationResult}
 */
function validateHit(payload, contract) {
  const errors = [];
  const warnings = [];

  // Detect which events are present in the hit
  const eventValues = payload['events'];
  const presentEvents = eventValues
    ? (Array.isArray(eventValues) ? eventValues : [eventValues])
    : [];

  // Find matching rule sets by checking if the event name appears in the hit
  let matchedRuleKey = null;
  for (const ruleKey of Object.keys(contract)) {
    if (presentEvents.some(e => e.toLowerCase() === ruleKey.toLowerCase())) {
      matchedRuleKey = ruleKey;
      break;
    }
  }

  // If no specific event matched, try a 'default' rule set
  const ruleSet = matchedRuleKey
    ? contract[matchedRuleKey]
    : (contract['default'] || null);

  if (!ruleSet) {
    return { status: 'WARNING', errors: [], warnings: ['No matching contract rule for this hit.'] };
  }

  // ── Required fields ─────────────────────────────────────────────────────
  for (const field of (ruleSet.required || [])) {
    const val = payload[field];
    if (val === undefined || val === null || val === '') {
      errors.push({ field, rule: 'required', message: `Required field "${field}" is missing or empty.` });
    }
  }

  // ── Rule evaluation ─────────────────────────────────────────────────────
  for (const [field, rule] of Object.entries(ruleSet.rules || {})) {
    const val = payload[field];

    // Skip rule evaluation if field is absent (required check above handles presence)
    if (val === undefined || val === null) continue;

    const strVal = Array.isArray(val) ? val.join(',') : String(val);

    if (rule === 'not_empty') {
      if (strVal.trim() === '') {
        errors.push({ field, rule, message: `Field "${field}" must not be empty.` });
      }
    } else if (rule === 'number') {
      if (isNaN(Number(strVal))) {
        errors.push({ field, rule, message: `Field "${field}" must be a valid number.` });
      }
    } else if (rule === 'uuid') {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(strVal)) {
        errors.push({ field, rule, message: `Field "${field}" must be a valid UUID.` });
      }
    } else if (typeof rule === 'string' && rule.startsWith('contains:')) {
      const expected = rule.split(':')[1];
      const values = Array.isArray(val) ? val : strVal.split(',').map(s => s.trim());
      if (!values.includes(expected)) {
        errors.push({ field, rule, message: `Field "${field}" must contain value "${expected}".` });
      }
    } else if (typeof rule === 'string' && rule.startsWith('enum:')) {
      const allowed = rule.split(':')[1].split('|');
      if (!allowed.includes(strVal)) {
        errors.push({ field, rule, message: `Field "${field}" must be one of: ${allowed.join(', ')}.` });
      }
    } else if (typeof rule === 'string' && rule.startsWith('regex:')) {
      const pattern = rule.slice(6);
      try {
        if (!new RegExp(pattern).test(strVal)) {
          errors.push({ field, rule, message: `Field "${field}" does not match pattern ${pattern}.` });
        }
      } catch {
        warnings.push(`Invalid regex pattern for field "${field}": ${pattern}`);
      }
    }
  }

  // ── Conditional rules ────────────────────────────────────────────────────
  for (const cond of (ruleSet.conditionals || [])) {
    // { if_event: 'purchase', require: ['purchaseID'] }
    const { if_event, require: requires } = cond;
    if (if_event && presentEvents.some(e => e.toLowerCase() === if_event.toLowerCase())) {
      for (const rf of (requires || [])) {
        if (!payload[rf]) {
          errors.push({ field: rf, rule: 'conditional_required', message: `Field "${rf}" is required when event "${if_event}" is present.` });
        }
      }
    }
  }

  const status = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARNING' : 'PASS';
  return { status, errors, warnings };
}

// ─── Hit record creation ──────────────────────────────────────────────────────

/**
 * Build a HitRecord from a web request detail object.
 *
 * @param {chrome.webRequest.WebRequestBodyDetails|chrome.webRequest.WebRequestDetails} details
 * @param {'GET'|'POST'} method
 * @param {string} rawPayload
 * @returns {Promise<HitRecord>}
 */
async function buildHitRecord(details, method, rawPayload) {
  const payload = parsePayload(rawPayload);
  const contract = await loadActiveContract();
  const validation = validateHit(payload, contract);

  /** @type {HitRecord} */
  const record = {
    id: `${details.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    url: details.url,
    method,
    rawPayload,
    payload,
    tabId: details.tabId,
    validation,
  };

  return record;
}

/**
 * Store hit record for a tab and send it to the connected panel (if any).
 *
 * @param {HitRecord} record
 */
function storeAndBroadcast(record) {
  const { tabId } = record;

  // Store in memory
  if (!hitsByTab.has(tabId)) hitsByTab.set(tabId, []);
  const hits = hitsByTab.get(tabId);
  hits.push(record);
  if (hits.length > MAX_HITS_PER_TAB) hits.shift();

  // Persist to chrome.storage for panel re-hydration
  persistHitsForTab(tabId, hits);

  // Send to connected panel
  const port = panelPorts.get(String(tabId));
  if (port) {
    try {
      port.postMessage({ type: 'NEW_HIT', hit: record });
    } catch (err) {
      // Port may have been disconnected
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

/**
 * Handle outgoing GET requests to Adobe Analytics endpoints.
 */
chrome.webRequest.onBeforeRequest.addListener(
  async details => {
    if (!isAnalyticsRequest(details.url)) return;

    let rawPayload = '';
    let method = details.method || 'GET';

    if (method === 'POST' && details.requestBody) {
      const body = details.requestBody;
      if (body.raw) {
        rawPayload = decodeRequestBody(body.raw);
      } else if (body.formData) {
        // formData is an object of key→string[] mappings
        const params = new URLSearchParams();
        for (const [k, vals] of Object.entries(body.formData)) {
          for (const v of vals) params.append(k, v);
        }
        rawPayload = params.toString();
      }
    } else {
      // Extract query-string from URL
      try {
        rawPayload = new URL(details.url).search.slice(1);
      } catch {
        rawPayload = '';
      }
    }

    const record = await buildHitRecord(details, method, rawPayload);
    storeAndBroadcast(record);
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ─── Message / Port Handling ──────────────────────────────────────────────────

/**
 * DevTools panels connect via long-lived ports.
 * The port name encodes the inspected tab id: "analytics-qa-panel-<tabId>"
 */
chrome.runtime.onConnect.addListener(port => {
  const match = port.name.match(/^analytics-qa-panel-(\d+)$/);
  if (!match) return;

  const tabId = match[1];
  panelPorts.set(tabId, port);

  port.onDisconnect.addListener(() => {
    panelPorts.delete(tabId);
  });

  // Send existing hits so the panel can pre-populate on open
  const existing = hitsByTab.get(Number(tabId)) || [];
  port.postMessage({ type: 'INITIAL_HITS', hits: existing });
});

/**
 * One-shot messages from panel / options page.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_HITS') {
    const hits = hitsByTab.get(message.tabId) || [];
    sendResponse({ hits });
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
    const hit = hits.find(h => h.id === hitId);
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
