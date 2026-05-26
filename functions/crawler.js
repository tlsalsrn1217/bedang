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
let _token    = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const key = process.env.KIS_APP_KEY;
  const sec = process.env.KIS_APP_SECRET;
  if (!key || !sec) {
    throw new Error(
      'KIS_APP_KEY / KIS_APP_SECRET 미설정.\n' +
      '  → backend/.env 파일에 두 값을 추가하세요. (backend/.env.example 참고)'
    );
  }

  const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: sec }),
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패 HTTP ${res.status}: ${await res.text()}`);

  const d = await res.json();
  if (!d.access_token) throw new Error(`KIS 토큰 없음: ${JSON.stringify(d)}`);

  _token    = d.access_token;
  _tokenExp = Date.now() + ((d.expires_in ?? 86400) - 60) * 1000;
  return _token;
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
      tr_id:         'FHKST01010100', // 주식현재가 시세
      custtype:      'P',             // P = 개인
    },
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
    mcap: num(o.hts_avls), // 억원 단위
    crawledAt: new Date().toISOString(),
  };

  cache.set(code, { ts: Date.now(), data });
  return data;
}

// ── 다수 종목 순차 수집 (실패 시 1회 재시도) ─────────────────────
async function fetchMany(codes, delayMs = 350) {
  const out = [];
  for (const code of codes) {
    try {
      out.push(await fetchMetrics(code));
    } catch (e) {
      await sleep(1000);
      try {
        cache.delete(code); // 캐시 제거 후 재시도
        out.push(await fetchMetrics(code));
      } catch (e2) {
        out.push({ code, error: String(e2.message ?? e2) });
      }
    }
    await sleep(delayMs);
  }
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = { fetchMetrics, fetchMany, clearCache };
