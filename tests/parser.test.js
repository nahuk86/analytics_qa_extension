/**
 * tests/parser.test.js — Unit tests for utils/parser.js
 */

'use strict';

const { parsePayload, parseAEPPayload, flattenContextData, serializePayload } = require('../utils/parser');

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

  test('does not split non-multi-value comma fields', () => {
    // prop1 has a comma in the value but is NOT in MULTI_VALUE_FIELDS → stays as string
    const result = parsePayload('prop1=New%20York%2C%20USA');
    expect(result.prop1).toBe('New York, USA');
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

// ─── parseAEPPayload ──────────────────────────────────────────────────────────

describe('parseAEPPayload', () => {
  const aepBody = JSON.stringify({
    events: [
      {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: {
            webPageDetails: {
              name: 'Home',
              URL: 'https://pfizerconmigo.com.ar/',
            },
          },
        },
        data: {
          __adobe: {
            analytics: {
              pageName: 'pfizerconmigo:home',
              channel: 'patient-support',
              eVar1: 'user123',
              events: 'event1,event2',
            },
          },
        },
      },
    ],
  });

  test('returns an array with one item per AEP event', () => {
    const result = parseAEPPayload(aepBody);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  test('extracts Adobe Analytics variables from data.__adobe.analytics', () => {
    const [payload] = parseAEPPayload(aepBody);
    expect(payload.pageName).toBe('pfizerconmigo:home');
    expect(payload.channel).toBe('patient-support');
    expect(payload.eVar1).toBe('user123');
  });

  test('splits comma-separated events string into an array', () => {
    const [payload] = parseAEPPayload(aepBody);
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events).toContain('event1');
    expect(payload.events).toContain('event2');
  });

  test('extracts _eventType from xdm.eventType', () => {
    const [payload] = parseAEPPayload(aepBody);
    expect(payload._eventType).toBe('web.webpagedetails.pageViews');
  });

  test('extracts pageName from xdm.web.webPageDetails.name when not in analytics data', () => {
    const body = JSON.stringify({
      events: [{ xdm: { eventType: 'web.webpagedetails.pageViews', web: { webPageDetails: { name: 'XDM Page' } } }, data: {} }],
    });
    const [payload] = parseAEPPayload(body);
    expect(payload.pageName).toBe('XDM Page');
  });

  test('analytics data overrides xdm pageName when both present', () => {
    // AA data is merged after XDM so it wins
    const [payload] = parseAEPPayload(aepBody);
    expect(payload.pageName).toBe('pfizerconmigo:home'); // from analytics data, not 'Home'
  });

  test('handles a batch of multiple events', () => {
    const body = JSON.stringify({
      events: [
        { xdm: { eventType: 'web.webpagedetails.pageViews' }, data: { __adobe: { analytics: { pageName: 'page1' } } } },
        { xdm: { eventType: 'web.webInteraction.linkClicks' }, data: { __adobe: { analytics: { pageName: 'page2' } } } },
      ],
    });
    const result = parseAEPPayload(body);
    expect(result).toHaveLength(2);
    expect(result[0].pageName).toBe('page1');
    expect(result[1].pageName).toBe('page2');
  });

  test('extracts link info from xdm.web.webInteraction', () => {
    const body = JSON.stringify({
      events: [{
        xdm: {
          eventType: 'web.webInteraction.linkClicks',
          web: { webInteraction: { name: 'CTA Button', type: 'other' } },
        },
        data: {},
      }],
    });
    const [payload] = parseAEPPayload(body);
    expect(payload._linkName).toBe('CTA Button');
    expect(payload._linkType).toBe('other');
  });

  test('returns [] for invalid JSON', () => {
    const result = parseAEPPayload('not json at all');
    expect(result).toEqual([]);
  });

  test('returns [] for empty / null input', () => {
    expect(parseAEPPayload('')).toEqual([]);
    expect(parseAEPPayload(null)).toEqual([]);
  });
});

// ─── flattenContextData ───────────────────────────────────────────────────────

describe('flattenContextData', () => {
  test('strips the c. prefix from context-data keys', () => {
    const payload = { 'c.pageType': 'article', 'c.section': 'health', pageName: 'Home' };
    const result = flattenContextData(payload);
    expect(result.pageType).toBe('article');
    expect(result.section).toBe('health');
    expect(result.pageName).toBe('Home');
  });

  test('removes the c. sentinel open marker', () => {
    const payload = { 'c.': '', 'c.key': 'value', '.c': '' };
    const result = flattenContextData(payload);
    expect(result).not.toHaveProperty('c.');
    expect(result).not.toHaveProperty('.c');
    expect(result.key).toBe('value');
  });

  test('does not modify keys without the c. prefix', () => {
    const payload = { eVar1: 'user123', pageName: 'Home' };
    expect(flattenContextData(payload)).toEqual(payload);
  });

  test('handles empty payload', () => {
    expect(flattenContextData({})).toEqual({});
  });

  test('does not strip c. from middle of key name', () => {
    // Only leading "c." should be stripped
    const payload = { 'notc.key': 'value' };
    const result = flattenContextData(payload);
    expect(result['notc.key']).toBe('value');
  });
});

