# Skin Sniper — Backend API

A lightweight Node.js server that fetches and compares skin prices across
Skinport, Steam Market, and CSFloat, then serves deals to the dashboard.

## Setup

**Requirements:** Node.js 18+

```bash
# 1. Install dependencies
npm install

# 2. Start the server (auto-restarts on file changes)
npm run dev

# Or just run it
npm start
```

The API runs on **http://localhost:3001** by default.

---

## Endpoints

### `GET /health`
Simple health check.
```json
{ "ok": true, "time": "2026-03-22T12:00:00.000Z" }
```

### `GET /deals`
Returns a list of snipe opportunities sorted by discount.

**Query parameters:**

| Param         | Default | Description                              |
|---------------|---------|------------------------------------------|
| `game`        | `cs2`   | `cs2`, `dota2`, or `tf2`                |
| `minPrice`    | `0.05`  | Minimum listing price in USD             |
| `maxPrice`    | `50`    | Maximum listing price in USD             |
| `minDiscount` | `15`    | Minimum % below market price             |
| `source`      | `all`   | `all`, `skinport`, `steam`, or `csfloat` |

**Example:**
```
GET http://localhost:3001/deals?game=cs2&minPrice=1&maxPrice=20&minDiscount=20
```

**Response:**
```json
{
  "deals": [
    {
      "name": "AK-47 | Redline (Field-Tested)",
      "game": "cs2",
      "source": "skinport",
      "listing": 4.20,
      "market": 6.10,
      "discount": 31.1,
      "profit": 1.17,
      "url": "https://skinport.com/item/ak-47-redline-field-tested"
    }
  ],
  "scannedAt": "2026-03-22T12:00:00.000Z",
  "count": 1
}
```

---

## Connecting to the dashboard

In the dashboard widget, change the `API_BASE` constant at the top of the
script block from `""` (mock mode) to `"http://localhost:3001"`.

The dashboard's "Scan now" button will then call the real API.

---

## Rate limits & caching

- **Steam** is throttled to 1 request per 3.5 seconds (their limit is ~1/3s).
  A scan checks up to 8 Steam items per game to stay safe.
- **Skinport** sales history is cached for 5 minutes (their recommended TTL).
- **CSFloat** listings are cached for 5 minutes.

If you're hitting rate limits, increase `RATE_LIMIT_MS` in `server.js`.

---

## Expanding the item list

The server uses a `SEED_ITEMS` list in `server.js` as starting points for price
lookups. To add more items, just append to the relevant array:

```js
const SEED_ITEMS = {
  cs2: [
    "AK-47 | Redline (Field-Tested)",
    "Your New Item Here",   // <-- add any Steam market_hash_name
    ...
  ],
  ...
};
```

You can find the exact `market_hash_name` for any item on the Steam Community
Market URL — it's the name after `/listings/730/`.

---

## Next steps

- Add a SQLite database to track price history over time
- Add desktop notifications (via `node-notifier`) when a hot deal appears
- Scrape a full item list from a community source like CSGO Stash
- Add Buff163 as a fourth price source
