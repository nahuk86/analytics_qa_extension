/**
 * utils/parser.js — Adobe Analytics payload parser
 *
 * Converts a raw query-string or POST body string into a structured JS object.
 * Special handling:
 *  - Comma-separated "events" values become arrays
 *  - Duplicate keys are merged into arrays
 *  - Numeric strings stay as strings (preserves eVar/prop values)
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
  module.exports = { parsePayload, serializePayload };
}
