/**
 * server.js — Express API 서버 (Firebase Cloud Functions)
 * 저장소: Firestore (db.js) — 유저별 userData/{uid}/ 분리
 */

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { getFirestore } = require('firebase-admin/firestore');
const { scoreStocks, DEFAULT_CONFIG } = require('./scoring');
const { fetchMetrics, fetchMany, clearCache } = require('./crawler');
const { explainStock, parseExplainRaw, recommendConfig, classifyAndCheck } = require('./llm');
const { analyzeQualitative } = require('./qualitative');
const { load, save, loadQualitative, saveQualitative, loadAllQualitative } = require('./db');

// ── JWT 유틸 (외부 패키지 없이 순수 crypto) ──────────────────────

const JWT_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const BASE_URL   = process.env.BASE_URL        || 'https://bedang-f7f92.web.app';
const NAVER_CB   = `${BASE_URL}/auth/naver/callback`;
const TOKEN_TTL  = 30 * 24 * 3600; // 30일 (초)

function jwtSign(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  })).toString('base64url');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

function jwtVerify(token) {
  try {
    const [h, b, s] = (token || '').split('.');
    if (!h || !b || !s) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (s.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function makeState() {
  const r = crypto.randomBytes(16).toString('hex');
  const s = crypto.createHmac('sha256', JWT_SECRET).update(r).digest('hex').slice(0, 16);
  return `${r}${s}`;
}
function checkState(state) {
  if (!state || state.length !== 48) return false;
  const r = state.slice(0, 32);
  const s = state.slice(32);
  return s === crypto.createHmac('sha256', JWT_SECRET).update(r).digest('hex').slice(0, 16);
}

// Authorization: Bearer <token> 에서 uid 추출
function getUid(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const payload = jwtVerify(auth.slice(7));
  return payload?.uid || null;
}

// 인스턴스 내 중복 시드 방지 (Firestore 읽기 절약)
const seededUsers = new Set();

async function seedUserIfEmpty(uid) {
  if (seededUsers.has(uid)) return;
  const userData = await load(uid);
  if (userData.stocks.length === 0) {
    const seed = require('./seed.json');
    await save({
      stocks:      seed,
      settings:    { sectorMultipliers: {} },
      lastRefresh: null,
      holdings:    [],
    }, uid);
  }
  seededUsers.add(uid);
}

// ── 앱 ────────────────────────────────────────────────────────────

function calcGrade(score, flags) {
  if (score >= 65 && (!flags || flags.length === 0)) return 'A';
  if (score >= 45) return 'B';
  return 'C';
}
function applyGrades(stocks) {
  return stocks.map(s => ({ ...s, grade: calcGrade(s.score, s.flags) }));
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Cold start 초기화 — appData(공용) 시드 (non-blocking: 요청을 블로킹하지 않음)
async function initDB() {
  const db = await load();
  if (!db.stocks.length) {
    const seed = require('./seed.json');
    await save({
      stocks: seed, settings: { sectorMultipliers: {} },
      lastRefresh: null, holdings: [],
    });
  } else {
    const seedList = require('./seed.json');
    const seedMap  = Object.fromEntries(seedList.map(s => [s.name, s]));
    let changed    = false;
    const updated  = db.stocks.map(s => {
      const g = seedMap[s.name];
      if (g && (s.sector !== g.sector || s.industry !== g.industry ||
          s.isHolding !== g.isHolding || s.category !== g.category)) {
        changed = true;
        return { ...s, sector: g.sector, industry: g.industry, isHolding: g.isHolding, category: g.category };
      }
      return s;
    });
    if (changed) await save({ stocks: updated });
  }
}

// 요청을 블로킹하지 않고 백그라운드에서 appData 시드
initDB().catch(e => console.error('[server] initDB error:', e));

// async route 에러를 next(err)로 전달 → 전역 에러 핸들러가 처리
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ── 유틸 ──────────────────────────────────────────────────────────

function isMarketOpen() {
  const kst  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day  = kst.getDay();
  if (day === 0 || day === 6) return false;
  const mins = kst.getHours() * 60 + kst.getMinutes();
  return mins >= 540 && mins < 930;
}

// ── 주식 API ──────────────────────────────────────────────────────

app.get('/api/stocks', wrap(async (req, res) => {
  const uid = getUid(req);
  if (uid) await seedUserIfEmpty(uid);
  const db     = await load(uid);
  const scored = applyGrades(scoreStocks(db.stocks, db.settings));
  res.json({ stocks: scored, lastRefresh: db.lastRefresh, marketOpen: isMarketOpen() });
}));

app.get('/api/search-stock', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ results: [] });

  if (/^\d{6}$/.test(q)) {
    try {
      const data = await fetchMetrics(q);
      if (data && data.name) return res.json({ results: [{ name: data.name, code: q }] });
    } catch (_) {}
    return res.json({ results: [] });
  }

  try {
    const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=index,stock,marketindex`;
    const r   = await fetch(url, {
      signal:  AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://m.stock.naver.com/',
        'Accept':     'application/json',
      },
    });
    if (!r.ok) return res.json({ results: [], error: `Naver HTTP ${r.status}` });
    const json    = await r.json();
    const ETF_RE  = /^(KODEX|TIGER|KINDEX|ARIRANG|SOL|KOSEF|ACE|PLUS|HANARO|RISE|TIMEFOLIO|WOORI|KTOP|FOCUS|MAAX|KBSTAR|SMART|iShares)\s/i;
    const items   = (json.items || [])
      .filter(i => i.code && /^\d{6}$/.test(i.code) && i.category !== 'index')
      .map(i => ({ name: i.name, code: i.code, isEtf: ETF_RE.test(i.name) }));
    res.json({ results: items.slice(0, 8) });
  } catch (e) {
    res.json({ results: [], error: String(e.message) });
  }
}));

app.post('/api/stocks', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const { name, code, category } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name, code 필수' });
  const db = await load(uid);
  if (db.stocks.some(s => s.name === name || s.code === code))
    return res.status(409).json({ error: '이미 존재하는 종목입니다' });
  try {
    clearCache();
    const data = await fetchMetrics(code);
    db.stocks.push({ name, code, category: category || '기타',
      price: data.price, per: data.per, pbr: data.pbr, roe: data.roe, mcap: data.mcap });
    await save({ stocks: db.stocks }, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: `KIS 검증 실패: ${e.message}` });
  }
}));

app.post('/api/classify-stock', wrap(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name 필수' });
  const uid        = getUid(req);
  const db         = await load(uid);
  const categories = [...new Set(db.stocks.map(s => s.category))].filter(Boolean).sort();
  try {
    const result = await classifyAndCheck(name, categories);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

app.put('/api/stocks/:code/manual', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db  = await load(uid);
  const key = decodeURIComponent(req.params.code);
  const idx = db.stocks.findIndex(s => s.code === key || s.name === key);
  if (idx === -1) return res.status(404).json({ error: '종목 없음' });
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields 필수' });
  const at           = new Date().toISOString();
  const manualFields = db.stocks[idx].manualFields || {};
  for (const [field, value] of Object.entries(fields)) {
    const parsed = parseFloat(String(value).replace(/,/g, ''));
    if (!isNaN(parsed)) {
      db.stocks[idx][field]  = parsed;
      manualFields[field]    = { at };
    }
  }
  db.stocks[idx].manualFields = manualFields;
  await save({ stocks: db.stocks }, uid);
  res.json({ ok: true });
}));

app.delete('/api/stocks/:code', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db  = await load(uid);
  const key = decodeURIComponent(req.params.code);
  db.stocks = db.stocks.filter(s => s.code !== key && s.name !== key);
  await save({ stocks: db.stocks }, uid);
  res.json({ ok: true });
}));

function mergeKIS(s, f) {
  const newPrice    = f.price;
  const newDivYield = (s.prevDps && newPrice && newPrice > 0) ? s.prevDps / newPrice : s.divYield;
  return { ...s, price: newPrice, per: f.per ?? s.per, pbr: f.pbr ?? s.pbr,
    roe: f.roe ?? s.roe, mcap: f.mcap ?? s.mcap, divYield: newDivYield };
}

app.post('/api/refresh', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db = await load(uid);
  clearCache();
  const withCodes = db.stocks.filter(s => s.code);
  try {
    const fresh  = await fetchMany(withCodes.map(s => s.code));
    const byCode = Object.fromEntries(fresh.filter(f => !f.error).map(f => [f.code, f]));
    db.stocks    = db.stocks.map(s => (!s.code || !byCode[s.code]) ? s : mergeKIS(s, byCode[s.code]));
    db.lastRefresh = new Date().toISOString();
    await save({ stocks: db.stocks, lastRefresh: db.lastRefresh }, uid);
    res.json({ ok: true, updated: Object.keys(byCode).length, lastRefresh: db.lastRefresh });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}));

app.get('/api/explain/:code', wrap(async (req, res) => {
  const uid    = getUid(req);
  const db     = await load(uid);
  const key    = decodeURIComponent(req.params.code);
  const scored = scoreStocks(db.stocks, db.settings);
  const stock  = scored.find(s => s.code === key || s.name === key);
  if (!stock) return res.json({ explanation: null, at: null });
  const cached = db.explanations?.[stock.name];
  if (!cached)  return res.json({ explanation: null, at: null });
  const explanation = cached.result ?? (cached.text ? parseExplainRaw(cached.text) : null);
  res.json({ explanation, at: cached.at, score: cached.score });
}));

app.post('/api/explain/:code', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db     = await load(uid);
  const key    = decodeURIComponent(req.params.code);
  const scored = scoreStocks(db.stocks, db.settings);
  const stock  = scored.find(s => s.code === key || s.name === key);
  if (!stock) return res.status(404).json({ error: '종목 없음' });
  try {
    const result = await explainStock(stock);
    const at     = new Date().toISOString();
    await save({ explanations: { [stock.name]: { result, at, score: stock.score } } }, uid);
    res.json({ explanation: result, at });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}));

// ── 정성 분석 레이어 (점수와 분리, 모달에서만 사용) ─────────────
// 일괄 조회 — 랭킹 표 아이콘용. premiumTag != 'none'인 항목만.
app.get('/api/qualitative', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.json({ tags: {} });
  const tags = await loadAllQualitative(uid);
  res.json({ tags });
}));

app.get('/api/qualitative/:code', wrap(async (req, res) => {
  const uid    = getUid(req);
  const db     = await load(uid);
  const key    = decodeURIComponent(req.params.code);
  const stock  = db.stocks.find(s => s.code === key || s.name === key);
  if (!stock) return res.json({ qualitative: null, at: null });
  const cached = await loadQualitative(uid, stock.name);
  if (!cached) return res.json({ qualitative: null, at: null });
  res.json({ qualitative: cached.result, at: cached.at, score: cached.score });
}));

app.post('/api/qualitative/:code', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db     = await load(uid);
  const key    = decodeURIComponent(req.params.code);
  const scored = scoreStocks(db.stocks, db.settings);
  const stock  = scored.find(s => s.code === key || s.name === key);
  if (!stock) return res.status(404).json({ error: '종목 없음' });
  try {
    const result = await analyzeQualitative(stock);
    const at     = new Date().toISOString();
    await saveQualitative(uid, stock.name, { result, at, score: stock.score });
    res.json({ qualitative: result, at });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}));

app.get('/api/config/default', (req, res) => res.json(DEFAULT_CONFIG));

app.post('/api/recommend-config', wrap(async (req, res) => {
  const uid        = getUid(req);
  const db         = await load(uid);
  const current    = { ...DEFAULT_CONFIG, ...(db.settings || {}) };
  const categories = [...new Set(db.stocks.map(s => s.category))];
  try {
    const rec = await recommendConfig(current, categories);
    res.json(rec);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}));

app.get('/api/holdings', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db = await load(uid);
  res.json({ holdings: db.holdings || [] });
}));

app.put('/api/holdings', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const holdings = req.body.holdings || [];
  await save({ holdings }, uid);
  res.json({ ok: true });
}));

app.get('/api/settings', wrap(async (req, res) => {
  const uid = getUid(req);
  const db  = await load(uid);
  res.json(db.settings);
}));

app.put('/api/settings', wrap(async (req, res) => {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ error: '로그인이 필요합니다', needLogin: true });
  const db       = await load(uid);
  const settings = { ...db.settings, ...req.body };
  await save({ settings }, uid);
  res.json({ ok: true, settings });
}));

// ── 뉴스 ──────────────────────────────────────────────────────────

const SOURCE_RANK = {
  '연합뉴스':0,'뉴시스':0,'연합인포맥스':0,
  '한국경제':1,'매일경제':1,'조선비즈':1,'헤럴드경제':1,'서울경제':1,
  '이데일리':2,'머니투데이':2,'아시아경제':2,'파이낸셜뉴스':2,'데일리안':2,
  'KBS':1,'MBC':1,'SBS':1,'YTN':1,
};
function sourceScore(src) {
  if (!src) return 9;
  for (const [key, rank] of Object.entries(SOURCE_RANK)) {
    if (src.includes(key)) return rank;
  }
  return 5;
}
const DOMAIN_SOURCE = {
  'hankyung.com':'한국경제','mk.co.kr':'매일경제','chosun.com':'조선비즈',
  'yna.co.kr':'연합뉴스','yonhapnews.co.kr':'연합뉴스','newsis.com':'뉴시스',
  'infomax.co.kr':'연합인포맥스','heraldcorp.com':'헤럴드경제','sedaily.com':'서울경제',
  'edaily.co.kr':'이데일리','mt.co.kr':'머니투데이','asiae.co.kr':'아시아경제',
  'fnnews.com':'파이낸셜뉴스','dailian.co.kr':'데일리안',
  'kbs.co.kr':'KBS','mbc.co.kr':'MBC','sbs.co.kr':'SBS','ytn.co.kr':'YTN',
};
function domainToSource(url) {
  try { return DOMAIN_SOURCE[new URL(url).hostname.replace(/^www\./, '')] || ''; }
  catch (_) { return ''; }
}
async function fetchNaverItems(stockName, clientId, clientSecret) {
  const q   = encodeURIComponent(`${stockName} 주식`);
  const url = `https://openapi.naver.com/v1/search/news.json?query=${q}&display=10&sort=date`;
  const r   = await fetch(url, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Naver HTTP ${r.status}`);
  const data = await r.json();
  return (data.items || []).map(item => {
    const title = item.title
      .replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
      .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").trim();
    const link = item.originallink || item.link;
    return { title, link, pubDate: item.pubDate, source: domainToSource(link), via: 'naver',
      ts: item.pubDate ? new Date(item.pubDate).getTime() : 0 };
  });
}

app.get('/api/news/:code', wrap(async (req, res) => {
  const uid   = getUid(req);
  const db    = await load(uid);
  const key   = decodeURIComponent(req.params.code);
  const stock = db.stocks.find(s => s.code === key || s.name === key);
  if (!stock) return res.status(404).json({ error: '종목 없음' });
  try {
    const q           = encodeURIComponent(`${stock.name} 주식`);
    const googleItems = [];
    try {
      const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const xml = await r.text();
        const re  = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = re.exec(xml)) !== null && googleItems.length < 15) {
          const t   = m[1];
          const get = tag => {
            const x = t.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
            return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
          };
          const linkM  = t.match(/<link[^/]?\/?>\s*(https?:\/\/[^\s<]+)/);
          const link   = linkM ? linkM[1].trim() : get('guid');
          const title  = get('title');
          const pubDate = get('pubDate');
          if (title && link) googleItems.push({ title, link, pubDate,
            source: get('source'), via: 'google', ts: pubDate ? new Date(pubDate).getTime() : 0 });
        }
      }
    } catch (_) {}

    let naverItems = [];
    const naverId     = process.env.NAVER_CLIENT_ID;
    const naverSecret = process.env.NAVER_CLIENT_SECRET;
    if (naverId && naverSecret) {
      try { naverItems = await fetchNaverItems(stock.name, naverId, naverSecret); } catch (_) {}
    }

    const normalize = s => s.toLowerCase().replace(/\s+/g,'').replace(/[^\w가-힣]/g,'');
    const seen      = new Set(naverItems.map(i => normalize(i.title)));
    const merged    = [...naverItems];
    for (const item of googleItems) {
      const n = normalize(item.title);
      if (!seen.has(n)) { seen.add(n); merged.push(item); }
    }

    const today    = Date.now();
    const oneDayMs = 86400000;
    merged.sort((a, b) => {
      const aToday = (today - a.ts) < oneDayMs ? 0 : 1;
      const bToday = (today - b.ts) < oneDayMs ? 0 : 1;
      if (aToday !== bToday) return aToday - bToday;
      const sA = sourceScore(a.source), sB = sourceScore(b.source);
      if (sA !== sB) return sA - sB;
      return b.ts - a.ts;
    });

    res.json({ news: merged.slice(0, 8).map(({ ts, ...n }) => n), stock: stock.name });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
}));

// ── 네이버 OAuth + JWT ────────────────────────────────────────────

app.get('/auth/naver', (req, res) => {
  if (!process.env.NAVER_CLIENT_ID) return res.status(500).send('NAVER_CLIENT_ID 미설정');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.NAVER_CLIENT_ID,
    redirect_uri:  NAVER_CB,
    state:         makeState(),
  });
  res.redirect(`https://nid.naver.com/oauth2.0/authorize?${params}`);
});

app.get('/auth/naver/callback', wrap(async (req, res) => {
  const { code, state } = req.query;
  if (!checkState(state)) return res.redirect('/?autherror=invalid_state');
  try {
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code', client_id: process.env.NAVER_CLIENT_ID,
      client_secret: process.env.NAVER_CLIENT_SECRET, code, state,
    });
    const td = await (await fetch(`https://nid.naver.com/oauth2.0/token?${tokenParams}`)).json();
    if (td.error) throw new Error(td.error_description);

    const md = await (await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${td.access_token}` },
    })).json();
    const p   = md.response;
    const uid = `naver_${p.id}`;

    await getFirestore().doc(`users/${uid}`).set({
      uid, name: p.name || p.nickname || '사용자',
      email: p.email || null, profileImage: p.profile_image || null,
      provider: 'naver', updatedAt: new Date().toISOString(),
    }, { merge: true });

    const token = jwtSign({ uid, name: p.name || p.nickname, email: p.email || null });
    res.redirect(`/?_tk=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error('Naver auth error:', e.message);
    res.redirect('/?autherror=1');
  }
}));

app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.json({ user: null });
  const user = jwtVerify(auth.slice(7));
  res.json({ user: user ? { uid: user.uid, name: user.name, email: user.email } : null });
});

// 전역 에러 핸들러 — async 라우트에서 next(err)로 전달된 에러 처리
app.use((err, req, res, next) => {
  console.error('[server] route error:', err.message || err);
  if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
});

module.exports = app;
