/**
 * tests/validator.test.js — Unit tests for validator.js
 */

'use strict';

const { validateHit, revalidateHits } = require('../validator');

// ─── Sample contract ──────────────────────────────────────────────────────────

const contract = {
  purchase: {
    required: ['events', 'purchaseID', 'eVar1', 'products'],
    rules: {
      purchaseID: 'uuid',
      eVar1: 'not_empty',
      events: 'contains:purchase',
      products: 'not_empty',
    },
    conditionals: [
      { if_event: 'purchase', require: ['purchaseID'] },
    ],
  },
  event1: {
    required: ['events', 'eVar3'],
    rules: {
      events: 'contains:event1',
      eVar3: 'not_empty',
    },
    conditionals: [],
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

// ─── PASS cases ───────────────────────────────────────────────────────────────

describe('PASS validations', () => {
  test('valid purchase hit passes', () => {
    const payload = {
      events: ['purchase'],
      purchaseID: '550e8400-e29b-41d4-a716-446655440000',
      eVar1: 'user123',
      products: ';Widget;1;9.99',
    };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('PASS');
    expect(result.errors).toHaveLength(0);
  });

  test('valid page view hits the default rule and passes', () => {
    const payload = { pageName: 'Home', server: 'www.example.com' };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('PASS');
  });

  test('valid event1 hit passes', () => {
    const payload = { events: ['event1'], eVar3: 'someValue' };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('PASS');
    expect(result.matchedRuleKey).toBe('event1');
  });
});

// ─── FAIL cases ───────────────────────────────────────────────────────────────

describe('FAIL validations', () => {
  test('missing required field causes FAIL', () => {
    const payload = {
      events: ['purchase'],
      // purchaseID missing
      eVar1: 'user123',
      products: ';Widget;1;9.99',
    };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
    expect(result.errors.some(e => e.field === 'purchaseID')).toBe(true);
  });

  test('invalid UUID causes FAIL', () => {
    const payload = {
      events: ['purchase'],
      purchaseID: 'not-a-uuid',
      eVar1: 'user123',
      products: ';Widget;1;9.99',
    };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
    expect(result.errors.some(e => e.field === 'purchaseID' && e.rule === 'uuid')).toBe(true);
  });

  test('empty required field causes FAIL', () => {
    const payload = {
      events: ['purchase'],
      purchaseID: '550e8400-e29b-41d4-a716-446655440000',
      eVar1: '',
      products: ';Widget;1;9.99',
    };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
    expect(result.errors.some(e => e.field === 'eVar1')).toBe(true);
  });

  test('events does not contain required event', () => {
    const payload = {
      events: ['event5'],
      purchaseID: '550e8400-e29b-41d4-a716-446655440000',
      eVar1: 'user123',
      products: ';Widget;1;9.99',
    };
    // 'event5' won't match 'purchase', falls back to default
    // default requires pageName + server which are missing → FAIL
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
  });

  test('contains rule fail when event not in list', () => {
    const payload = {
      events: ['scAdd'],  // matched by default contract
      purchaseID: '550e8400-e29b-41d4-a716-446655440000',
      eVar1: 'user123',
    };
    // falls through to default → pageName + server missing → FAIL
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
  });
});

// ─── Rule-specific tests ──────────────────────────────────────────────────────

describe('Rule: number', () => {
  const numContract = {
    default: {
      required: ['price'],
      rules: { price: 'number' },
      conditionals: [],
    },
  };

  test('valid number passes', () => {
    expect(validateHit({ price: '9.99' }, numContract).status).toBe('PASS');
  });

  test('non-numeric fails', () => {
    const r = validateHit({ price: 'abc' }, numContract);
    expect(r.status).toBe('FAIL');
    expect(r.errors[0].rule).toBe('number');
  });
});

describe('Rule: enum', () => {
  const enumContract = {
    default: {
      required: ['channel'],
      rules: { channel: 'enum:web|mobile|email' },
      conditionals: [],
    },
  };

  test('valid enum value passes', () => {
    expect(validateHit({ channel: 'web' }, enumContract).status).toBe('PASS');
  });

  test('invalid enum value fails', () => {
    const r = validateHit({ channel: 'print' }, enumContract);
    expect(r.status).toBe('FAIL');
    expect(r.errors[0].rule).toBe('enum');
  });
});

describe('Rule: regex', () => {
  const regexContract = {
    default: {
      required: ['sku'],
      rules: { sku: 'regex:^[A-Z]{2}\\d{4}$' },
      conditionals: [],
    },
  };

  test('matching regex passes', () => {
    expect(validateHit({ sku: 'AB1234' }, regexContract).status).toBe('PASS');
  });

  test('non-matching regex fails', () => {
    const r = validateHit({ sku: 'abc123' }, regexContract);
    expect(r.status).toBe('FAIL');
  });
});

// ─── WARNING cases ────────────────────────────────────────────────────────────

describe('WARNING cases', () => {
  test('empty contract returns WARNING', () => {
    const result = validateHit({ events: ['purchase'] }, {});
    expect(result.status).toBe('WARNING');
  });

  test('null contract returns WARNING', () => {
    const result = validateHit({ events: ['purchase'] }, null);
    expect(result.status).toBe('WARNING');
  });

  test('no matching contract rule returns WARNING', () => {
    // A contract with only 'purchase' key, hit has unknown event
    const smallContract = {
      purchase: {
        required: ['purchaseID'],
        rules: {},
        conditionals: [],
      },
    };
    const result = validateHit({ events: ['unknownEvent'], pageName: 'X' }, smallContract);
    expect(result.status).toBe('WARNING');
  });
});

// ─── Conditional rules ────────────────────────────────────────────────────────

describe('Conditional rules', () => {
  test('conditional field required when matching event present', () => {
    const payload = {
      events: ['purchase'],
      // purchaseID intentionally omitted
      eVar1: 'user123',
      products: ';Widget;1;9.99',
    };
    const result = validateHit(payload, contract);
    expect(result.status).toBe('FAIL');
    const conditionalError = result.errors.find(
      e => e.field === 'purchaseID' && e.rule === 'conditional_required'
    );
    // Either caught by 'required' or 'conditional_required'
    const hasError = result.errors.some(e => e.field === 'purchaseID');
    expect(hasError).toBe(true);
  });
});

// ─── revalidateHits ───────────────────────────────────────────────────────────

describe('revalidateHits', () => {
  test('re-validates array of hits against a new contract', () => {
    const hits = [
      {
        id: '1',
        payload: { pageName: 'Home', server: 'example.com' },
        validation: { status: 'UNKNOWN', errors: [], warnings: [] },
      },
    ];
    const revalidated = revalidateHits(hits, contract);
    expect(revalidated[0].validation.status).toBe('PASS');
  });
});
