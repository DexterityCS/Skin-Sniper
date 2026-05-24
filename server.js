import "dotenv/config";
import notifier from "node-notifier";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import zlib from "zlib";
import { promisify } from "util";

const brotliDecompress = promisify(zlib.brotliDecompress);
const app = express();
app.use(cors());
app.use(express.json());

const STEAM_API_KEY = process.env.STEAM_API_KEY || "";
const STEAM_ID      = process.env.STEAM_ID      || "";
const CSFLOAT_KEY   = process.env.CSFLOAT_KEY   || "";

const SKINPORT_API = "https://api.skinport.com/v1";
const CSFLOAT_API  = "https://csfloat.com/api/v1";
const BYMYKEL_API  = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en";
const APP_IDS      = { cs2: 730, dota2: 570, tf2: 440 };
const TIMEOUT_MS   = 15000;
const CSFLOAT_FEE  = 0.02;
const SKINPORT_FEE = 0.12;
const STEAM_FEE    = 0.15;

// ── Notification settings ─────────────────────────────────────────────────────
const NOTIFY_MIN_PROFIT   = parseFloat(process.env.NOTIFY_MIN_PROFIT  || "10");
const NOTIFY_MIN_DISCOUNT = parseFloat(process.env.NOTIFY_MIN_DISCOUNT || "25");
const notifiedDeals = new Set(); // avoid repeat notifications for same item

function notifyDeal(deal) {
  const key = deal.name + ":" + deal.source;
  if (notifiedDeals.has(key)) return;
  notifiedDeals.add(key);
  setTimeout(function() { notifiedDeals.delete(key); }, 10 * 60 * 1000);
  const msg = deal.name + " | " + deal.discount + "% off | $" + deal.profit.toFixed(2) + " profit (" + deal.source + ")";
  console.log("[notify] HOT DEAL: " + msg);
  notifier.notify({ title: "Skin Sniper - Hot Deal!", message: msg, sound: true, wait: false });
}

// ── Price history (in-memory, saved to JSON file) ────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";

const DB_FILE = "prices.json";
let priceHistory = [];

// Load existing history from file
if (existsSync(DB_FILE)) {
  try {
    priceHistory = JSON.parse(readFileSync(DB_FILE, "utf8"));
    console.log("[db] Loaded " + priceHistory.length + " price records");
  } catch (e) {
    console.error("[db] Failed to load history:", e.message);
    priceHistory = [];
  }
}

