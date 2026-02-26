/**
 * devtools.js — DevTools page script
 *
 * Runs in the context of the Chrome DevTools page (devtools.html).
 * Registers a custom panel in the DevTools UI.
 *
 * This file must remain minimal: it only registers the panel and lets
 * panel.html/panel.js handle all logic.
 */

'use strict';

chrome.devtools.panels.create(
  'Analytics QA',          // Panel title (tab label)
  'icons/icon48.png',      // Panel icon (shown in DevTools tab bar)
  'panel.html',            // Panel HTML page
  panel => {
    // panel is a DevToolsPanel object; we don't need to do anything here
    // since panel.js handles all initialisation on its own.
  }
);
