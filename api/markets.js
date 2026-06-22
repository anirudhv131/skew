// api/markets.js  —  Vercel serverless function (Node 18+, global fetch)
// Pulls live markets from Kalshi + Polymarket, matches the same event, returns JSON.
// FIXED: stricter matching to prevent garbage pairs.

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

// Fetch from current Kalshi API v2 (api.kalshi.com, not deprecated trading-api)
async function getKalshi(debug){
  const url = "https://external-api.kalshi.com/trade-api/v2/markets?limit=1000&status=open";
  try{
    const r = await fetch(url, { headers:{accept:"application/json"} });
    if(!r.ok){ 
      debug.errors.push(`kalshi HTTP ${r.status}: ${r.statusText}`);
      debug.kalshiUrl = url;
      return []; 
    }
    const text = await r.text();
    const j = JSON.parse(text);
    const raw = (j.markets||[]);
    const now = new Date();
    debug.kalshiCount = raw.length;
    const out = raw.map(m=>{
      // Kalshi returns prices in dollars (0.00-1.00), convert to cents (0-100)
      const bid = m.yes_bid_dollars;
      const ask = m.yes_ask_dollars;
      let yes = (bid!=null && ask!=null && (bid+ask)>0) ? (bid+ask)/2 : null;
      if(yes!=null) yes = Math.round(yes * 100);
      
      const resolves = (m.close_time||m.expiration_time||"").slice(0,10);
      return yes==null ? null : { title:(m.title||m.ticker), yes, resolves };
    }).filter(Boolean);
    
    debug.kalshiSample = out.slice(0, 10).map(m => ({ t: m.title.slice(0,30), y: m.yes }));
    debug.kalshiTotal = out.length;
    const filtered = out.filter(m=>m.yes>2 && m.yes<98);
    debug.kalshiInRange = filtered.length;
    return filtered;
  }catch(e){ 
    debug.errors.push("kalshi "+String(e.message)); 
    return []; 
  }
}

async function getPolymarket(debug){
  const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=500";
  try{
    const r = await fetch(url, { headers:{accept:"application/json"} });
    if(!r.ok){ debug.errors.push("polymarket HTTP "+r.status); return []; }
    const arr = await r.json();
    const now = new Date();
    debug.polyCount = (arr||[]).length;
    return (arr||[]).map(m=>{
      let prices, outs;
      try{ prices=JSON.parse(m.outcomePrices||"[]"); outs=JSON.parse(m.outcomes||"[]"); }catch{ return null; }
      if(!Array.isArray(outs)||outs.length!==2) return null;
      if(!/yes/i.test(outs[0]) && !/yes/i.test(outs[1])) return null;
      const yi=/yes/i.test(outs[0])?0:1;
      const yes=Math.round(parseFloat(prices[yi])*100);
      const resolves = (m.endDate||"").slice(0,10);
      return isNaN(yes)?null:{ title:m.question, yes, resolves };
    }).filter(Boolean).filter(m=>m.yes>2 && m.yes<98);
  }catch(e){ debug.errors.push("polymarket "+String(e.message)); return []; }
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","s-maxage=20, stale-while-revalidate=40");
  const debug = { kalshiHost:null, kalshiAttempts:[], polyRaw:null, errors:[] };
  let kalshi=[], poly=[];
  try{ kalshi=await getKalshi(debug); }catch(e){ debug.errors.push("kalshi "+String(e.message)); }
  try{ poly=await getPolymarket(debug); }catch(e){ debug.errors.push("poly "+String(e.message)); }

  const THRESHOLD=0.65, pairs=[], used=new Set();
  for(const k of kalshi){
    let best=null, score=THRESHOLD;
    for(let i=0;i<poly.length;i++){ 
      if(used.has(i)) continue;
      
      // STRICT: only pair if same category
      const kCat = guessCat(k.title);
      const pCat = guessCat(poly[i].title);
      if(kCat !== pCat) continue;
      
      const s=similarity(k.title,poly[i].title); 
      if(s>score){score=s;best=i;} 
    }
    if(best!=null){ 
      used.add(best); 
      const p=poly[best];
      pairs.push({ 
        cat:guessCat(k.title+" "+p.title), 
        title:k.title.replace(/^will (the )?/i,"").replace(/\?$/,""), 
        resolves:k.resolves||p.resolves||"", 
        k:k.yes, 
        p:p.yes, 
        match:+score.toFixed(2) 
      });
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
