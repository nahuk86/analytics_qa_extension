/**
 * utils/diff.js — Structural diff utility
 *
 * Compares two parsed Adobe Analytics payload objects and returns a structured
 * description of what changed: added keys, removed keys, and changed values.
 *
 * Used by the Snapshot / Baseline comparison feature in the DevTools panel.
 */

'use strict';

/**
 * @typedef {Object} DiffEntry
 * @property {'added'|'removed'|'changed'} type
 * @property {string} key
 * @property {*} [baseline]   Value in the baseline (absent for 'added')
 * @property {*} [current]    Value in the current hit (absent for 'removed')
 */

/**
 * Compute the structural diff between a baseline payload and a current payload.
 *
 * @param {Record<string, *>} baseline  Saved baseline hit payload
 * @param {Record<string, *>} current   Current hit payload to compare
 * @returns {DiffEntry[]}
 *
 * @example
 * diffPayloads({ eVar1: 'user1', events: ['event1'] }, { eVar1: 'user2', newProp: 'x' })
 * // → [
 * //   { type: 'changed', key: 'eVar1', baseline: 'user1', current: 'user2' },
 * //   { type: 'removed', key: 'events', baseline: ['event1'] },
 * //   { type: 'added',   key: 'newProp', current: 'x' },
 * // ]
 */
function diffPayloads(baseline, current) {
  const diffs = [];

  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const key of allKeys) {
    const inBaseline = Object.prototype.hasOwnProperty.call(baseline, key);
    const inCurrent = Object.prototype.hasOwnProperty.call(current, key);

    if (inBaseline && !inCurrent) {
      diffs.push({ type: 'removed', key, baseline: baseline[key] });
    } else if (!inBaseline && inCurrent) {
      diffs.push({ type: 'added', key, current: current[key] });
    } else if (inBaseline && inCurrent) {
      if (!_deepEqual(baseline[key], current[key])) {
        diffs.push({ type: 'changed', key, baseline: baseline[key], current: current[key] });
      }
    }
  }

  // Sort: changed first, then removed, then added (most actionable first)
  const ORDER = { changed: 0, removed: 1, added: 2 };
  diffs.sort((a, b) => ORDER[a.type] - ORDER[b.type]);

  return diffs;
}

/**
 * Deep equality check for payload values (strings, arrays of strings).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function _deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return false;
}

/**
 * Render diff entries as a human-readable summary string (useful for export).
 *
 * @param {DiffEntry[]} diffs
 * @returns {string}
 */
function formatDiff(diffs) {
  if (diffs.length === 0) return 'No differences found.';
  return diffs.map(d => {
    const val = v => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
    switch (d.type) {
      case 'changed': return `CHANGED  ${d.key}: ${val(d.baseline)} → ${val(d.current)}`;
      case 'removed': return `REMOVED  ${d.key}: ${val(d.baseline)}`;
      case 'added':   return `ADDED    ${d.key}: ${val(d.current)}`;
      default:        return `UNKNOWN  ${d.key}`;
    }
  }).join('\n');
}

// Export for use as ES module and CommonJS (tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffPayloads, formatDiff };
}
