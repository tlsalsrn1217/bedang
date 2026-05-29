/**
 * quality.js — 우량주 등급 (체질·안정성 평가)
 * ------------------------------------------------------------------
 * 세 축의 의미 정리:
 *   · 저평가 점수 (scoring.js) — 지금 싼가
 *   · 성장 등급 (growth.js)    — 꾸준히 좋아지는가
 *   · 우량주 등급 (이 모듈)    — 회사가 흔들리지 않는 체질인가
 *
 * 5지표 (사용자 결정 2026-05-29):
 *   1. ROE 절대 수준        30%  (자본 효율)
 *   2. 재무 건전성          20%  (부채비율·이자보상)
 *   3. 배당지속성           20%  (scoring.js durability + 삭감 이력)
 *   4. 시가총액 규모        15%  (변동성·거래 안전)
 *   5. 위험 신호 부재       15%  (flags + riskFlags 합산)
 *
 * 등급: S(88+) · A(75+) · B(60+) · C(40+) · D(40미만) · N/A(데이터 부족)
 *
 * 데이터 소스:
 *   · KIS finance/profit-ratio    (FHKST66430400) — ROE 다년치
 *   · KIS finance/stability-ratio (FHKST66430600) — 부채비율·이자보상
 *   · stock.mcap, stock.flags, stock.riskFlags(from growth) 활용
 */

const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// growth.js와 동일한 KIS 토큰 캐시 (인스턴스 내 공유)
const _kis = (() => {
  let _token = null, _exp = 0, _promise = null;
  async function getToken() {
    if (_token && Date.now() < _exp) return _token;
    if (!_promise) {
      _promise = (async () => {
        const key = process.env.KIS_APP_KEY;
        const sec = process.env.KIS_APP_SECRET;
        if (!key || !sec) throw new Error('KIS_APP_KEY/SECRET 미설정');
        const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: sec }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`KIS 토큰 HTTP ${res.status}`);
        const d = await res.json();
        _token = d.access_token;
        _exp   = Date.now() + ((d.expires_in ?? 86400) - 60) * 1000;
        return _token;
      })().finally(() => { _promise = null; });
    }
    return _promise;
  }
  return { getToken };
})();

