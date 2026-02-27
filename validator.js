/**
 * validator.js — Analytics QA Validation Engine
 *
 * Evaluates a parsed Adobe Analytics payload against a contract rule-set.
 *
 * Supported rules:
 *   not_empty         → field must be a non-empty string
 *   number            → field must be coercible to a finite number
 *   uuid              → field must match RFC-4122 UUID format
 *   contains:<value>  → (array) field must include the specified value
 *   enum:<a>|<b>|…   → field value must be one of the pipe-separated options
 *   regex:<pattern>   → field value must match the regular expression
 *
 * Conditional rules (conditionals array):
 *   { if_event: '<eventName>', require: ['field1', 'field2'] }
 *   → when the hit's events list contains eventName, those fields are required
 *
 * Contract format (see contracts.json for full example):
 * {
 *   "<eventKeyOrDefault>": {
 *     "required": ["field1", "field2"],
 *     "rules": {
 *       "field1": "not_empty",
 *       "field2": "uuid"
 *     },
 *     "conditionals": [
 *       { "if_event": "purchase", "require": ["purchaseID"] }
 *     ]
 *   }
 * }
 */

'use strict';

// ─── Type definitions (JSDoc) ─────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationError
 * @property {string} field
 * @property {string} rule
 * @property {string} message
 */

/**
 * @typedef {Object} ValidationResult
 * @property {'PASS'|'FAIL'|'WARNING'} status
 * @property {ValidationError[]} errors
 * @property {string[]} warnings
 * @property {string|null} matchedRuleKey  - Which contract key was matched
 */

// ─── Rule registry ────────────────────────────────────────────────────────────

/**
 * Map of rule-name prefix → evaluation function.
 * Each function receives (field, value, ruleArg?) and returns a string error
 * message if the rule fails, or null if it passes.
 *
 * @type {Record<string, (field: string, value: *, ruleArg?: string) => string|null>}
 */
const RULES = {
  not_empty(field, value) {
    const str = _asString(value);
    return str.trim() === '' ? `Field "${field}" must not be empty.` : null;
  },

  number(field, value) {
    const n = Number(_asString(value));
    return isNaN(n) || !isFinite(n)
      ? `Field "${field}" must be a valid finite number.`
      : null;
  },

  uuid(field, value) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRe.test(_asString(value))
      ? null
      : `Field "${field}" must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000).`;
  },

  contains(field, value, expected) {
    const values = _asArray(value);
    return values.includes(expected)
      ? null
      : `Field "${field}" must contain value "${expected}".`;
  },

  enum(field, value, options) {
    const allowed = (options || '').split('|').map(s => s.trim());
    const str = _asString(value);
    return allowed.includes(str)
      ? null
      : `Field "${field}" must be one of: ${allowed.join(', ')}.`;
  },

  regex(field, value, pattern) {
    try {
      return new RegExp(pattern).test(_asString(value))
        ? null
        : `Field "${field}" does not match pattern /${pattern}/.`;
    } catch {
      return null; // invalid pattern — treated as warning elsewhere
    }
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** @param {*} v @returns {string} */
function _asString(v) {
  if (Array.isArray(v)) return v.join(',');
  return v == null ? '' : String(v);
}

/** @param {*} v @returns {string[]} */
function _asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map(s => s.trim());
  return [];
}

/**
 * Parse a rule string like "contains:purchase" into { name, arg }.
 *
 * @param {string} rule
 * @returns {{ name: string, arg: string|undefined }}
 */
function _parseRule(rule) {
  const colonIdx = rule.indexOf(':');
  if (colonIdx === -1) return { name: rule, arg: undefined };
  return { name: rule.slice(0, colonIdx), arg: rule.slice(colonIdx + 1) };
}

// ─── Exported validator ───────────────────────────────────────────────────────

