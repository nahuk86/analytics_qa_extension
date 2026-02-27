/**
 * tests/classifier.test.js — Unit tests for utils/classifier.js
 *
 * Verifies that URL classification correctly handles:
 *  - Standard Adobe collection domains (*.omtrdc.net, *.adobedc.net)
 *  - First-party CNAME collection domains (any host with the Adobe path patterns)
 *  - Non-analytics URLs (should never match)
 */

'use strict';

const { isAppMeasurementRequest, isAEPRequest, isAnalyticsRequest } = require('../utils/classifier');

// ─── isAppMeasurementRequest ──────────────────────────────────────────────────

describe('isAppMeasurementRequest', () => {
  // Standard Adobe domain
  test('matches standard omtrdc.net collection URL', () => {
    expect(isAppMeasurementRequest(
      'https://pfizer.d2.sc.omtrdc.net/b/ss/pfizerarg/1/JS-2.22.0/s1234'
    )).toBe(true);
  });

  test('matches http omtrdc.net collection URL', () => {
    expect(isAppMeasurementRequest(
      'http://pfizer.d2.sc.omtrdc.net/b/ss/myrsid/1/'
    )).toBe(true);
  });

  // CNAME / first-party collection domains
  test('matches CNAME first-party collection URL for pfizerconmigo.com.ar', () => {
    expect(isAppMeasurementRequest(
      'https://metrics.pfizerconmigo.com.ar/b/ss/pfizerarg/1/JS-2.22.0/s1234'
    )).toBe(true);
  });

  test('matches any CNAME domain with /b/ss/<rsid>/ path', () => {
    expect(isAppMeasurementRequest(
      'https://data.example.com/b/ss/myreportsuites,otherrsid/1/'
    )).toBe(true);
  });

  // Non-analytics URLs
  test('does not match a URL without /b/ss/ path', () => {
    expect(isAppMeasurementRequest('https://www.pfizerconmigo.com.ar/home')).toBe(false);
  });

  test('does not match an AEP edge URL', () => {
    expect(isAppMeasurementRequest(
      'https://edge.adobedc.net/ee/v1/interact'
    )).toBe(false);
  });

  test('returns false for invalid URL', () => {
    expect(isAppMeasurementRequest('not-a-url')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isAppMeasurementRequest('')).toBe(false);
  });
});

// ─── isAEPRequest ─────────────────────────────────────────────────────────────

describe('isAEPRequest', () => {
  // Standard Adobe domain
  test('matches standard adobedc.net edge URL', () => {
    expect(isAEPRequest('https://edge.adobedc.net/ee/v1/interact')).toBe(true);
  });

  test('matches adobedc.net collect endpoint', () => {
    expect(isAEPRequest('https://edge.adobedc.net/ee/v1/collect')).toBe(true);
  });

  test('matches subdomain of adobedc.net with /ee/ path', () => {
    expect(isAEPRequest('https://pfizer.data.adobedc.net/ee/v1/interact')).toBe(true);
  });

  // CNAME / first-party collection domains
  test('matches CNAME AEP domain for pfizerconmigo.com.ar via path pattern', () => {
    expect(isAEPRequest(
      'https://edge.pfizerconmigo.com.ar/ee/v1/interact'
    )).toBe(true);
  });

  test('matches any CNAME domain with /ee/v<n>/interact path', () => {
    expect(isAEPRequest('https://data.example.com/ee/v2/interact')).toBe(true);
  });

  test('matches any CNAME domain with /ee/v<n>/collect path', () => {
    expect(isAEPRequest('https://data.example.com/ee/v1/collect')).toBe(true);
  });

  // Non-analytics URLs
  test('does not match a URL without AEP path on unknown host', () => {
    expect(isAEPRequest('https://www.pfizerconmigo.com.ar/home')).toBe(false);
  });

  test('does not match a /ee/ path without version segment on unknown host', () => {
    // /ee/ without /v<n>/(interact|collect) should not match on non-Adobe host
    expect(isAEPRequest('https://example.com/ee/something')).toBe(false);
  });

  test('returns false for invalid URL', () => {
    expect(isAEPRequest('not-a-url')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isAEPRequest('')).toBe(false);
  });
});

// ─── isAnalyticsRequest ───────────────────────────────────────────────────────

describe('isAnalyticsRequest', () => {
  test('returns true for AppMeasurement URL', () => {
    expect(isAnalyticsRequest(
      'https://metrics.pfizerconmigo.com.ar/b/ss/pfizerarg/1/'
    )).toBe(true);
  });

  test('returns true for AEP URL', () => {
    expect(isAnalyticsRequest('https://edge.adobedc.net/ee/v1/interact')).toBe(true);
  });

  test('returns false for non-analytics URL', () => {
    expect(isAnalyticsRequest('https://www.pfizerconmigo.com.ar/')).toBe(false);
  });
});
