const API_BASE = 'https://api.quickcommerceapi.com';
const PLATFORMS = ['BlinkIt', 'Zepto', 'Swiggy', 'Minutes'];

function norm(s = '') {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(s = '') { return norm(s).split(/\s+/).filter(Boolean); }
function quantityTokens(s = '') {
  return (norm(s).match(/\d+(?:\.\d+)?\s*(?:kg|g|mg|l|ml|pcs|pc|pack|packs|count|ct|litre|liter)?/g) || []).join(' ');
}
function scoreProduct(query, p) {
  const q = tokens(query);
  const name = tokens(`${p.brand || ''} ${p.name || ''} ${p.quantity || ''}`);
  const set = new Set(name);
  let score = 0;
  for (const t of q) if (set.has(t)) score += 2;
  const qQty = quantityTokens(query);
  const pQty = quantityTokens(`${p.name || ''} ${p.quantity || ''}`);
  if (qQty && pQty && qQty === pQty) score += 6;
  if (p.brand && norm(query).includes(norm(p.brand))) score += 3;
  if (p.available === true) score += 0.5;
  return score;
}
function pickBest(query, products = []) {
  return [...products].sort((a,b) => scoreProduct(query,b) - scoreProduct(query,a))[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.QUICKCOMMERCE_API_KEY;
  if (!key) return res.status(500).json({ error: 'QUICKCOMMERCE_API_KEY is not configured on the server.' });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get('q') || '').trim();
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');
  const pincode = (url.searchParams.get('pincode') || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });
  if (!lat || !lon) return res.status(400).json({ error: 'Location is required. Tap Use my location and allow location access.' });

  const params = new URLSearchParams({ q, lat, lon, platforms: PLATFORMS.join(','), group: 'false' });
  if (pincode) params.set('pincode', pincode);
  const upstream = await fetch(`${API_BASE}/v1/groupsearch?${params.toString()}`, {
    headers: { 'X-API-Key': key, ...(pincode ? { 'x-geolocation-pincode': pincode } : {}) }
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return res.status(upstream.status).json({ error: body?.error || body?.message || 'Price API request failed', details: body });

  const grouped = body?.data?.results || body?.results || {};
  const results = PLATFORMS.map(platform => {
    const raw = grouped[platform] || grouped[platform.toLowerCase()] || [];
    const products = Array.isArray(raw) ? raw : (raw.products || raw.results || []);
    const p = pickBest(q, products);
    if (!p) return { platform, available: false, reason: 'No matching product found' };
    const available = p.available ?? p.in_stock ?? false;
    return {
      platform,
      available: Boolean(available),
      name: p.name || q,
      brand: p.brand || '',
      quantity: p.quantity || p.weight || '',
      price: p.offer_price ?? p.price ?? null,
      mrp: p.mrp ?? null,
      image: p.image || p.images?.[0] || null,
      eta: p.platform?.sla || p.eta || null,
      deeplink: p.deeplink || p.url || null,
      inventory: p.inventory ?? null,
      id: p.id || p.productId || null
    };
  });

  const available = results.filter(r => r.available && typeof r.price === 'number');
  const cheapest = available.length ? available.reduce((a,b) => a.price <= b.price ? a : b) : null;
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  return res.status(200).json({ query: q, pincode, results, cheapest, creditsRemaining: body?.credits_remaining ?? null });
}
