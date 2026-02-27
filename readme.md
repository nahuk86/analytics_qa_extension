# Analytics QA Extension

A **Chrome / Edge (Manifest V3)** extension that automatically intercepts, parses, and validates Adobe Analytics hits against a configurable contract — surfaced in a custom DevTools panel.

---

## Architecture

```
/manifest.json       Chrome Extension manifest (MV3)
/background.js       Service worker — intercepts requests, validates hits, broadcasts to panel
/devtools.html       DevTools page — registers the custom panel
/devtools.js         Panel registration script
/panel.html          DevTools panel UI
/panel.js            Panel logic — renders hits, filtering, export, snapshot diff
/options.html        Options UI — contract editor + environment mappings
/options.js          Options logic — CRUD for contracts + env maps
/validator.js        Validation engine — PASS / FAIL / WARNING
/contracts.json      Default bundled contract (purchase, prodView, scAdd, default)
/utils/parser.js     Querystring / POST body → structured JS object
/utils/diff.js       Structural diff for baseline / snapshot comparison
/icons/              Extension icons (16x16, 48x48, 128x128)
/tests/              Jest unit tests
```

### Data flow

```
Page request → chrome.webRequest.onBeforeRequest
                 ↓
           background.js
           · parsePayload()
           · loadActiveContract()
           · validateHit()
                 ↓ (Port message)
           panel.js
           · renderHitList()
           · renderDetailPane()
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Interception** | Captures all `*.omtrdc.net/b/ss/` GET and POST requests |
| **Parsing** | Converts querystring / POST body to a JS object; splits `events`, `products`, `list*` arrays |
| **Validation** | Evaluates `required`, `not_empty`, `uuid`, `number`, `enum`, `regex`, `contains:X` rules + conditionals |
| **Panel UI** | Chronological hit list with colour-coded status; expandable detail pane |
| **Filtering** | Filter by status (PASS / FAIL / WARNING) and event name |
| **Export** | Download a full JSON validation report |
| **Snapshot / Diff** | Save any hit as a baseline; compare future hits and view a structural diff |
| **Options page** | Contract CRUD editor; active contract selector; environment → contract mappings |
| **Multi-environment** | Map hostname patterns to different contracts (e.g. `*.staging.com → my-site-stage`) |

---

## Loading in Chrome / Edge

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository root folder.
5. Open DevTools on any page (`F12`) and navigate to the **Analytics QA** tab.

---

## Contract format

```json
{
  "purchase": {
    "required": ["events", "purchaseID", "eVar1", "products"],
    "rules": {
      "purchaseID": "uuid",
      "eVar1": "not_empty",
      "events": "contains:purchase",
      "products": "not_empty"
    },
    "conditionals": [
      { "if_event": "purchase", "require": ["purchaseID", "products"] }
    ]
  },
  "default": {
    "required": ["pageName", "server"],
    "rules": {
      "pageName": "not_empty",
      "server": "not_empty"
    },
    "conditionals": []
  }
}
```

### Supported rules

| Rule | Description |
|------|-------------|
| `not_empty` | Value must be a non-empty string |
| `number` | Value must be a finite number |
| `uuid` | Value must match RFC-4122 UUID format |
| `contains:<value>` | Array field must include the specified value |
| `enum:<a>\|<b>\|…` | Value must be one of the pipe-separated options |
| `regex:<pattern>` | Value must match the regular expression |

---

## Example exported report

```json
{
  "generatedAt": "2026-02-26T12:00:00.000Z",
  "tabId": 42,
  "totalHits": 5,
  "filteredHits": 5,
  "summary": { "PASS": 3, "FAIL": 2, "WARNING": 0 },
  "hits": [
    {
      "id": "42-1740571200000-abc123",
      "timestamp": "2026-02-26T12:00:00.000Z",
      "url": "https://metrics.example.omtrdc.net/b/ss/prod/1/...",
      "method": "GET",
      "events": ["purchase"],
      "status": "PASS",
      "matchedRule": "purchase",
      "errors": [],
      "warnings": [],
      "payload": {
        "events": ["purchase"],
        "purchaseID": "550e8400-e29b-41d4-a716-446655440000",
        "eVar1": "user123",
        "products": ";Widget;1;9.99"
      }
    }
  ]
}
```

---

## Running tests

```bash
npm install
npm test
```

---

## Possible future improvements

- Remote contract synchronisation (fetch from a versioned API endpoint)
- Authentication layer for enterprise access control
- Per-release validation metrics dashboard
- GitHub Actions integration to run contract checks against HAR files
- Support for Adobe Experience Platform Web SDK (`/ee/` endpoints)
