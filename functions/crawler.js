/**
 * crawler.js — KIS Developers (한국투자증권) 무료 REST API 기반 재무지표 수집
 * ------------------------------------------------------------------
 * 기존 네이버 크롤러를 공식 API로 교체. fetchMetrics() 시그니처 유지.
 *
 * 사전 준비:
 *   1. https://apiportal.koreainvestment.com 에서 무료 회원가입 + 앱 등록
 *   2. 발급받은 APP_KEY / APP_SECRET 을 backend/.env 에 기입
 *      KIS_APP_KEY=발급받은키
 *      KIS_APP_SECRET=발급받은시크릿
 *
 * 수집 지표 (엔드포인트: GET /uapi/domestic-stock/v1/quotations/inquire-price)
 *   price   stck_prpr  주식현재가
 *   per     per        PER
 *   pbr     pbr        PBR
 *   roe                EPS ÷ BPS × 100 으로 계산 (별도 필드 없음)
 *   mcap    hts_avls   HTS 시가총액 (억원)
 *
 * divYield: server.js refresh에서 prevDps/price 로 재계산 → 최신 주가 반영.
 * payout/prevDps/avgDps: seed 원본 유지 (연 1회 수동 갱신 권장).
 *
 * ⚠️ 주의:
 *  - 무료 계좌(모의투자 앱)는 초당 20건 / 일 10만건 제한. delayMs=350 유지.
 *  - 실전투자 앱 등록 시 제한 완화 가능 (포털에서 별도 신청).
 */

const CACHE_TTL = 1000 * 60 * 30; // 30분 캐시
const cache     = new Map();       // code → { ts, data }
const sleep     = ms => new Promise(r => setTimeout(r, ms));

const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// ── 토큰 관리 (24시간 유효, 만료 60초 전 자동 갱신) ──────────────
let _token        = null;
let _tokenExp     = 0;
let _tokenPromise = null; // 동시 토큰 갱신 방지

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_tokenPromise) {
    _tokenPromise = (async () => {
      const key = process.env.KIS_APP_KEY;
      const sec = process.env.KIS_APP_SECRET;
      if (!key || !sec) throw new Error('KIS_APP_KEY / KIS_APP_SECRET 미설정');
      const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: sec }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`KIS 토큰 발급 실패 HTTP ${res.status}`);
      const d = await res.json();
      if (!d.access_token) throw new Error(`KIS 토큰 없음: ${JSON.stringify(d)}`);
      _token    = d.access_token;
      _tokenExp = Date.now() + ((d.expires_in ?? 86400) - 60) * 1000;
      return _token;
    })().finally(() => { _tokenPromise = null; });
  }
  return _tokenPromise;
}

