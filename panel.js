/**
 * panel.js — DevTools panel logic
 *
 * Responsibilities:
 *  - Connect to background service worker via a long-lived Port
 *  - Receive hit records and render them in the hit list
 *  - Show detailed payload, validation results, and diff in the detail pane
 *  - Filtering by status and event name
 *  - Export JSON report
 *  - Clear hits
 *  - Save / compare baseline snapshots
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {HitRecord[]} All received hit records (unfiltered) */
let allHits = [];

/** @type {string|null} Currently selected hit id */
let selectedHitId = null;

/** @type {HitRecord|null} Saved baseline hit */
let baseline = null;

// ─── DevTools context ─────────────────────────────────────────────────────────

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

// ─── Port connection to background ───────────────────────────────────────────

let port = null;

function connectPort() {
  port = chrome.runtime.connect({
    name: `analytics-qa-panel-${inspectedTabId}`,
  });

  port.onMessage.addListener(handlePortMessage);

  port.onDisconnect.addListener(() => {
    // Reconnect after a short delay (service worker may have been recycled)
    setTimeout(connectPort, 1000);
  });
}

connectPort();

// ─── Message handling ─────────────────────────────────────────────────────────

/**
 * Handle messages from the background service worker.
 * @param {{ type: string, hits?: HitRecord[], hit?: HitRecord }} msg
 */
