/**
 * utils/parser.js — Adobe Analytics payload parser
 *
 * Converts a raw query-string or POST body string into a structured JS object.
 * Special handling:
 *  - Comma-separated "events" values become arrays
 *  - Duplicate keys are merged into arrays
 *  - Numeric strings stay as strings (preserves eVar/prop values)
 *  - AEP Web SDK JSON payloads are parsed via parseAEPPayload()
 *  - AppMeasurement context-data variables (c.varName) are flattened via flattenContextData()
 */

'use strict';

/**
 * Parse a URL-encoded query-string or POST body into a structured object.
 *
 * @param {string} raw  Raw query-string (no leading "?") or POST body text
 * @returns {Record<string, string | string[]>}
 *
 * @example
 * parsePayload('events=event1,event2&eVar1=user123&purchaseID=ABC123')
 * // → { events: ['event1', 'event2'], eVar1: 'user123', purchaseID: 'ABC123' }
 */
function parsePayload(raw) {
  if (!raw || typeof raw !== 'string') return {};

  const result = {};

  let queryString = raw;
  // Strip a leading "?" if present
  if (queryString.startsWith('?')) queryString = queryString.slice(1);

  let params;
  try {
    params = new URLSearchParams(queryString);
  } catch (err) {
    console.error('[AnalyticsQA/parser] URLSearchParams failed:', err);
    return {};
  }

  for (const [key, value] of params.entries()) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;

    // Decide whether to split the value into an array
    const parsed = _splitValue(trimmedKey, value);

    if (Object.prototype.hasOwnProperty.call(result, trimmedKey)) {
      // Merge duplicate keys into an array
      result[trimmedKey] = [].concat(result[trimmedKey], parsed);
    } else {
      result[trimmedKey] = parsed;
    }
  }

  return result;
}

/**
 * Fields whose values should always be split by comma into arrays.
 * This list covers the most common multi-value Adobe Analytics parameters.
 */
const MULTI_VALUE_FIELDS = new Set([
  'events',
  'products',
  'list1', 'list2', 'list3',
]);

/**
 * Split a value into an array when appropriate.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string | string[]}
 */
function _splitValue(key, value) {
  if (MULTI_VALUE_FIELDS.has(key) && value.includes(',')) {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return value;
}

/**
 * Parse an Adobe Experience Platform (AEP) Web SDK JSON POST body into an
 * Adobe Analytics–compatible flat object.
 *
 * AEP Web SDK sends hits as POST to *.adobedc.net/ee/ with a JSON body shaped like:
 *   { "events": [{ "xdm": {...}, "data": { "__adobe": { "analytics": {...} } } }] }
 *
 * This function extracts:
 *  - Adobe Analytics variables from data.__adobe.analytics
 *  - Core XDM fields (eventType, pageName, URL, link info) as _-prefixed metadata
 *  - All events in the batch are returned as separate objects in the returned array
 *
 * @param {string} jsonStr  Raw JSON string (the POST body)
 * @returns {Record<string, string | string[]>[]}  One item per AEP event in the batch
 *
 * @example
 * parseAEPPayload('{"events":[{"xdm":{"eventType":"web.webpagedetails.pageViews","web":{"webPageDetails":{"name":"Home"}}},"data":{"__adobe":{"analytics":{"pageName":"Home","eVar1":"user123","events":"event1"}}}}]}')
 * // → [{ _eventType: 'web.webpagedetails.pageViews', pageName: 'Home', eVar1: 'user123', events: ['event1'] }]
 */
function parseAEPPayload(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return [];

  let body;
  try {
    body = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  // Support both array-of-events and single-event body shapes
  const aepEvents = Array.isArray(body.events) ? body.events
    : (body.xdm ? [body] : []);

  if (aepEvents.length === 0) return [];

  return aepEvents.map(ev => {
    const result = {};
    const xdm  = ev.xdm  || {};
    const data  = ev.data || {};

    // ── XDM metadata (prefixed with _ to distinguish from AA variables) ──
    if (xdm.eventType)                              result._eventType = xdm.eventType;
    if (xdm.web && xdm.web.webPageDetails) {
      const wpd = xdm.web.webPageDetails;
      if (wpd.name)  result.pageName  = wpd.name;
      if (wpd.URL)   result.pageURL   = wpd.URL;
    }
    if (xdm.web && xdm.web.webInteraction) {
      const wi = xdm.web.webInteraction;
      if (wi.name) result._linkName = wi.name;
      if (wi.type) result._linkType = wi.type;
    }
    if (xdm.device && xdm.device.screenWidth)  result._screenWidth  = String(xdm.device.screenWidth);
    if (xdm.device && xdm.device.screenHeight) result._screenHeight = String(xdm.device.screenHeight);
    if (xdm.environment && xdm.environment.browserDetails) {
      const bd = xdm.environment.browserDetails;
      if (bd.userAgent) result._userAgent = bd.userAgent;
    }

    // ── Adobe Analytics data from data.__adobe.analytics ────────────────
    const aaData = (data.__adobe && data.__adobe.analytics) || {};
    for (const [k, v] of Object.entries(aaData)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') {
        // Apply same multi-value splitting as parsePayload
        result[k] = _splitValue(k, v);
      } else if (Array.isArray(v)) {
        result[k] = v;
      } else {
        result[k] = String(v);
      }
    }

    // ── Flat non-__adobe data keys (primitive values only) ───────────────
    for (const [k, v] of Object.entries(data)) {
      if (k === '__adobe') continue;
      if (v !== null && v !== undefined && typeof v !== 'object') {
        if (!Object.prototype.hasOwnProperty.call(result, k)) {
          result[k] = String(v);
        }
      }
    }

    return result;
  });
}

/**
 * Normalise AppMeasurement context-data variables.
 *
 * In the AppMeasurement querystring, context data is sent with a "c." key prefix:
 *   c.myVar=value → key "c.myVar" in the parsed object
 *
 * The sentinel keys "c." (open) and ".c" (close) are also stripped.
 *
 * @param {Record<string, string | string[]>} payload
 * @returns {Record<string, string | string[]>}  New object with "c." prefixes removed
 *
 * @example
 * flattenContextData({ 'c.pageType': 'article', 'pageName': 'Home', 'c.': '', '.c': '' })
 * // → { pageType: 'article', pageName: 'Home' }
 */
function flattenContextData(payload) {
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    // Strip sentinel markers
    if (key === 'c.' || key === '.c') continue;
    // Strip "c." prefix from context-data variables
    if (key.startsWith('c.')) {
      result[key.slice(2)] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Re-serialize a parsed payload back to a URL-encoded query-string.
 * Useful for display and diff purposes.
 *
 * @param {Record<string, string | string[]>} payload
 * @returns {string}
 */
function serializePayload(payload) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      params.set(key, value.join(','));
    } else {
      params.set(key, value);
    }
  }
  return params.toString();
}

// Export for use as ES module (DevTools panel) and CommonJS (tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePayload, parseAEPPayload, flattenContextData, serializePayload };
}

