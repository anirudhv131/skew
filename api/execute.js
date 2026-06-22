// api/execute.js  —  Vercel serverless function (Node 18+)
// Fires BOTH legs of an arbitrage in parallel and reports fills.
//
// ⚠️  SHIPS IN PAPER MODE. It will NOT place real orders until you:
//      1) Add your authenticated credentials as environment variables (never in code, never in the browser).
//      2) Implement the two placeOrder stubs below.
//      3) Send dryRun:false from the client (the "Live trading" toggle).
//
// IMPORTANT TRUTH: two orders on two independent venues (one of them on-chain) can NOT
// be made atomic. Firing in parallel shrinks the window; it does not remove leg risk.
// That's why this returns per-leg fill status so the UI can flag exposure instantly.

const KALSHI_KEY   = process.env.KALSHI_API_KEY    || null;  // set in Vercel env, server-side only
const POLY_PK      = process.env.POLYMARKET_PK     || null;  // wallet private key — NEVER ship client-side

// ---- Kalshi order (STUB) -------------------------------------------------
async function placeKalshiOrder(leg){
  // TODO: implement authenticated order via Kalshi REST:
  //   POST https://api.elections.kalshi.com/trade-api/v2/portfolio/orders
  //   body: { ticker, action:"buy", side:"yes"|"no", type:"limit", yes_price/no_price: leg.price, count: ... }
  //   headers: signed request (RSA) per Kalshi auth spec, using KALSHI_KEY.
  // Use a LIMIT order at leg.price so you never overpay past the edge.
  throw new Error("Kalshi order not implemented — running in paper mode");
}

// ---- Polymarket order (STUB) ---------------------------------------------
async function placePolymarketOrder(leg){
  // TODO: implement signed CLOB order via @polymarket/clob-client:
  //   const client = new ClobClient(host, chainId, wallet)  // wallet from POLY_PK
  //   await client.postOrder(client.createOrder({ tokenID, side:"BUY", price: leg.price/100, size }))
  //   Settlement is on-chain (Polygon) — confirmation takes seconds and can fail. Handle it.
  throw new Error("Polymarket order not implemented — running in paper mode");
}

// Paper simulation: ~12% of the time one leg slips, so you can SEE partial-fill handling.
function paperFill(){
  const both = Math.random() > 0.12;
  return { yesFilled:true, noFilled:both };
}

export default async function handler(req, res){
  if(req.method !== 'POST'){ res.status(405).json({error:'POST only'}); return; }
  const { legs, dryRun = true } = req.body || {};
  if(!legs || !legs.yes || !legs.no){ res.status(400).json({error:'missing legs'}); return; }

  // Hard safety gate: refuse live unless explicitly off-paper AND credentials present.
  const canGoLive = dryRun === false && KALSHI_KEY && POLY_PK;
  if(dryRun === false && !canGoLive){
    res.status(200).json({ dryRun:true, blocked:true,
      note:'Live blocked: add KALSHI_API_KEY + POLYMARKET_PK env vars and implement the order stubs.',
      ...paperFill(), profit: legs.profit });
    return;
  }

  if(!canGoLive){
    // PAPER MODE
    res.status(200).json({ dryRun:true, ...paperFill(), profit: legs.profit });
    return;
  }

  // ---- LIVE: fire both legs in parallel, then inspect each independently ----
  const kalshiLeg = legs.yes.venue === 'Kalshi' ? legs.yes : legs.no;
  const polyLeg   = legs.yes.venue === 'Kalshi' ? legs.no  : legs.yes;

  const [kRes, pRes] = await Promise.allSettled([
    placeKalshiOrder(kalshiLeg),
    placePolymarketOrder(polyLeg),
  ]);
  const kalshiFilled = kRes.status === 'fulfilled';
  const polyFilled   = pRes.status === 'fulfilled';

  // If exactly one filled, you are EXPOSED. Surface it loudly; consider auto-unwind here.
  const exposed = kalshiFilled !== polyFilled;

  res.status(200).json({
    dryRun:false,
    yesFilled: legs.yes.venue === 'Kalshi' ? kalshiFilled : polyFilled,
    noFilled:  legs.no.venue  === 'Kalshi' ? kalshiFilled : polyFilled,
    exposed,
    profit: legs.profit,
    legs: { kalshi:kRes.status, polymarket:pRes.status },
  });
}
