/**
 * utils/classifier.js — Adobe Analytics request classifier
 *
 * Determines whether a given URL corresponds to an Adobe Analytics hit so the
 * extension knows which network requests to intercept and inspect.
 *
 * Two collection technologies are supported, each with their canonical Adobe
 * hostname AND with CNAME / first-party collection domains:
 *
 *  AppMeasurement (AppMeasurement.js / s_code.js)
 *    Canonical:  *.omtrdc.net/b/ss/<rsid>/<version>/…
 *    CNAME:      <custom-subdomain>.<client-domain>/b/ss/<rsid>/<version>/…
 *    Detection:  path pattern /\/b\/ss\/[^/]+\// (highly specific to Adobe)
 *
 *  AEP Web SDK (alloy.js)
 *    Canonical:  *.adobedc.net/ee/v<n>/(interact|collect)
 *    CNAME:      <custom-subdomain>.<client-domain>/ee/v<n>/(interact|collect)
 *    Detection:  hostname ends with .adobedc.net OR
 *                path matches /\/ee\/v\d+\/(interact|collect)/
 */

'use strict';

// ─── Path patterns ────────────────────────────────────────────────────────────

/**
 * Identifies an AppMeasurement collection path.
 * Matches /b/ss/<one-or-more-non-slash-chars>/ which is unique to Adobe
 * collection servers (both direct *.omtrdc.net and CNAME aliases).
 *
 * Note: no hostname restriction is applied here so that first-party CNAME
 * collection domains (arbitrary per customer) are also captured.  This is
 * intentional for a developer DevTools extension — the parsed data is only
 * ever displayed to the developer inspecting their own page.
 */
const AA_PATH_PATTERN = /\/b\/ss\/[^/]+\//;

/**
 * Identifies an AEP Web SDK Edge Network path for CNAME collection domains.
 * Matches /ee/v<n>/(interact|collect) which is specific to AEP alloy.js calls.
 *
 * Note: same CNAME rationale as AA_PATH_PATTERN above — no hostname restriction
 * so first-party CNAME Edge Network domains are captured automatically.
 */
const AEP_CNAME_PATH_PATTERN = /\/ee\/v\d+\/(interact|collect)/;

// ─── Classifiers ──────────────────────────────────────────────────────────────

/**
 * Return true when the URL is an AppMeasurement collection hit.
 *
 * Supports both:
 *  - Standard Adobe collection servers (*.omtrdc.net)
 *  - First-party CNAME collection servers (any hostname with /b/ss/<rsid>/ path)
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAppMeasurementRequest(url) {
  try {
    const { pathname } = new URL(url);
    return AA_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Return true when the URL is an AEP Web SDK (alloy.js) Edge Network request.
 *
 * Supports both:
 *  - Standard Adobe Edge Network servers (*.adobedc.net)
 *  - First-party CNAME Edge Network servers (any hostname with /ee/v<n>/(interact|collect) path)
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAEPRequest(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.endsWith('.adobedc.net') || AEP_CNAME_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Return true when the URL is any Adobe Analytics request the extension should capture.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAnalyticsRequest(url) {
  return isAppMeasurementRequest(url) || isAEPRequest(url);
}

// Export for CommonJS (tests) — no-op in service-worker context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isAppMeasurementRequest, isAEPRequest, isAnalyticsRequest };
}
