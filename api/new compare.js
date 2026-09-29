const API_BASE = 'https://api.quickcommerceapi.com';
const PLATFORMS = ['BlinkIt', 'Zepto', 'Swiggy', 'Minutes'];

function norm(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

function tokens(s = '') {
  return norm(s).split(/\s+/).filter(Boolean);
}

// Detect product size: kg/g/mg or L/ml, plus piece/pack counts.
function extractSize(s = '') {
  const text = norm(s);

  const matches = [
    ...text.matchAll(
      /(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|pcs|pc|pack|packs|count|ct|litre|liter)\b/g
    )
  ];

  if (!matches.length) return null;

  // Prefer weight/volume over pack count.
  const preferred =
    matches.find(m =>
      ['kg', 'g', 'mg', 'l', 'ml', 'litre', 'liter'].includes(m[2])
    ) || matches[0];

  const value = Number(preferred[1]);
  const unit = preferred[2];

  if (!Number.isFinite(value)) return null;

  if (unit === 'kg') {
    return { type: 'weight', value: value * 1000, unit: 'g' };
  }

  if (unit === 'g') {
    return { type: 'weight', value, unit: 'g' };
  }

  if (unit === 'mg') {
    return { type: 'weight', value: value / 1000, unit: 'g' };
  }

  if (unit === 'l' || unit === 'litre' || unit === 'liter') {
    return { type: 'volume', value: value * 1000, unit: 'ml' };
  }

  if (unit === 'ml') {
    return { type: 'volume', value, unit: 'ml' };
  }

  return { type: 'count', value, unit: 'pc' };
}

function sizeKey(s = '') {
  const size = extractSize(s);

  return size
    ? `${size.type}:${size.value}:${size.unit}`
    : null;
}

function productText(p = {}) {
  return `${p.brand || ''} ${p.name || ''} ${p.quantity || ''} ${p.weight || ''}`;
}

function querySize(query) {
  return extractSize(query);
}

function scoreProduct(query, p) {
  const q = tokens(query);
  const name = tokens(productText(p));
  const set = new Set(name);

  let score = 0;

  for (const t of q) {
    if (set.has(t)) score += 2;
  }

  const qSize = querySize(query);
  const pSize = extractSize(productText(p));

  // Strongly prefer exactly matching pack size.
  if (
    qSize &&
    pSize &&
    qSize.type === pSize.type &&
    qSize.value === pSize.value
  ) {
    score += 10;
  }

  // Penalize wrong sizes when user explicitly searched a size.
  if (
    qSize &&
    (!pSize ||
      qSize.type !== pSize.type ||
      qSize.value !== pSize.value)
  ) {
    score -= 20;
  }

  if (p.brand && norm(query).includes(norm(p.brand))) {
    score += 3;
  }

  if (p.available === true || p.in_stock === true) {
    score += 0.5;
  }

  return score;
}

function pickBest(query, products = [], targetSizeKey = null) {
  const filtered = targetSizeKey
    ? products.filter(
        p => sizeKey(productText(p)) === targetSizeKey
      )
    : products;

  return (
    [...filtered].sort(
      (a, b) =>
        scoreProduct(query, b) -
        scoreProduct(query, a)
    )[0] || null
  );
}

function productsForPlatform(grouped, platform) {
  const raw =
    grouped[platform] ||
    grouped[platform.toLowerCase()] ||
    [];

  return Array.isArray(raw)
    ? raw
    : raw.products || raw.results || [];
}

function chooseCommonSize(query, platformProducts) {
  const requested = querySize(query);

  // If user searched "Sprite 2L", use 2L exactly.
  if (requested) {
    return `${requested.type}:${requested.value}:${requested.unit}`;
  }

  // For a search like "Sprite", find a size that exists
  // on the greatest number of platforms.
  const counts = new Map();

  for (const products of platformProducts) {
    const seenOnPlatform = new Set();

    for (const p of products) {
      const key = sizeKey(productText(p));

      if (key) {
        seenOnPlatform.add(key);
      }
    }

    for (const key of seenOnPlatform) {
      counts.set(
        key,
        (counts.get(key) || 0) + 1
      );
    }
  }

  if (!counts.size) return null;

  let bestKey = null;
  let bestCount = 0;

  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  // Only use the common size if it appears on
  // at least two platforms.
  return bestCount >= 2 ? bestKey : null;
}

export default async function handler(req, res) {
  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const key =
    process.env.QUICKCOMMERCE_API_KEY;

  if (!key) {
    return res.status(500).json({
      error:
        'QUICKCOMMERCE_API_KEY is not configured on the server.'
    });
  }

  const url = new URL(
    req.url,
    `https://${req.headers.host || 'localhost'}`
  );

  const q =
    (url.searchParams.get('q') || '').trim();

  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');

  const pincode =
    (url.searchParams.get('pincode') || '').trim();

  if (!q) {
    return res.status(400).json({
      error: 'Missing q'
    });
  }

  if (!lat || !lon) {
    return res.status(400).json({
      error:
        'Location is required. Allow browser location access and try again.'
    });
  }

  const params = new URLSearchParams({
    q,
    lat,
    lon,
    platforms: PLATFORMS.join(','),
    group: 'false'
  });

  if (pincode) {
    params.set('pincode', pincode);
  }

  let upstream;

  try {
    upstream = await fetch(
      `${API_BASE}/v1/groupsearch?${params.toString()}`,
      {
        headers: {
          'X-API-Key': key,
          Accept: 'application/json',

          ...(pincode
            ? {
                'x-geolocation-pincode': pincode
              }
            : {})
        }
      }
    );
  } catch (err) {
    return res.status(502).json({
      error:
        'Could not connect to the price API.',
      details: String(
        err?.message || err
      )
    });
  }

  const text = await upstream.text();

  let body = null;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return res.status(502).json({
      error:
        'The price API returned a non-JSON response.',
      upstreamStatus: upstream.status,
      details: text.slice(0, 300)
    });
  }

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error:
        body?.error ||
        body?.message ||
        'Price API request failed',

      details: body
    });
  }

  const grouped =
    body?.data?.results ||
    body?.results ||
    {};

  const allProducts = PLATFORMS.map(
    platform =>
      productsForPlatform(
        grouped,
        platform
      )
  );

  // Determine the pack size that should be compared.
  const targetSizeKey =
    chooseCommonSize(
      q,
      allProducts
    );

  const results = PLATFORMS.map(
    (platform, index) => {
      const products =
        allProducts[index];

      const p = pickBest(
        q,
        products,
        targetSizeKey
      );

      if (!p) {
        return {
          platform,
          available: false,

          reason: targetSizeKey
            ? 'Matching pack size not available'
            : 'No matching product found'
        };
      }

      const available =
        p.available ??
        p.in_stock ??
        false;

      const price =
        p.offer_price ??
        p.price ??
        null;

      const mrp =
        p.mrp ??
        null;

      const eta =
        p.platform?.sla ??
        p.sla ??
        p.eta ??
        null;

      const quantity =
        p.quantity ||
        p.weight ||
        '';

      return {
        platform,
        available: Boolean(
          available
        ),

        name:
          p.name || q,

        brand:
          p.brand || '',

        quantity,

        price,

        mrp,

        image:
          p.image ||
          p.images?.[0] ||
          null,

        eta,

        deeplink:
          p.deeplink ||
          p.url ||
          null,

        inventory:
          p.inventory ??
          null,

        id:
          p.id ||
          p.productId ||
          null
      };
    }
  );

  const available =
    results.filter(
      r =>
        r.available &&
        typeof r.price === 'number'
    );

  const cheapest =
    available.length
      ? available.reduce(
          (a, b) =>
            a.price <= b.price
              ? a
              : b
        )
      : null;

  res.setHeader(
    'Cache-Control',
    's-maxage=15, stale-while-revalidate=60'
  );

  return res.status(200).json({
    query: q,
    pincode,

    matchedPackSize:
      targetSizeKey,

    results,

    cheapest,

    creditsRemaining:
      body?.credits_remaining ??
      body?.data
        ?.credits_remaining ??
      null
  });
}