function _num(x) {
  if (x == null) return null;
  const s = String(x).replace(/,/g, '').trim();
  if (!s || ['-', '#N/A', 'N/A'].includes(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function _kisFinanceGet(pathSuffix, trId, code) {
  const token = await _kis.getToken();
  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/finance/${pathSuffix}`);
  url.searchParams.set('FID_DIV_CLS_CODE',       '0'); // 연
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD',         code);
  const res = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey:    process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id:     trId,
      custtype:  'P',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KIS ${pathSuffix} ${code} HTTP ${res.status}`);
  const json = await res.json();
  if (json.rt_cd !== '0') throw new Error(`KIS ${pathSuffix} ${code}: ${json.msg1 || json.rt_cd}`);
  return Array.isArray(json.output) ? json.output : [];
}

// 수익성비율 — 최신 ROE
async function fetchProfitRatio(code) {
  const rows = await _kisFinanceGet('profit-ratio', 'FHKST66430400', code);
  return rows.map(r => ({
    yymm: r.stac_yymm || '',
    // KIS 키 후보: roe_val, ssjs_eqsr_ntin_inrt, prfi_inrt (코드 차이 대비 다중 시도)
    roe:  _num(r.roe_val) ?? _num(r.ssjs_eqsr_ntin_inrt) ?? _num(r.prfi_inrt) ?? _num(r.shrn_eqty_ntin_inrt),
    _rawKeys: Object.keys(r),
  }));
}

// 안정성비율 — 최신 부채비율 / 이자보상
async function fetchStabilityRatio(code) {
  const rows = await _kisFinanceGet('stability-ratio', 'FHKST66430600', code);
  return rows.map(r => ({
    yymm:    r.stac_yymm || '',
    debt:    _num(r.lblt_rate)     ?? _num(r.dbt_ratio)     ?? _num(r.lblt_ratio),     // 부채비율 (%)
    coverage:_num(r.crmm_int_bicvr) ?? _num(r.intrst_inrst) ?? _num(r.int_bicvr_rt),   // 이자보상비율 (배)
    _rawKeys: Object.keys(r),
  }));
}

/* ── 점수화 함수 ────────────────────────────────────────────── */
function _clamp01(v) { return Math.max(0, Math.min(100, v)); }

// ROE 점수 (%)
function scoreROE(roe) {
  if (roe == null) return null;
  if (roe >= 15) return 100;
  if (roe >= 10) return 80 + (roe - 10) * 4;       // 10→80, 15→100
  if (roe >=  8) return 60 + (roe -  8) * 10;      // 8→60, 10→80
  if (roe >=  5) return 40 + (roe -  5) * (20/3);  // 5→40, 8→60
  if (roe >=  0) return 20 + roe * 4;              // 0→20, 5→40
  return _clamp01(20 + roe * 4);                    // 음수 선형
}

// 부채비율 점수 (%, 낮을수록 좋음). 0~50%=100, 200%+→0
function scoreDebt(debt) {
  if (debt == null) return null;
  if (debt <= 50)  return 100;
  if (debt <= 100) return 80 + (50 - debt) * 0.4;    // 50→100, 100→80
  if (debt <= 150) return 60 + (100 - debt) * 0.4;   // 100→80, 150→60
  if (debt <= 200) return 40 + (150 - debt) * 0.4;   // 150→60, 200→40
  if (debt <= 300) return Math.max(0, 40 + (200 - debt) * 0.4); // 200→40, 300→0
  return 0;
}

// 이자보상비율 점수 (배, 높을수록 좋음). 10+→100, 1 미만→0
function scoreCoverage(cov) {
  if (cov == null) return null;
  if (cov >= 10) return 100;
  if (cov >=  5) return 80 + (cov - 5) * 4;       // 5→80, 10→100
  if (cov >=  3) return 60 + (cov - 3) * 10;      // 3→60, 5→80
  if (cov >=  1) return 30 + (cov - 1) * 15;      // 1→30, 3→60
  return Math.max(0, cov * 30);                    // 0→0, 1→30
}

// 시가총액 점수 (억). 10조+→100, 1000억 미만→점진 감점
function scoreMcap(mcap) {
  if (!Number.isFinite(mcap) || mcap <= 0) return null;
  const log = Math.log10(mcap);
  // 1000억(log=3)→20, 1조(log=4)→60, 10조(log=5)→100
  if (log >= 5) return 100;
  if (log >= 4) return 60 + (log - 4) * 40;
  if (log >= 3) return 20 + (log - 3) * 40;
  return Math.max(0, log * (20/3));
}

// 위험 신호 점수 (없을수록 좋음). flags(scoring) + riskFlags(growth) 합산
function scoreRisk(stock) {
  const totalFlags = (stock.flags?.length || 0) + (Array.isArray(stock.riskFlags) ? stock.riskFlags.length : 0);
  if (totalFlags === 0) return 100;
  if (totalFlags === 1) return 60;
  if (totalFlags === 2) return 30;
  return 0;
}

// 등급 매핑
function gradeFromScore(s) {
  if (s == null) return 'N/A';
  if (s >= 88) return 'S';
  if (s >= 75) return 'A';
  if (s >= 60) return 'B';
  if (s >= 40) return 'C';
  return 'D';
}

/* ── 통합 산출 ──────────────────────────────────────────────── */
function computeQualityGrade(stock, profitRows, stabilityRows) {
  const sortedP = [...(profitRows || [])].sort((a, b) => (a.yymm || '').localeCompare(b.yymm || ''));
  const sortedS = [...(stabilityRows || [])].sort((a, b) => (a.yymm || '').localeCompare(b.yymm || ''));
  const latestP = sortedP[sortedP.length - 1];
  const latestS = sortedS[sortedS.length - 1];

  // 1. ROE — KIS 수익성비율 우선, 없으면 stock.roe 폴백
  const roeVal  = latestP?.roe ?? _num(stock.roe);
  const roeS    = scoreROE(roeVal);
  // 2. 재무 건전성 — 부채비율 60% + 이자보상 40%
  const debtS   = scoreDebt(latestS?.debt);
  const covS    = scoreCoverage(latestS?.coverage);
  let stability = null;
  if (debtS != null && covS != null) stability = debtS * 0.6 + covS * 0.4;
  else if (debtS != null)            stability = debtS;
  else if (covS  != null)            stability = covS;
  // 3. 배당지속성 — scoring.js의 durability 점수 그대로
  const durS    = _num(stock.breakdown?.durability);
  // 4. 시가총액
  const mcapS   = scoreMcap(_num(stock.mcap));
  // 5. 위험 신호 (저평가 flags + 가치 함정 riskFlags)
  const riskS   = scoreRisk(stock);

  const parts = [
    { key: 'roe',         w: 0.30, score: roeS },
    { key: 'stability',   w: 0.20, score: stability },
    { key: 'durability',  w: 0.20, score: durS },
    { key: 'mcap',        w: 0.15, score: mcapS },
    { key: 'risk',        w: 0.15, score: riskS },
  ];
  const valid = parts.filter(p => p.score != null);
  if (valid.length === 0) {
    return { grade: 'N/A', score: null, confidence: 'none', breakdown: null };
  }
  const totalW = valid.reduce((s, p) => s + p.w, 0);
  const score  = valid.reduce((s, p) => s + (p.w / totalW) * p.score, 0);

  let confidence = 'low';
  if (valid.length === 5) confidence = 'high';
  else if (valid.length >= 4) confidence = 'mid';

  return {
    grade:       gradeFromScore(score),
    score:       +score.toFixed(1),
    confidence,
    breakdown: {
      roe:        { value: roeVal, score: roeS != null ? +roeS.toFixed(1) : null },
      stability:  {
        debtRatio: latestS?.debt ?? null,
        intCoverage: latestS?.coverage ?? null,
        score: stability != null ? +stability.toFixed(1) : null,
      },
      durability: { score: durS != null ? +durS.toFixed(1) : null },
      mcap:       { value: _num(stock.mcap), score: mcapS != null ? +mcapS.toFixed(1) : null },
      risk:       { totalFlags: (stock.flags?.length || 0) + (stock.riskFlags?.length || 0), score: riskS },
    },
  };
}

/* ── 다종목 일괄 산출 (growth.js 호출 직후 사용) ──────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAndGradeManyQuality(stocks, growthResults, concurrency = 5) {
  const out   = {};
  const queue = stocks.filter(s => s.code).map(s => s);
  let firstKeysLogged = false;
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      // growth 결과를 stock에 반영해 riskFlags를 함께 평가
      const enriched = {
        ...s,
        riskFlags: growthResults?.[s.code]?.riskFlags || [],
      };
      let profitRows = [], stabilityRows = [];
      try { profitRows = await fetchProfitRatio(s.code); }
      catch (e) { await sleep(200); try { profitRows = await fetchProfitRatio(s.code); } catch (_) {} }
      try { stabilityRows = await fetchStabilityRatio(s.code); }
      catch (e) { await sleep(200); try { stabilityRows = await fetchStabilityRatio(s.code); } catch (_) {} }
      if (!firstKeysLogged) {
        if (profitRows[0])    console.log('[quality] profit keys:',    profitRows[0]._rawKeys.slice(0, 30).join(','));
        if (stabilityRows[0]) console.log('[quality] stability keys:', stabilityRows[0]._rawKeys.slice(0, 30).join(','));
        firstKeysLogged = true;
      }
      out[s.code] = computeQualityGrade(enriched, profitRows, stabilityRows);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

module.exports = { computeQualityGrade, fetchAndGradeManyQuality, gradeFromScore };
