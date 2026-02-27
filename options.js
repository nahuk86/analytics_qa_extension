/**
 * options.js — Options page logic
 *
 * Manages:
 *  - Contract CRUD (create, edit, delete) via chrome.storage.local
 *  - Active contract selection
 *  - Environment → contract mappings (hostname pattern to contract name)
 */

'use strict';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const STORAGE_KEY_CONTRACTS = 'contracts';
const STORAGE_KEY_ACTIVE    = 'activeContractKey';
const STORAGE_KEY_ENVS      = 'envMappings';

// ─── Default contract template ────────────────────────────────────────────────

const DEFAULT_CONTRACT_TEMPLATE = {
  purchase: {
    required: ['events', 'purchaseID', 'eVar1', 'products'],
    rules: {
      purchaseID: 'uuid',
      eVar1: 'not_empty',
      events: 'contains:purchase',
      products: 'not_empty',
    },
    conditionals: [
      { if_event: 'purchase', require: ['purchaseID', 'products'] },
    ],
  },
  default: {
    required: ['pageName', 'server'],
    rules: {
      pageName: 'not_empty',
      server: 'not_empty',
    },
    conditionals: [],
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Record<string, object>} */
let contracts = {};

/** @type {string} */
let activeContractKey = 'default';

/** @type {Array<{hostname: string, contractKey: string}>} */
let envMappings = [];

// ─── DOM references ───────────────────────────────────────────────────────────

const contractKeyInput   = document.getElementById('contract-key');
const contractJsonArea   = document.getElementById('contract-json');
const selectContractEl   = document.getElementById('select-contract');
const envBody            = document.getElementById('env-body');
const statusMsg          = document.getElementById('status-msg');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Display a status message for 3 seconds.
 * @param {string} msg
 * @param {'ok'|'err'|'warn'} type
 */
function showStatus(msg, type = 'ok') {
  statusMsg.textContent = msg;
  statusMsg.className = type;
  setTimeout(() => { statusMsg.textContent = ''; statusMsg.className = ''; }, 3000);
}

/**
 * Load all data from chrome.storage.local and populate the UI.
 */
function loadAll() {
  chrome.storage.local.get([STORAGE_KEY_CONTRACTS, STORAGE_KEY_ACTIVE, STORAGE_KEY_ENVS], result => {
    contracts        = result[STORAGE_KEY_CONTRACTS] || { default: DEFAULT_CONTRACT_TEMPLATE };
    activeContractKey = result[STORAGE_KEY_ACTIVE]   || 'default';
    envMappings      = result[STORAGE_KEY_ENVS]      || [];

    // Ensure there is at least a 'default' contract
    if (!contracts['default']) contracts['default'] = DEFAULT_CONTRACT_TEMPLATE;

    populateContractSelector();
    populateEnvTable();
  });
}

/**
 * Populate the contract <select> element and set the active selection.
 */
function populateContractSelector() {
  selectContractEl.innerHTML = '';
  for (const key of Object.keys(contracts)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    if (key === activeContractKey) opt.selected = true;
    selectContractEl.appendChild(opt);
  }
}

/**
 * Populate the environment mappings table.
 */
function populateEnvTable() {
  envBody.innerHTML = '';
  for (const mapping of envMappings) {
    addEnvRow(mapping.hostname, mapping.contractKey);
  }
}

/**
 * Add a new row to the environment mappings table.
 * @param {string} [hostname]
 * @param {string} [contractKey]
 */
function addEnvRow(hostname = '', contractKey = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="env-hostname" value="${_esc(hostname)}" placeholder="e.g. *.example.com"></td>
    <td><input type="text" class="env-contract"  value="${_esc(contractKey)}" placeholder="contract name"></td>
    <td><button class="btn danger" style="padding:4px 10px;font-size:12px">✕</button></td>
  `;
  tr.querySelector('button').addEventListener('click', () => tr.remove());
  envBody.appendChild(tr);
}

/** @param {string} str @returns {string} */
function _esc(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Save contract ────────────────────────────────────────────────────────────

document.getElementById('btn-save-contract').addEventListener('click', () => {
  const key = contractKeyInput.value.trim();
  if (!key) {
    showStatus('Contract name cannot be empty.', 'err');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(contractJsonArea.value);
  } catch (e) {
    showStatus(`Invalid JSON: ${e.message}`, 'err');
    return;
  }

  contracts[key] = parsed;
  chrome.storage.local.set({ [STORAGE_KEY_CONTRACTS]: contracts }, () => {
    if (chrome.runtime.lastError) {
      showStatus(`Error saving: ${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    populateContractSelector();
    showStatus(`Contract "${key}" saved.`, 'ok');
  });
});

// ─── Load default template ────────────────────────────────────────────────────

document.getElementById('btn-load-default').addEventListener('click', () => {
  if (!contractKeyInput.value.trim()) contractKeyInput.value = 'default';
  contractJsonArea.value = JSON.stringify(DEFAULT_CONTRACT_TEMPLATE, null, 2);
});

// ─── Delete contract ──────────────────────────────────────────────────────────

document.getElementById('btn-delete-contract').addEventListener('click', () => {
  const key = contractKeyInput.value.trim();
  if (!key || key === 'default') {
    showStatus('Cannot delete the "default" contract.', 'warn');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(contracts, key)) {
    showStatus(`Contract "${key}" not found.`, 'err');
    return;
  }
  delete contracts[key];
  chrome.storage.local.set({ [STORAGE_KEY_CONTRACTS]: contracts }, () => {
    populateContractSelector();
    showStatus(`Contract "${key}" deleted.`, 'ok');
  });
});

// ─── Set active contract ──────────────────────────────────────────────────────

document.getElementById('btn-set-active').addEventListener('click', () => {
  const key = selectContractEl.value;
  activeContractKey = key;
  chrome.storage.local.set({ [STORAGE_KEY_ACTIVE]: key }, () => {
    if (chrome.runtime.lastError) {
      showStatus(`Error: ${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    showStatus(`Active contract set to "${key}".`, 'ok');
  });
});

// ─── Environment mappings ─────────────────────────────────────────────────────

document.getElementById('btn-add-env').addEventListener('click', () => addEnvRow());

document.getElementById('btn-save-envs').addEventListener('click', () => {
  const rows = envBody.querySelectorAll('tr');
  const mappings = [];
  for (const row of rows) {
    const hostname    = row.querySelector('.env-hostname').value.trim();
    const contractKey = row.querySelector('.env-contract').value.trim();
    if (hostname && contractKey) {
      mappings.push({ hostname, contractKey });
    }
  }
  envMappings = mappings;
  chrome.storage.local.set({ [STORAGE_KEY_ENVS]: mappings }, () => {
    if (chrome.runtime.lastError) {
      showStatus(`Error: ${chrome.runtime.lastError.message}`, 'err');
      return;
    }
    showStatus('Environment mappings saved.', 'ok');
  });
});

// ─── Contract list click to edit ─────────────────────────────────────────────

selectContractEl.addEventListener('change', () => {
  const key = selectContractEl.value;
  contractKeyInput.value = key;
  if (contracts[key]) {
    contractJsonArea.value = JSON.stringify(contracts[key], null, 2);
  }
});

// ─── Initialise ───────────────────────────────────────────────────────────────

loadAll();