// ── 단일 종목 지표 수집 ───────────────────────────────────────────
async function fetchMetrics(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const token = await getToken();
  const key   = process.env.KIS_APP_KEY;
  const sec   = process.env.KIS_APP_SECRET;

  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J'); // J = 주식/ETF
  url.searchParams.set('FID_INPUT_ISCD', code);

  const res = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey:        key,
      appsecret:     sec,
      tr_id:         'FHKST01010100',
      custtype:      'P',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`KIS ${code} HTTP ${res.status}`);

  const json = await res.json();
  if (json.rt_cd !== '0') {
    throw new Error(`KIS ${code}: ${json.msg1 ?? `rt_cd=${json.rt_cd}`}`);
  }

  const o   = json.output;
  const num = s => {
    const n = parseFloat(String(s ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n !== 0 ? n : null;
  };

  const price = num(o.stck_prpr);
  const eps   = num(o.eps);
  const bps   = num(o.bps);
  // KIS inquire-price 응답에 ROE 직접 필드 없음 → EPS/BPS × 100 으로 근사
  const roe   = (eps != null && bps != null && bps > 0)
    ? Math.round((eps / bps) * 10000) / 100
    : null;

  const data = {
    code,
    name: o.hts_kor_isnm?.trim() || null,
    price,
    per:  num(o.per),
    pbr:  num(o.pbr),
    roe,
    mcap: num(o.hts_avls),
    prdy_vrss:      parseFloat(o.prdy_vrss  || '0') || 0,  // 전일 대비 (원)
    prdy_vrss_sign: o.prdy_vrss_sign || '3',                // 1:상한 2:상승 3:보합 4:하한 5:하락
    prdy_ctrt:      parseFloat(o.prdy_ctrt  || '0') || 0,  // 등락률 (%)
    crawledAt: new Date().toISOString(),
  };

  cache.set(code, { ts: Date.now(), data });
  return data;
}

// ── 다수 종목 병렬 수집 (KIS 무료 20req/s 한도 내 concurrency=5) ──
async function fetchMany(codes, concurrency = 5) {
  const out   = new Array(codes.length);
  const queue = codes.map((code, i) => ({ code, i }));
  async function worker() {
    while (queue.length) {
      const { code, i } = queue.shift();
      try {
        out[i] = await fetchMetrics(code);
      } catch (e) {
        await sleep(400);
        try { cache.delete(code); out[i] = await fetchMetrics(code); }
        catch (e2) { out[i] = { code, error: String(e2.message ?? e2) }; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, codes.length) }, worker));
  return out;
}

function clearCache() {
  cache.clear();
}

// ── 기간별 주가 차트 데이터 수집 ─────────────────────────────────────
// periodCode: D(일) / W(주) / M(월) / Y(연)
// from/to: 'YYYYMMDD' 문자열
async function fetchChartPage(code, periodCode, from, to) {
  const token = await getToken();
  const key   = process.env.KIS_APP_KEY;
  const sec   = process.env.KIS_APP_SECRET;

  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD',         code);
  url.searchParams.set('FID_INPUT_DATE_1',        from);
  url.searchParams.set('FID_INPUT_DATE_2',        to);
  url.searchParams.set('FID_PERIOD_DIV_CODE',     periodCode);
  url.searchParams.set('FID_ORG_ADJ_PRC',         '0'); // 수정주가

  const res = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey:   key,
      appsecret: sec,
      tr_id:    'FHKST03010100',
      custtype: 'P',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KIS chart ${code} HTTP ${res.status}`);
  const json = await res.json();
  if (json.rt_cd !== '0') throw new Error(`KIS chart ${code}: ${json.msg1}`);

  // output2 = 기간별 배열 (날짜 내림차순)
  return (json.output2 || []).map(r => ({
    date:  r.stck_bsop_date, // 'YYYYMMDD'
    close: parseFloat(r.stck_clpr) || 0,
    open:  parseFloat(r.stck_oprc) || 0,
    high:  parseFloat(r.stck_hgpr) || 0,
    low:   parseFloat(r.stck_lwpr) || 0,
  })).filter(r => r.close > 0);
}

// 긴 기간 페이징: dateRange를 chunkMonths 단위로 분할해 이어붙임
function splitDateRange(fromDate, toDate, chunkMonths) {
  const chunks = [];
  let cursor = new Date(toDate);
  const end  = new Date(toDate);
  const start = new Date(fromDate);
  while (cursor > start) {
    const chunkFrom = new Date(cursor);
    chunkFrom.setMonth(chunkFrom.getMonth() - chunkMonths);
    if (chunkFrom < start) chunkFrom.setTime(start.getTime());
    chunks.push({
      from: chunkFrom.toISOString().slice(0,10).replace(/-/g,''),
      to:   cursor.toISOString().slice(0,10).replace(/-/g,''),
    });
    cursor = new Date(chunkFrom);
    cursor.setDate(cursor.getDate() - 1);
  }
  return chunks;
}

async function fetchChart(code, preset) {
  // preset: '1D' | '1W' | '1M' | '1Y' | '5Y' | 'ALL'
  const today = new Date();
  const fmt   = d => d.toISOString().slice(0,10).replace(/-/g,'');
  const ago   = (years=0, months=0, days=0) => {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - years);
    d.setMonth(d.getMonth() - months);
    d.setDate(d.getDate() - days);
    return d;
  };

  // 프리셋별 설정
  const cfg = {
    '3M': { period: 'D', from: ago(0,3),  chunkM: null },  // 일봉 3개월 (~63건)
    '1Y': { period: 'W', from: ago(1),    chunkM: null },  // 주봉 1년 (~52건)
    '3Y': { period: 'M', from: ago(3),    chunkM: null },  // 월봉 3년 (~36건)
    '5Y': { period: 'M', from: ago(5),    chunkM: null },  // 월봉 5년 (~60건)
    '10Y':{ period: 'M', from: ago(10),   chunkM: 60   },  // 월봉 10년 → 2페이지
    'ALL':{ period: 'Y', from: ago(30),   chunkM: null },  // 연봉 30년 (~30건)
  }[preset] || { period: 'D', from: ago(0,3), chunkM: null };

  const fromStr = fmt(cfg.from);
  const toStr   = fmt(today);

  let rows = [];
  if (!cfg.chunkM) {
    // 단일 호출
    rows = await fetchChartPage(code, cfg.period, fromStr, toStr);
  } else {
    // 페이징: 날짜 구간 분할
    const chunks = splitDateRange(fromStr, toStr, cfg.chunkM);
    for (const chunk of chunks) {
      await sleep(200); // KIS 호출 간격
      const part = await fetchChartPage(code, cfg.period, chunk.from, chunk.to);
      rows = rows.concat(part);
    }
    // 중복 제거 + 오름차순 정렬
    const seen = new Set();
    rows = rows.filter(r => seen.has(r.date) ? false : seen.add(r.date));
  }

  // 오름차순(과거→최근) 정렬
  rows.sort((a,b) => a.date.localeCompare(b.date));
  return rows;
}

module.exports = { fetchMetrics, fetchMany, clearCache, fetchChart };
