/**
 * tests/parser.test.js — Unit tests for utils/parser.js
 */

'use strict';

const { parsePayload, serializePayload } = require('../utils/parser');

describe('parsePayload', () => {
  test('parses simple key=value pairs', () => {
    const result = parsePayload('eVar1=user123&pageName=Home');
    expect(result).toEqual({ eVar1: 'user123', pageName: 'Home' });
  });

  test('splits comma-separated events into an array', () => {
    const result = parsePayload('events=event1,event2,event3');
    expect(result.events).toEqual(['event1', 'event2', 'event3']);
  });

  test('splits comma-separated products into an array', () => {
    const result = parsePayload('products=;Widget;1;9.99');
    expect(result.products).toBe(';Widget;1;9.99'); // no comma → stays string
  });

  test('splits comma-separated products when multiple entries', () => {
    const result = parsePayload('products=;Widget;1;9.99,;Gadget;2;19.98');
    expect(Array.isArray(result.products)).toBe(true);
    expect(result.products).toHaveLength(2);
  });

  test('returns empty object for empty string', () => {
    expect(parsePayload('')).toEqual({});
  });

  test('returns empty object for null/undefined', () => {
    expect(parsePayload(null)).toEqual({});
    expect(parsePayload(undefined)).toEqual({});
  });

  test('handles URL-encoded values', () => {
    const result = parsePayload('pageName=Home%20Page&eVar1=hello%2Bworld');
    expect(result.pageName).toBe('Home Page');
    expect(result.eVar1).toBe('hello+world');
  });

  test('strips a leading ? from the query string', () => {
    const result = parsePayload('?eVar1=abc&pageName=X');
    expect(result.eVar1).toBe('abc');
  });

  test('merges duplicate keys into an array', () => {
    const result = parsePayload('v=a&v=b&v=c');
    expect(Array.isArray(result.v)).toBe(true);
    expect(result.v).toContain('a');
    expect(result.v).toContain('b');
  });
});

describe('serializePayload', () => {
  test('round-trips a simple payload', () => {
    const payload = { eVar1: 'user123', pageName: 'Home' };
    const serialized = serializePayload(payload);
    const reparsed = parsePayload(serialized);
    expect(reparsed.eVar1).toBe('user123');
    expect(reparsed.pageName).toBe('Home');
  });

  test('joins array values with commas', () => {
    const payload = { events: ['event1', 'event2'] };
    const serialized = serializePayload(payload);
    expect(serialized).toContain('events=event1%2Cevent2');
  });
});
