/**
 * tests/diff.test.js — Unit tests for utils/diff.js
 */

'use strict';

const { diffPayloads, formatDiff } = require('../utils/diff');

describe('diffPayloads', () => {
  test('returns empty array for identical payloads', () => {
    const a = { eVar1: 'user123', events: ['purchase'] };
    expect(diffPayloads(a, { ...a })).toHaveLength(0);
  });

  test('detects added keys', () => {
    const baseline = { eVar1: 'user123' };
    const current  = { eVar1: 'user123', newProp: 'hello' };
    const diffs = diffPayloads(baseline, current);
    const added = diffs.find(d => d.type === 'added' && d.key === 'newProp');
    expect(added).toBeDefined();
    expect(added.current).toBe('hello');
  });

  test('detects removed keys', () => {
    const baseline = { eVar1: 'user123', eVar2: 'gone' };
    const current  = { eVar1: 'user123' };
    const diffs = diffPayloads(baseline, current);
    const removed = diffs.find(d => d.type === 'removed' && d.key === 'eVar2');
    expect(removed).toBeDefined();
    expect(removed.baseline).toBe('gone');
  });

  test('detects changed string values', () => {
    const baseline = { eVar1: 'user123' };
    const current  = { eVar1: 'user456' };
    const diffs = diffPayloads(baseline, current);
    const changed = diffs.find(d => d.type === 'changed' && d.key === 'eVar1');
    expect(changed).toBeDefined();
    expect(changed.baseline).toBe('user123');
    expect(changed.current).toBe('user456');
  });

  test('detects changed array values', () => {
    const baseline = { events: ['event1', 'event2'] };
    const current  = { events: ['event1', 'event3'] };
    const diffs = diffPayloads(baseline, current);
    const changed = diffs.find(d => d.type === 'changed' && d.key === 'events');
    expect(changed).toBeDefined();
  });

  test('does not flag arrays with same contents as changed', () => {
    const a = { events: ['event1', 'event2'] };
    expect(diffPayloads(a, { events: ['event1', 'event2'] })).toHaveLength(0);
  });

  test('sorts: changed before removed before added', () => {
    const baseline = { a: '1', b: '2' };
    const current  = { a: '9', c: 'new' };
    const diffs = diffPayloads(baseline, current);
    const types = diffs.map(d => d.type);
    const changedIdx = types.indexOf('changed');
    const removedIdx = types.indexOf('removed');
    const addedIdx   = types.indexOf('added');
    expect(changedIdx).toBeLessThan(removedIdx);
    expect(removedIdx).toBeLessThan(addedIdx);
  });
});

describe('formatDiff', () => {
  test('returns "No differences found." for empty diff', () => {
    expect(formatDiff([])).toBe('No differences found.');
  });

  test('includes CHANGED label for changed entries', () => {
    const diffs = [{ type: 'changed', key: 'eVar1', baseline: 'a', current: 'b' }];
    expect(formatDiff(diffs)).toContain('CHANGED');
    expect(formatDiff(diffs)).toContain('eVar1');
  });

  test('includes ADDED label for added entries', () => {
    const diffs = [{ type: 'added', key: 'newKey', current: 'val' }];
    expect(formatDiff(diffs)).toContain('ADDED');
  });

  test('includes REMOVED label for removed entries', () => {
    const diffs = [{ type: 'removed', key: 'oldKey', baseline: 'old' }];
    expect(formatDiff(diffs)).toContain('REMOVED');
  });
});
