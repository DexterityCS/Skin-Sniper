# Skin Sniper

A personal CS2 skin arbitrage tool that scans Skinport and CSFloat for underpriced listings, compares them against market value, and automatically relists purchased items on CSFloat for profit.

## Features

- **Live deal scanner** — scans Skinport (12,000+ items) and CSFloat for listings below market price
- **Steam buys tab** — finds skins cheaper on Steam Market than their CSFloat resell value
- **Buy & Relist flow** — click to open the purchase page, server watches for the item to arrive and auto-lists it on CSFloat
- **Profit calculator** — accounts for Skinport (12%), CSFloat (2%), and Steam (15%) fees
- **Auto-refresh** — set a scan interval and leave it running
- **Local dashboard** — simple HTML file, no hosting needed

## Stack

- **Backend** — Node.js + Express
- **Data sources** — Skinport API, CSFloat API, Steam Market API, ByMykel CSGO-API
- **Dashboard** — vanilla HTML/CSS/JS, opens as a local file

## Setup

**Requirements:** Node.js 18+

```bash
# 1. Clone or download the repo
cd Skin-Sniper

# 2. Install dependencies
npm install

# 3. Configure your API keys (see below)
# 4. Start the server
npm run dev
```

Open `dashboard.html` in your browser. The server runs on `http://localhost:3001`.

## Configuration

Create a `.env` file in the project root:

```env
STEAM_API_KEY=your_steam_api_key
STEAM_ID=your_64bit_steam_id
CSFLOAT_KEY=your_csfloat_api_key
PORT=3001
```

**Getting your keys:**

| Key | Where to get it |
|-----|----------------|
| `STEAM_API_KEY` | https://steamcommunity.com/dev/apikey |
| `STEAM_ID` | https://steamid.io — paste your profile URL, copy the `steamID64` value |
| `CSFLOAT_KEY` | https://csfloat.com — Profile → Settings → API |

## How it works

### Deals tab
Fetches all Skinport listings and compares `min_price` against `suggested_price`. Also pulls CSFloat buy-now listings and compares against their reference price. Items where the listing price is below market by your chosen threshold show up as deals.

### Steam buys tab
Randomly samples weapon skins from the full CS2 item list, checks their Steam Market price, and compares against Skinport's suggested price as the resell reference. Useful for catching underpriced Steam listings.

### Buy & Relist
1. Click **Buy & Relist** on any deal
2. Purchase page opens in a new tab — complete the purchase manually
3. Server polls CSFloat's trades API every 30 seconds
4. When the trade completes, the item is automatically listed on CSFloat at just under market price

### Profit calculation

| Platform | Fee | Formula |
|----------|-----|---------|
| Skinport | 12% | `market × 0.88 - listing` |
| CSFloat | 2% | `market × 0.98 - listing` |
| Steam → CSFloat | 15% buy-side baked in | `sellRef × 0.98 - steamPrice` |

## File structure

```
Skin-Sniper/
├── server.js        # Express API server
├── dashboard.html   # Local frontend dashboard
├── package.json
├── .env             # Your API keys (never commit this)
└── .gitignore
```

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server health check |
| `GET /deals` | Skinport + CSFloat deals |
| `GET /steam-deals` | Steam Market arbitrage opportunities |
| `POST /buy` | Register a purchase for inventory watching |
| `GET /inventory` | Pending and listed items |
| `DELETE /listing/:id` | Cancel a CSFloat listing |

### Deal filters

| Param | Default | Description |
|-------|---------|-------------|
| `game` | `cs2` | `cs2`, `dota2`, `tf2` |
| `minPrice` | `0.05` | Minimum listing price |
| `maxPrice` | `1000` | Maximum listing price |
| `minDiscount` | `15` | Minimum % below market |
| `source` | `all` | `all`, `skinport`, `csfloat` |

## Rate limits & caching

| Source | Cache TTL | Notes |
|--------|-----------|-------|
| Skinport | 15 minutes | Bulk fetch of all items at once |
| CSFloat | 5 minutes | 50 listings per scan |
| Steam | 10 minutes per item | Rate limited to 1 req/3.5s |
| ByMykel item list | 24 hours | 20,000+ CS2 skin names |

## Notes

- Steam buying opportunities are rare — Steam prices typically run higher than third-party sites due to the built-in 15% fee. The scanner catches occasional underpriced listings.
- Skinport's API rate limits to ~4 requests per minute. The 15-minute cache prevents 429 errors during normal use.
- Auto-relisting requires a completed CSFloat trade — items bought on Steam must be registered manually via the Buy & Relist button.
- Always verify deals manually before purchasing. Steam's price API can return stale or incorrect data for items with multiple variants (e.g. Doppler phases).

## Disclaimer

This tool is for personal use. Always comply with the terms of service of Steam, Skinport, and CSFloat. Automated purchasing is not supported — all buys require manual confirmation.
