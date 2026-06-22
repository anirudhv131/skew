// api/markets.js  —  Vercel serverless function (Node 18+, global fetch)
// Pulls live markets from Kalshi + Polymarket, matches the same event, returns JSON.
// Open /api/markets directly to read debug counts. ?sample=1 shows a raw Kalshi market.

const STOP = new Set("the a an to of in on for will be is are at by vs and or win wins reach above below before after team next this who what when 2024 2025 2026 2027".split(" "));
function tokens(s){ return new Set(String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(w=>w.length>2 && !STOP.has(w))); }
function similarity(a,b){ const A=tokens(a),B=tokens(b); if(!A.size||!B.size) return 0; let i=0; for(const t of A) if(B.has(t)) i++; return i/Math.min(A.size,B.size); }
function guessCat(t){ t=t.toLowerCase();
  if(/nba|finals|playoff|mvp|celtics|lakers|thunder|knicks/.test(t)) return "NBA";
  if(/nfl|super bowl|chiefs|quarterback|playoffs|touchdown/.test(t)) return "NFL";
  if(/premier league|world cup|usmnt|champions league|\bfc\b|united|la liga/.test(t)) return "Soccer";
  if(/senate|president|election|congress|supreme court|nominee|governor|primary/.test(t)) return "Politics";
  if(/bitcoin|\bbtc\b|ethereum|\beth\b|crypto|solana/.test(t)) return "Crypto";
  if(/\bfed\b|rate|inflation|cpi|gdp|recession|jobs/.test(t)) return "Econ";
  return "Other";
}

// Accept any price shape Kalshi uses: cents (44) or dollars (0.44), bid/ask or last.
function kalshiYesCents(m){
  const cand = [
    m.yes_bid != null && m.yes_ask != null ? (m.yes_bid + m.yes_ask) / 2 : null,
    m.last_price,
    m.yes_bid, m.yes_ask,
    m.yes_bid_dollars != null && m.yes_ask_dollars != null ? (m.yes_bid_dollars + m.yes_ask_dollars) / 2 * 100 : null,
    m.last_price_dollars != null ? m.last_price_dollars * 100 : null,
  ];
  for(let v of cand){
    if(v == null || isNaN(v)) continue;
    if(v > 0 && v <= 1) v = v * 100;     // dollars -> cents
    if(v > 1 && v < 100) return Math.round(v);
  }
  return null;
}

async function getKalshi(debug){
  const hosts = [
    "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000",
    "https://external-api.kalshi.com/trade-api/v2/markets?limit=1000",
  ];
  for(const url of hosts){
    try{
      const r = await fetch(url, { headers:{accept:"application/json"} });
      const host = url.split("/")[2];
      if(!r.ok){ debug.kalshiAttempts.push(host+" -> HTTP "+r.status); continue; }
      const j = await r.json();
      const raw = (j.markets||[]);
      debug.kalshiAttempts.push(host+" -> "+raw.length+" raw");
      if(!raw.length) continue;
      if(!debug.kalshiSampleKeys && raw[0]) debug.kalshiSampleKeys = Object.keys(raw[0]);
      const out = raw.map(m=>{
        const yes = kalshiYesCents(m);
        return yes==null ? null : { title:(m.title||m.yes_sub_title||m.subtitle||m.ticker), yes, resolves:(m.close_time||m.expiration_time||"").slice(0,10) };
      }).filter(Boolean);
      debug.kalshiHost = host; debug.kalshiKept = out.length;
      return out;
    }catch(e){ debug.kalshiAttempts.push("err "+String(e.message)); }
  }
  return [];
}

async function getPolymarket(debug){
  const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=500";
  const r = await fetch(url, { headers:{accept:"application/json"} });
  if(!r.ok){ debug.errors.push("polymarket HTTP "+r.status); return []; }
  const arr = await r.json();
  debug.polyRaw = (arr||[]).length;
  return (arr||[]).map(m=>{
    let prices, outs;
    try{ prices=JSON.parse(m.outcomePrices||"[]"); outs=JSON.parse(m.outcomes||"[]"); }catch{ return null; }
    if(!Array.isArray(outs)||outs.length!==2) return null;
    if(!/yes/i.test(outs[0]) && !/yes/i.test(outs[1])) return null;
    const yi=/yes/i.test(outs[0])?0:1;
    const yes=Math.round(parseFloat(prices[yi])*100);
    return isNaN(yes)?null:{ title:m.question, yes, resolves:(m.endDate||"").slice(0,10) };
  }).filter(Boolean).filter(m=>m.yes>2 && m.yes<98);
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","s-maxage=20, stale-while-revalidate=40");
  const debug = { kalshiHost:null, kalshiAttempts:[], kalshiKept:null, kalshiSampleKeys:null, polyRaw:null, errors:[] };
  let kalshi=[], poly=[];
  try{ kalshi=await getKalshi(debug); }catch(e){ debug.errors.push("kalshi "+String(e.message)); }
  try{ poly=await getPolymarket(debug); }catch(e){ debug.errors.push("poly "+String(e.message)); }

  const THRESHOLD=0.5, pairs=[], used=new Set();
  for(const k of kalshi){
    let best=null, score=THRESHOLD;
    for(let i=0;i<poly.length;i++){ if(used.has(i)) continue; const s=similarity(k.title,poly[i].title); if(s>score){score=s;best=i;} }
    if(best!=null){ used.add(best); const p=poly[best];
      pairs.push({ cat:guessCat(k.title+" "+p.title), title:String(k.title).replace(/^will (the )?/i,"").replace(/\?$/,""), resolves:k.resolves||p.resolves||"", k:k.yes, p:p.yes, match:+score.toFixed(2) });
    }
  }
  pairs.sort((a,b)=>Math.abs(b.k-b.p)-Math.abs(a.k-a.p));

  res.status(200).json({
    live: pairs.length>0,
    counts:{ kalshi:kalshi.length, polymarket:poly.length, matched:pairs.length },
    debug,
    markets: pairs.slice(0,60),
    updated:new Date().toISOString(),
  });
}