function savePrices(deals) {
  const now = Date.now();
  const cutoff = now - (30 * 24 * 60 * 60 * 1000);
  // Add new records
  for (const d of deals) {
    priceHistory.push({
      name: d.name, source: d.source,
      listing: d.listing, market: d.market,
      discount: d.discount, profit: d.profit,
      scanned_at: now,
    });
  }
  // Prune records older than 30 days
  priceHistory = priceHistory.filter(function(r) { return r.scanned_at > cutoff; });
  // Save to file
  try {
    writeFileSync(DB_FILE, JSON.stringify(priceHistory));
    console.log("[db] Saved " + deals.length + " records, total: " + priceHistory.length);
  } catch (e) {
    console.error("[db] Save failed:", e.message);
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const e = cache.get(key);
  return (e && Date.now() < e.expires) ? e.data : null;
}
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// ── CS2 item list ─────────────────────────────────────────────────────────────
let cs2Items = [];
let itemsLoadedAt = 0;
async function loadCS2Items() {
  if (cs2Items.length > 0 && Date.now() - itemsLoadedAt < 24 * 60 * 60 * 1000) return cs2Items;
  console.log("[items] Fetching CS2 item list...");
  try {
    const res = await fetch(BYMYKEL_API + "/skins_not_grouped.json", {
      headers: { "User-Agent": "SkinSniper/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const skins = await res.json();
    const names = new Set();
    for (const s of skins) {
      if (s.market_hash_name) names.add(s.market_hash_name);
      if (s.stattrak && s.market_hash_name) names.add("StatTrak\u2122 " + s.market_hash_name);
    }
    cs2Items = [...names];
    itemsLoadedAt = Date.now();
    console.log("[items] Loaded " + cs2Items.length + " CS2 items.");
    return cs2Items;
  } catch (err) {
    console.error("[items] Failed:", err.message);
    return FALLBACK_CS2;
  }
}

// ── CSFloat trades ────────────────────────────────────────────────────────────
async function fetchCSFloatTrades() {
  try {
    const headers = { "User-Agent": "SkinSniper/1.0" };
    if (CSFLOAT_KEY) headers["Authorization"] = CSFLOAT_KEY;
    const res = await fetch(CSFLOAT_API + "/me/trades?state=queued,pending", {
      headers, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { console.error("[trades] Fetch failed:", res.status); return []; }
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.error("[trades] Error:", err.message);
    return [];
  }
}

// ── Pending / listed state ────────────────────────────────────────────────────
const pendingItems = new Map();
const listedItems  = new Map();

async function watchInventory() {
  if (pendingItems.size === 0) return;
  console.log("[watch] Checking " + pendingItems.size + " pending items...");
  try {
    const trades = await fetchCSFloatTrades();
    for (const trade of trades) {
      if (trade.state !== "completed") continue;
      const name = trade.item && trade.item.market_hash_name;
      if (!name || !pendingItems.has(name)) continue;
      const pending = pendingItems.get(name);
      console.log("[watch] Trade completed: " + name);
      pendingItems.delete(name);
      await autoListOnCSFloat({ assetid: trade.item.asset_id, market_hash_name: name }, pending.targetPrice);
    }
  } catch (err) {
    console.error("[watch] Error:", err.message);
  }
}

async function autoListOnCSFloat(item, targetPrice) {
  console.log("[csfloat] Auto-listing " + item.market_hash_name + " at $" + targetPrice + "...");
  try {
    const res = await fetch(CSFLOAT_API + "/listings", {
      method: "POST",
      headers: { "Authorization": CSFLOAT_KEY, "Content-Type": "application/json", "User-Agent": "SkinSniper/1.0" },
      body: JSON.stringify({ asset_id: item.assetid, price: Math.round(targetPrice * 100), type: "buy_now", max_offer_discount: 0 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json();
    if (!res.ok) { console.error("[csfloat] List failed:", JSON.stringify(json).slice(0, 200)); return; }
    console.log("[csfloat] Listed! ID: " + json.id);
    listedItems.set(item.market_hash_name, {
      listingId: json.id, name: item.market_hash_name, assetId: item.assetid,
      listedPrice: targetPrice, listedAt: new Date().toISOString(), status: "active",
    });
  } catch (err) {
    console.error("[csfloat] Auto-list error:", err.message);
  }
}

// ── Skinport all items ────────────────────────────────────────────────────────
async function fetchSkinportAll(appId) {
  const cacheKey = "sp_all:" + appId;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  console.log("[skinport] Fetching all items...");
  await new Promise(r => setTimeout(r, 2000));
  try {
    const params = new URLSearchParams({ app_id: appId, currency: "USD", tradable: 0 });
    const res = await fetch(SKINPORT_API + "/items?" + params, {
      headers: { "User-Agent": "SkinSniper/1.0", "Accept-Encoding": "br" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    console.log("[skinport] Status: " + res.status);
    if (res.status === 429) {
      console.log("[skinport] Rate limited — waiting 5 mins before retry");
      setCache(cacheKey, new Map(), 5 * 60 * 1000);
      return new Map();
    }
    if (!res.ok) return new Map();
    const buf = Buffer.from(await res.arrayBuffer());
    let data;
    try { data = JSON.parse(buf.toString()); }
    catch { try { const dec = await brotliDecompress(buf); data = JSON.parse(dec.toString()); } catch { return new Map(); } }
    const map = new Map();
    for (const item of (Array.isArray(data) ? data : [])) {
      if (item.market_hash_name && item.min_price != null)
        map.set(item.market_hash_name, { min_price: item.min_price, suggested_price: item.suggested_price, item_page: item.item_page });
    }
    console.log("[skinport] Got " + map.size + " items");
    setCache(cacheKey, map, 30 * 60 * 1000);
    return map;
  } catch (err) {
    console.error("[skinport] Failed:", err.message);
    return new Map();
  }
}

// ── CSFloat listings ──────────────────────────────────────────────────────────
async function fetchCSFloat(minPrice, maxPrice) {
  const cacheKey = "cf:" + minPrice + ":" + maxPrice;
  const cached = getCache(cacheKey);
  if (cached) { console.log("[csfloat] cache hit"); return cached; }
  console.log("[csfloat] Fetching listings $" + minPrice + "-$" + maxPrice + "...");
  try {
    const params = new URLSearchParams({ limit: 50, type: "buy_now", min_price: Math.round(minPrice * 100), max_price: Math.round(maxPrice * 100) });
    const headers = { "User-Agent": "SkinSniper/1.0" };
    if (CSFLOAT_KEY) headers["Authorization"] = CSFLOAT_KEY;
    const res = await fetch(CSFLOAT_API + "/listings?" + params, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    console.log("[csfloat] Status: " + res.status);
    if (!res.ok) { console.error("[csfloat] Error:", (await res.text()).slice(0, 200)); return []; }
    const json = await res.json();
    const data = json.data || [];
    if (data.length > 0) console.log("[csfloat] Sample reference fields:", JSON.stringify(data[0].reference || {}));
    console.log("[csfloat] Got " + data.length + " listings");
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    console.error("[csfloat] Failed:", err.message);
    return [];
  }
}


// ── Buff163 price — use Skinport suggested_price as reference (already cached) ─
async function fetchBuff163Price(marketHashName) {
  // Skinport suggested_price closely mirrors Buff163 market value
  // and is already loaded in memory — no extra API call needed
  const spData = await fetchSkinportAll(730);
  const item = spData.get(marketHashName);
  if (item && item.suggested_price) {
    return { usd: parseFloat(item.suggested_price.toFixed(2)), source: "skinport_ref" };
  }
  return null;
}

// GET /buff-price?name=... — lookup a single item price on Buff163
app.get("/buff-price", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });
  const price = await fetchBuff163Price(name);
  res.json({ name, buff: price });
});

app.get("/deals", async (req, res) => {
  const { game = "cs2", minPrice = 0.05, maxPrice = 1000, minDiscount = 10, source = "all" } = req.query;
  const appId = APP_IDS[game] || 730;
  const minP = parseFloat(minPrice), maxP = parseFloat(maxPrice), minDisc = parseFloat(minDiscount);
  console.log("\n[deals] game=" + game + " $" + minP + "-$" + maxP + " disc>=" + minDisc + "% source=" + source);
  const deals = [];

  if (source === "all" || source === "skinport") {
    const allItems = await fetchSkinportAll(appId);
    for (const [name, data] of allItems) {
      if (/Souvenir|souvenir/.test(name)) continue;
      const listing = data.min_price, market = data.suggested_price;
      if (!listing || !market || listing <= 0 || market <= 0 || listing < minP || listing > maxP) continue;
      const disc = ((market - listing) / market) * 100;
      if (disc < minDisc) continue;
      const profit = market * (1 - SKINPORT_FEE) - listing;
      if (profit <= 0) continue;
      deals.push({ name, game, source: "skinport", listing, market, discount: parseFloat(disc.toFixed(1)), profit: parseFloat(profit.toFixed(2)), url: data.item_page || "https://skinport.com/market?search=" + encodeURIComponent(name), listingId: null });
    }
    console.log("[skinport] " + deals.length + " deals");
  }

  if ((source === "all" || source === "csfloat") && game === "cs2") {
    const start = deals.length;
    const items = await fetchCSFloat(minP, Math.min(maxP, 500));
    for (const item of items) {
      const listing = item.price / 100;
      const ref = item.reference || {};
      const marketCents = ref.predicted_price || ref.base_price || ref.price || ref.last_sold || null;
      if (!marketCents) continue;
      const market = marketCents / 100;
      if (listing < minP || listing > maxP || market <= listing) continue;
      const disc = ((market - listing) / market) * 100;
      if (disc < minDisc) continue;
      const profit = market * (1 - CSFLOAT_FEE) - listing;
      if (profit <= 0) continue;
      deals.push({ name: (item.item && item.item.market_hash_name) || "Unknown", game: "cs2", source: "csfloat", listing, market, discount: parseFloat(disc.toFixed(1)), profit: parseFloat(profit.toFixed(2)), url: "https://csfloat.com/item/" + item.id, listingId: item.id });
    }
    console.log("[csfloat] " + (deals.length - start) + " deals");
  }

  deals.sort((a, b) => b.discount - a.discount);

  // Fire notifications for hot deals
  for (const deal of deals) {
    if (deal.profit >= NOTIFY_MIN_PROFIT && deal.discount >= NOTIFY_MIN_DISCOUNT) {
      notifyDeal(deal);
    }
  }

  // Save to price history
  if (deals.length > 0) {
    try { savePrices(deals); } catch (err) { console.error("[db] Save error:", err.message); }
  }

  console.log("[deals] Returning " + deals.length + " total deals");
  res.json({ deals, scannedAt: new Date().toISOString(), count: deals.length });
});

// ── Steam deals — buy on Steam, relist on CSFloat ────────────────────────────
app.get("/steam-deals", async (req, res) => {
  const { minDiscount = 10, minProfit = 5, minPrice = 50, maxPrice = 500 } = req.query;
  const minDisc = parseFloat(minDiscount), minProf = parseFloat(minProfit);
  const minP = parseFloat(minPrice), maxP = parseFloat(maxPrice);

  console.log("[steam-deals] Scanning skins $" + minP + "-$" + maxP + "...");
  const deals = [];

  // Use loaded CS2 skin list, skip non-weapon items
  const items = (cs2Items.length > 0 ? cs2Items : FALLBACK_CS2)
    .filter(n => !/Sticker|Graffiti|Case|Key|Agent|Patch|Music Kit|Pin|Sealed|Souvenir/.test(n))
    .sort(() => Math.random() - 0.5)
    .slice(0, 25);

  console.log("[steam-deals] Checking " + items.length + " random skins...");

  const cfHeaders = { "User-Agent": "SkinSniper/1.0" };
  if (CSFLOAT_KEY) cfHeaders["Authorization"] = CSFLOAT_KEY;

  // Load Skinport price cache once before loop
  const skinportCache = await fetchSkinportAll(730);
  console.log("[steam-deals] Skinport cache size: " + skinportCache.size);

  for (const name of items) {
    await new Promise(r => setTimeout(r, 3500));
    try {
      const params = new URLSearchParams({ appid: 730, market_hash_name: name, currency: 1 });
      const steamRes = await fetch("https://steamcommunity.com/market/priceoverview/?" + params, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!steamRes.ok) continue;
      const priceJson = await steamRes.json();
      if (!priceJson.success) continue;

      const parse = str => str ? parseFloat(str.replace(/[^0-9.]/g, "")) : null;
      const steamPrice = parse(priceJson.lowest_price);
      if (!steamPrice || steamPrice < minP || steamPrice > maxP) continue;
      console.log("[steam-deals] " + name + " -> $" + steamPrice.toFixed(2));

      // Get sell reference from pre-loaded Skinport cache, fall back to Steam median
      // Compare Steam lowest price vs Skinport min price
      // A deal exists when Steam is cheaper than what Skinport is selling for
      const spData = skinportCache.get(name);
      const spMin  = spData && spData.min_price;      // cheapest on Skinport right now
      const spSug  = spData && spData.suggested_price; // Skinport market value estimate

      // Use Skinport min as the buy comparison — if Steam is cheaper, it is a deal
      const marketRef = spSug || parse(priceJson.median_price);
      console.log("[steam-deals] " + name + " steam=$" + steamPrice.toFixed(2) + " spMin=" + (spMin ? "$" + spMin : "null") + " spSug=" + (spSug ? "$" + spSug : "null") + " marketRef=" + (marketRef ? "$" + marketRef.toFixed(2) : "null"));

      if (!marketRef) continue;
      // Sell on CSFloat at market ref — profit = (marketRef * 0.98) - steamPrice
      const sellNet  = marketRef * (1 - CSFLOAT_FEE);
      const profit   = sellNet - steamPrice;
      const discount = ((marketRef - steamPrice) / marketRef) * 100;
      console.log("[steam-deals] profit=$" + profit.toFixed(2) + " disc=" + discount.toFixed(1) + "%");
      if (discount < minDisc || profit < minProf) continue;
      const sellRef = marketRef;

      deals.push({
        name, source: "steam",
        buyPrice:  parseFloat(steamPrice.toFixed(2)),
        sellRef:   parseFloat(sellRef.toFixed(2)),
        sellNet:   parseFloat(sellNet.toFixed(2)),
        profit:    parseFloat(profit.toFixed(2)),
        discount:  parseFloat(discount.toFixed(1)),
        volume:    priceJson.volume ? parseInt(priceJson.volume.replace(/,/g, "")) : 0,
        url: "https://steamcommunity.com/market/listings/730/" + encodeURIComponent(name),
      });
      console.log("[steam-deals] DEAL: " + name + " buy $" + steamPrice.toFixed(2) + " profit $" + profit.toFixed(2));
    } catch (err) {
      console.error("[steam-deals] Error for " + name + ":", err.message);
    }
  }

  deals.sort((a, b) => b.profit - a.profit);
  console.log("[steam-deals] Found " + deals.length + " deals");
  res.json({ deals, scannedAt: new Date().toISOString(), count: deals.length });
});

// GET /history/:name — get price history for a specific item
app.get("/history/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const rows = priceHistory.filter(function(r) { return r.name === name; })
    .sort(function(a,b) { return b.scanned_at - a.scanned_at; })
    .slice(0, 500);
  res.json({ name, history: rows });
});

// GET /history-search?q=... — search items in history
app.get("/history-search", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  const names = [...new Set(priceHistory.map(function(r) { return r.name; }))]
    .filter(function(n) { return n.toLowerCase().includes(q); })
    .slice(0, 20);
  res.json({ results: names });
});

app.post("/buy", (req, res) => {
  const { name, listingId, market } = req.body;
  if (!name || !market) return res.status(400).json({ error: "name and market required" });
  const targetPrice = parseFloat((market * (1 - CSFLOAT_FEE) * 0.98).toFixed(2));
  pendingItems.set(name, { name, listingId, market, targetPrice, boughtAt: new Date().toISOString() });
  console.log("[buy] Tracking " + name + " -> list at $" + targetPrice);
  res.json({ ok: true, name, targetPrice, message: "Watching for this item" });
});

app.get("/inventory", (_, res) => res.json({ pending: [...pendingItems.values()], listed: [...listedItems.values()] }));

app.delete("/listing/:id", async (req, res) => {
  try {
    const headers = { "Authorization": CSFLOAT_KEY, "User-Agent": "SkinSniper/1.0" };
    const r = await fetch(CSFLOAT_API + "/listings/" + req.params.id, { method: "DELETE", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return res.status(r.status).json({ error: "Failed to cancel" });
    for (const [name, item] of listedItems) { if (item.listingId === req.params.id) { listedItems.delete(name); break; } }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function initInventory() {
  console.log("[init] Checking CSFloat connection...");
  const trades = await fetchCSFloatTrades();
  console.log("[init] CSFloat trades API ready. Active trades: " + trades.length);
}

const FALLBACK_CS2 = [
  "AK-47 | Redline (Field-Tested)", "AK-47 | Asiimov (Field-Tested)",
  "AWP | Asiimov (Battle-Scarred)", "AWP | Redline (Field-Tested)",
  "M4A4 | Howl (Minimal Wear)", "M4A1-S | Hyper Beast (Field-Tested)",
  "Glock-18 | Fade (Factory New)", "Desert Eagle | Blaze (Factory New)",
  "Karambit | Fade (Factory New)", "Butterfly Knife | Tiger Tooth (Factory New)",
];

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Skin sniper API running on http://localhost:" + PORT);
  loadCS2Items().catch(() => {});
  setTimeout(async () => {
    await initInventory();
    setInterval(watchInventory, 30 * 1000);
  }, 2000);
});