function handlePortMessage(msg) {
  if (msg.type === 'INITIAL_HITS') {
    allHits = msg.hits || [];
    renderHitList();
  } else if (msg.type === 'NEW_HIT') {
    allHits.push(msg.hit);
    renderHitList();
    // Auto-scroll hit list to bottom
    const list = document.getElementById('hit-list');
    list.scrollTop = list.scrollHeight;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/** @returns {HitRecord[]} Filtered hits based on current filter values */
function getFilteredHits() {
  const statusFilter  = document.getElementById('filter-status').value;
  const typeFilter    = document.getElementById('filter-type').value;
  const eventFilter   = document.getElementById('filter-event').value.toLowerCase().trim();

  return allHits.filter(hit => {
    if (statusFilter && hit.validation.status !== statusFilter) return false;
    if (typeFilter   && hit.hitType !== typeFilter)            return false;
    if (eventFilter) {
      const events = hit.payload['events'];
      const eventsArr = events
        ? (Array.isArray(events) ? events : [events])
        : [];
      if (!eventsArr.some(e => e.toLowerCase().includes(eventFilter))) return false;
    }
    return true;
  });
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/**
 * Format a Unix timestamp as HH:MM:SS.mmm
 * @param {number} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = new Date(ts);
  const h  = String(d.getHours()).padStart(2, '0');
  const m  = String(d.getMinutes()).padStart(2, '0');
  const s  = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Get a display-friendly label for the hit (events or hit type).
 * @param {HitRecord} hit
 * @returns {string}
 */
function hitLabel(hit) {
  const events = hit.payload['events'];
  if (events) return Array.isArray(events) ? events.join(', ') : String(events);
  // Fall back to hit type label
  const typeLabels = {
    pageView:     'Page View',
    customLink:   'Custom Link',
    downloadLink: 'Download Link',
    exitLink:     'Exit Link',
    linkTrack:    'Link Track',
  };
  return typeLabels[hit.hitType] || 'Page View';
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Hit list rendering ───────────────────────────────────────────────────────

function renderHitList() {
  const list = document.getElementById('hit-list');
  const filtered = getFilteredHits();

  document.getElementById('hit-count').textContent = `${allHits.length} hit${allHits.length !== 1 ? 's' : ''}`;

  // Show / hide empty state
  const emptyState = document.getElementById('empty-state');
  if (filtered.length === 0) {
    list.innerHTML = '';
    list.appendChild(emptyState);
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Re-render items (preserve scroll position)
  const prevScroll = list.scrollTop;
  list.innerHTML = '';

  for (const hit of filtered) {
    const item = document.createElement('div');
    item.className = 'hit-item' + (hit.id === selectedHitId ? ' selected' : '');
    item.dataset.id = hit.id;
    item.innerHTML = `
      <div class="hit-status-bar ${hit.validation.status}"></div>
      <div class="hit-info">
        <div class="hit-events">${esc(hitLabel(hit))}</div>
        <div class="hit-time">${esc(formatTime(hit.timestamp))} · ${esc(hit.method)} · ${esc(hit.hitType || 'pageView')}${hit.isAEP ? ' · <span class="aep-badge">AEP</span>' : ''}</div>
      </div>
      <span class="hit-badge ${hit.validation.status}">${esc(hit.validation.status)}</span>
    `;
    item.addEventListener('click', () => selectHit(hit.id));
    list.appendChild(item);
  }

  list.scrollTop = prevScroll;
}

// ─── Detail pane ──────────────────────────────────────────────────────────────

/**
 * Select a hit and render its details.
 * @param {string} hitId
 */
function selectHit(hitId) {
  selectedHitId = hitId;
  renderHitList(); // update selection highlight

  const hit = allHits.find(h => h.id === hitId);
  if (!hit) return;

  renderDetailPane(hit);
}

/**
 * Render the detail pane for a given hit.
 * @param {HitRecord} hit
 */
function renderDetailPane(hit) {
  const pane = document.getElementById('detail-pane');
  const { validation, payload, url, method, timestamp } = hit;

  // Build validation rows HTML
  const errRows = validation.errors.map(e => `
    <tr>
      <td><span class="status-dot FAIL"></span>${esc(e.field)}</td>
      <td>${esc(e.rule)}</td>
      <td class="error-msg">${esc(e.message)}</td>
    </tr>
  `).join('');

  const warnRows = validation.warnings.map(w => `
    <tr>
      <td colspan="2"><span class="status-dot WARNING"></span></td>
      <td class="warn-msg">${esc(w)}</td>
    </tr>
  `).join('');

  const noIssues = !errRows && !warnRows
    ? `<tr><td colspan="3" style="color:var(--pass);padding:10px">✔ All validations passed.</td></tr>`
    : '';

  // Pretty-print payload
  const payloadJson = JSON.stringify(payload, null, 2);

  // Baseline diff section
  const diffHtml = baseline ? buildDiffHtml(hit) : '';

  pane.innerHTML = `
    <!-- Header -->
    <div class="detail-section">
      <h2>
        Hit Details
        <span class="badge ${validation.status}">${esc(validation.status)}</span>
        ${validation.matchedRuleKey ? `<span style="color:var(--muted);font-size:11px;font-weight:400">rule: ${esc(validation.matchedRuleKey)}</span>` : ''}
      </h2>
      <table class="validation-table">
        <tr><th>URL</th><td style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(url)}</td></tr>
        <tr><th>Method</th><td>${esc(method)}</td></tr>
        <tr><th>Time</th><td>${esc(formatTime(timestamp))}</td></tr>
        <tr><th>Hit Type</th><td>${esc(hit.hitType || 'pageView')}</td></tr>
        <tr><th>SDK</th><td>${hit.isAEP ? '<span class="sdk-aep">AEP Web SDK (alloy.js)</span>' : 'AppMeasurement'}</td></tr>
        ${hit.reportSuiteId ? `<tr><th>Report Suite</th><td style="font-family:var(--mono)">${esc(hit.reportSuiteId)}</td></tr>` : ''}
      </table>
    </div>

    <!-- Validation results -->
    <div class="detail-section">
      <h2>Validation Results</h2>
      <table class="validation-table">
        <thead><tr><th>Field</th><th>Rule</th><th>Message</th></tr></thead>
        <tbody>${errRows}${warnRows}${noIssues}</tbody>
      </table>
    </div>

    <!-- Payload -->
    <div class="detail-section">
      <h2>Payload</h2>
      <pre class="payload">${esc(payloadJson)}</pre>
    </div>

    <!-- Baseline actions -->
    <div class="detail-section">
      <h2>Snapshot</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="btn-save-baseline">📌 Save as Baseline</button>
        ${baseline ? `<button class="btn" id="btn-compare-baseline">🔀 Compare with Baseline</button>` : ''}
        ${baseline ? `<button class="btn danger" id="btn-clear-baseline">✕ Clear Baseline</button>` : ''}
      </div>
      ${diffHtml}
    </div>
  `;

  // Wire snapshot buttons
  document.getElementById('btn-save-baseline').addEventListener('click', () => saveBaseline(hit));
  if (baseline) {
    document.getElementById('btn-compare-baseline').addEventListener('click', () => {
      pane.querySelector('.diff-section') && pane.querySelector('.diff-section').scrollIntoView();
    });
    document.getElementById('btn-clear-baseline').addEventListener('click', () => {
      baseline = null;
      renderDetailPane(hit);
    });
  }
}

/**
 * Build diff HTML comparing the current hit against the saved baseline.
 * @param {HitRecord} hit
 * @returns {string}
 */
function buildDiffHtml(hit) {
  if (!baseline) return '';

  // Inline diff logic (mirrors utils/diff.js)
  const a = baseline.payload;
  const b = hit.payload;
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];

  for (const key of allKeys) {
    const inA = Object.prototype.hasOwnProperty.call(a, key);
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    const valA = inA ? a[key] : undefined;
    const valB = inB ? b[key] : undefined;

    const strA = Array.isArray(valA) ? valA.join(',') : String(valA ?? '');
    const strB = Array.isArray(valB) ? valB.join(',') : String(valB ?? '');

    if (!inA)       diffs.push({ type: 'added',   key, current: strB });
    else if (!inB)  diffs.push({ type: 'removed',  key, baseline: strA });
    else if (strA !== strB) diffs.push({ type: 'changed', key, baseline: strA, current: strB });
  }

  if (diffs.length === 0) {
    return `<p style="color:var(--pass);margin-top:8px;font-size:12px">✔ Identical to baseline.</p>`;
  }

  const rows = diffs.map(d => {
    if (d.type === 'added')   return `<tr class="diff-added"><td>+ ${esc(d.key)}</td><td></td><td>${esc(d.current)}</td></tr>`;
    if (d.type === 'removed') return `<tr class="diff-removed"><td>- ${esc(d.key)}</td><td>${esc(d.baseline)}</td><td></td></tr>`;
    return `<tr class="diff-changed"><td>~ ${esc(d.key)}</td><td>${esc(d.baseline)}</td><td>${esc(d.current)}</td></tr>`;
  }).join('');

  return `
    <div class="diff-section" style="margin-top:12px">
      <table class="validation-table">
        <thead><tr><th>Key</th><th>Baseline</th><th>Current</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── Baseline save ────────────────────────────────────────────────────────────

/**
 * Save a hit as the current baseline.
 * @param {HitRecord} hit
 */
function saveBaseline(hit) {
  baseline = hit;
  // Persist to storage so it survives panel re-open
  chrome.storage.local.set({ [`baseline_${inspectedTabId}`]: hit });
  // Re-render with diff section visible
  renderDetailPane(hit);
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportReport() {
  const filtered = getFilteredHits();
  const report = {
    generatedAt: new Date().toISOString(),
    tabId: inspectedTabId,
    totalHits: allHits.length,
    filteredHits: filtered.length,
    summary: {
      PASS:    filtered.filter(h => h.validation.status === 'PASS').length,
      FAIL:    filtered.filter(h => h.validation.status === 'FAIL').length,
      WARNING: filtered.filter(h => h.validation.status === 'WARNING').length,
    },
    hits: filtered.map(h => ({
      id: h.id,
      timestamp: new Date(h.timestamp).toISOString(),
      url: h.url,
      method: h.method,
      events: h.payload['events'] || null,
      status: h.validation.status,
      matchedRule: h.validation.matchedRuleKey,
      errors: h.validation.errors,
      warnings: h.validation.warnings,
      payload: h.payload,
    })),
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `analytics-qa-report-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Clear hits ───────────────────────────────────────────────────────────────

function clearHits() {
  allHits = [];
  selectedHitId = null;
  chrome.runtime.sendMessage({ type: 'CLEAR_HITS', tabId: inspectedTabId });
  renderHitList();
  document.getElementById('detail-pane').innerHTML = '<div class="placeholder"><span>← Select a hit to inspect</span></div>';
}

// ─── Wire up toolbar controls ─────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', exportReport);
document.getElementById('btn-clear').addEventListener('click', clearHits);
document.getElementById('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('filter-status').addEventListener('change', renderHitList);
document.getElementById('filter-type').addEventListener('change', renderHitList);
document.getElementById('filter-event').addEventListener('input', renderHitList);

// ─── Restore baseline from storage ───────────────────────────────────────────

chrome.storage.local.get(`baseline_${inspectedTabId}`, result => {
  baseline = result[`baseline_${inspectedTabId}`] || null;
});

// ─── Initial render ───────────────────────────────────────────────────────────

renderHitList();