/**
 * Validate a parsed Adobe Analytics payload against a full contract map.
 *
 * The function:
 * 1. Identifies which events are present in the hit.
 * 2. Searches for a matching top-level key in the contract (case-insensitive).
 * 3. Falls back to a "default" rule-set if no specific match is found.
 * 4. Evaluates required fields, rules, and conditionals.
 *
 * @param {Record<string, string|string[]>} payload  - Parsed hit payload
 * @param {Record<string, RuleSet>}         contract - Loaded contract map
 * @returns {ValidationResult}
 */
function validateHit(payload, contract) {
  const errors  = /** @type {ValidationError[]} */ ([]);
  const warnings = /** @type {string[]} */ ([]);

  if (!contract || Object.keys(contract).length === 0) {
    return { status: 'WARNING', errors, warnings: ['No contract loaded.'], matchedRuleKey: null };
  }

  // ── Identify events present in the hit ────────────────────────────────────
  const rawEvents = payload['events'];
  const presentEvents = rawEvents
    ? _asArray(rawEvents).map(e => e.toLowerCase())
    : [];

  // ── Find matching rule-set ────────────────────────────────────────────────
  let matchedRuleKey = null;
  const contractKeys = Object.keys(contract);

  for (const key of contractKeys) {
    if (key === 'default') continue; // handle as fallback
    if (presentEvents.includes(key.toLowerCase())) {
      matchedRuleKey = key;
      break;
    }
  }

  const ruleSet = matchedRuleKey
    ? contract[matchedRuleKey]
    : (contract['default'] || null);

  if (!ruleSet) {
    return {
      status: 'WARNING',
      errors,
      warnings: ['No matching contract rule for this hit.'],
      matchedRuleKey: null,
    };
  }

  // ── Required fields ───────────────────────────────────────────────────────
  for (const field of (ruleSet.required || [])) {
    const val = payload[field];
    const isEmpty = val === undefined || val === null || _asString(val).trim() === '';
    if (isEmpty) {
      errors.push({
        field,
        rule: 'required',
        message: `Required field "${field}" is missing or empty.`,
      });
    }
  }

  // ── Rule evaluation ───────────────────────────────────────────────────────
  for (const [field, ruleStr] of Object.entries(ruleSet.rules || {})) {
    const val = payload[field];
    if (val === undefined || val === null) continue; // absence handled by 'required'

    const { name, arg } = _parseRule(String(ruleStr));
    const evaluator = RULES[name];

    if (!evaluator) {
      warnings.push(`Unknown rule "${name}" for field "${field}".`);
      continue;
    }

    // Validate regex pattern itself before running
    if (name === 'regex' && arg) {
      try { new RegExp(arg); } catch {
        warnings.push(`Invalid regex pattern for field "${field}": ${arg}`);
        continue;
      }
    }

    const errMsg = evaluator(field, val, arg);
    if (errMsg) {
      errors.push({ field, rule: name, message: errMsg });
    }
  }

  // ── Conditional rules ─────────────────────────────────────────────────────
  for (const cond of (ruleSet.conditionals || [])) {
    const { if_event, require: requires } = cond;
    if (!if_event || !Array.isArray(requires)) continue;

    if (presentEvents.includes(if_event.toLowerCase())) {
      for (const rf of requires) {
        const val = payload[rf];
        if (val === undefined || val === null || _asString(val).trim() === '') {
          errors.push({
            field: rf,
            rule: 'conditional_required',
            message: `Field "${rf}" is required when event "${if_event}" is present.`,
          });
        }
      }
    }
  }

  const status = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARNING' : 'PASS';
  return { status, errors, warnings, matchedRuleKey: matchedRuleKey || 'default' };
}

/**
 * Re-validate an array of existing HitRecords against a new contract.
 * Used when the user updates the active contract in Options.
 *
 * @param {HitRecord[]} hits
 * @param {Record<string, RuleSet>} contract
 * @returns {HitRecord[]}
 */
function revalidateHits(hits, contract) {
  return hits.map(hit => ({
    ...hit,
    validation: validateHit(hit.payload, contract),
  }));
}

// Export for ES module (panel) and CommonJS (tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateHit, revalidateHits };
}
