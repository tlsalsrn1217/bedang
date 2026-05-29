/**
 * growth.js — 성장 등급 (저평가 + 성장 분리 평가용)
 * ------------------------------------------------------------------
 * 종합점수(scoring.js) 공식·가중치는 절대 건드리지 않는다.
 * "지금 싼가"(종합점수) vs "꾸준히 좋아지고 있나"(성장 등급)를 두 축으로 분리.
 *
 * 데이터 소스: KIS finance/income-statement (tr_id: FHKST66430200)
 *   - 다년치 매출액·영업이익·당기순이익을 한 번에 반환 (연간, fid_div_cls_code=0)
 *   - EPS 미제공 → 당기순이익 3년 CAGR로 대체 (사용자 결정 2026-05-29)
 *   - DPS 다년치 미제공 → prevDps/avgDps 비율로 단순화 (confidence='low' 별도 표기)
 *
 * 점수 설계 (요구사항 그대로):
 *   가중치: 순이익(EPS 대체) 50% + 배당 증액(단순화) 30% + 매출 20%
 *   각 지표 0~100 점수화 → 가중합 → 등급(A+/A/B+/B/C/D)
 *
 * 결측 처리:
 *   - 3년 데이터 없으면 가능한 지표만 가중 정규화 + confidence='low'
 *   - 1년치도 없으면 grade='N/A'
 */

const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// crawler.js의 getToken을 재사용 (토큰 락 공유)
const { _kis } = (() => {
  // crawler.js는 getToken을 직접 export하지 않으므로 자체 토큰 캐시 사용
  let _token = null, _exp = 0, _promise = null;
  async function getToken() {
    if (_token && Date.now() < _exp) return _token;
    if (!_promise) {
      _promise = (async () => {
        const key = process.env.KIS_APP_KEY;
        const sec = process.env.KIS_APP_SECRET;
        if (!key || !sec) throw new Error('KIS_APP_KEY / KIS_APP_SECRET 미설정');
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
  return { _kis: { getToken } };
})();

function _num(x) {
  if (x == null) return null;
  const s = String(x).replace(/,/g, '').trim();
  if (!s || ['-', '#N/A', 'N/A'].includes(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/* ── (1) KIS 손익계산서 호출 ─────────────────────────────────── */
async function fetchIncomeStatement(code) {
  const token = await _kis.getToken();
  const url = new URL(`${BASE_URL}/uapi/domestic-stock/v1/finance/income-statement`);
  url.searchParams.set('FID_DIV_CLS_CODE',       '0'); // 0=연, 1=분기
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD',         code);

  const res = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey:    process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id:     'FHKST66430200',
      custtype:  'P',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KIS income ${code} HTTP ${res.status}`);
  const json = await res.json();
  if (json.rt_cd !== '0') throw new Error(`KIS income ${code}: ${json.msg1 || json.rt_cd}`);

  const rows = Array.isArray(json.output) ? json.output : [];
  // 응답 필드명은 시기별 변동 가능 — 다중 키 후보를 시도해 정규화
  // 첫 호출 시 진단을 위해 keys를 한 번 로그 (server.js에서)
  return rows.map(r => ({
    yymm:      r.stac_yymm || '',
    sales:     _num(r.sale_account)        ?? _num(r.sale_amt)        ?? _num(r.sales),
    operating: _num(r.bsop_prti)           ?? _num(r.bsop_prfi)       ?? _num(r.op_prfi),
    netIncome: _num(r.thtr_ntin)           ?? _num(r.net_income)      ?? _num(r.curtm_ntin),
    _rawKeys:  Object.keys(r), // 진단용 (caller에서 필요 시 확인)
  }));
}

/* ── (2) 지표 계산·점수화 ──────────────────────────────────── */
function calcCAGR(latest, earliest, years) {
  if (!Number.isFinite(latest) || !Number.isFinite(earliest)) return null;
  if (latest <= 0 || earliest <= 0) return null;
  if (!years || years <= 0) return null;
  return Math.pow(latest / earliest, 1 / years) - 1;
}

// CAGR (소수) → 0~100 점수: ≥15% → 100, 10% → 80, 5% → 60, 0% → 40, 음수 선형 → 0
function scoreCAGR(cagr) {
  if (cagr == null || !Number.isFinite(cagr)) return null;
  const p = cagr * 100;
  if (p >= 15) return 100;
  if (p >= 10) return 80 + (p - 10) * 4;          // 10→80, 15→100
  if (p >=  5) return 60 + (p -  5) * 4;          // 5→60, 10→80
  if (p >=  0) return 40 + p * 4;                  // 0→40, 5→60
  if (p >= -10) return Math.max(0, 40 + p * 4);    // -10→0, 0→40
  return 0;
}

// 배당 증액 — prevDps/avgDps 비율 기반 단순 점수 (5년 시계열 미사용 보강책)
function scoreDividendRatio(prevDps, avgDps) {
  if (!Number.isFinite(prevDps) || !Number.isFinite(avgDps) || avgDps <= 0) return null;
  const r = prevDps / avgDps;
  if (r >= 1.20) return 100;
  if (r >= 1.15) return 85;
  if (r >= 1.10) return 70;
  if (r >= 1.05) return 50;
  if (r >= 1.00) return 30;
  if (r >= 0.85) return 10;
  return 0;
}

function gradeFromScore(s) {
  if (s == null) return 'N/A';
  if (s >= 85) return 'A+';
  if (s >= 75) return 'A';
  if (s >= 65) return 'B+';
  if (s >= 50) return 'B';
  if (s >= 35) return 'C';
  return 'D';
}

/* ── (3) 한 종목 성장 등급 산출 ─────────────────────────────── */
function computeGrowthGrade(stock, incomeRows) {
  if (!Array.isArray(incomeRows) || incomeRows.length === 0) {
    return { grade: 'N/A', score: null, confidence: 'none', flags: ['재무 이력 없음'], breakdown: null };
  }
  // 결산년월 오름차순 정렬 (오래된 → 최신)
  const sorted = [...incomeRows].sort((a, b) => (a.yymm || '').localeCompare(b.yymm || ''));
  const latest = sorted[sorted.length - 1];

  // 3년 전 데이터 (인덱스 4번째 뒤에서 = 4년 전 결산. 3년 CAGR = 4 row가 필요)
  // KIS가 보통 5개년 반환 → sorted 길이 5면 index 1이 4년 전 / index 4가 최신
  // 3년 CAGR: (최신) / (3년 전) → 시작과 끝 사이가 3년이어야 함
  const idxStart = sorted.length - 4; // 4번째 뒤 = 3년 전
  const start    = idxStart >= 0 ? sorted[idxStart] : null;

  let netCagr = null, salesCagr = null;
  if (start) {
    netCagr   = calcCAGR(latest.netIncome, start.netIncome, 3);
    salesCagr = calcCAGR(latest.sales,     start.sales,     3);
  }

  const netScore   = scoreCAGR(netCagr);
  const salesScore = scoreCAGR(salesCagr);
  const divScore   = scoreDividendRatio(_num(stock.prevDps), _num(stock.avgDps));

  // 가중치 50/30/20, 결측은 가능한 지표만 정규화
  const parts = [
    { key: 'netIncome', w: 0.5, score: netScore },
    { key: 'dividend',  w: 0.3, score: divScore },
    { key: 'sales',     w: 0.2, score: salesScore },
  ];
  const valid = parts.filter(p => p.score != null);

  if (valid.length === 0) {
    return { grade: 'N/A', score: null, confidence: 'none', flags: ['지표 산출 불가'], breakdown: null };
  }

  const totalW = valid.reduce((s, p) => s + p.w, 0);
  const score  = valid.reduce((s, p) => s + (p.w / totalW) * p.score, 0);

  // 신뢰도: 3지표 모두 + 3년치 다 있으면 high, 일부 결측은 mid/low
  let confidence = 'low';
  if (valid.length === 3 && start && sorted.length >= 4) confidence = 'high';
  else if (valid.length >= 2)                            confidence = 'mid';

  const flags = [];
  if (netCagr   != null && netCagr   < 0) flags.push('순이익 역성장');
  if (salesCagr != null && salesCagr < 0) flags.push('매출 역성장');
  if (divScore  != null && divScore  === 0) flags.push('배당 감액 의심');
  // 배당 데이터가 5년 시계열이 아닌 prevDps/avgDps 근사라는 점 메타에 명시
  if (divScore != null) flags.push('배당 점수는 4년 평균 대비 근사값');

  return {
    grade: gradeFromScore(score),
    score: +score.toFixed(1),
    confidence,
    flags,
    breakdown: {
      netIncome: { cagr: netCagr   != null ? +(netCagr   * 100).toFixed(2) : null, score: netScore != null ? +netScore.toFixed(1) : null },
      sales:     { cagr: salesCagr != null ? +(salesCagr * 100).toFixed(2) : null, score: salesScore != null ? +salesScore.toFixed(1) : null },
      dividend:  {
        prevDps: _num(stock.prevDps),
        avgDps:  _num(stock.avgDps),
        ratio:   (Number.isFinite(_num(stock.prevDps)) && Number.isFinite(_num(stock.avgDps)) && _num(stock.avgDps) > 0)
                   ? +(_num(stock.prevDps) / _num(stock.avgDps)).toFixed(3)
                   : null,
        score:   divScore != null ? +divScore.toFixed(1) : null,
      },
      yearsObserved: sorted.length,
      latestPeriod:  latest.yymm,
    },
  };
}

/* ── (4) 다종목 일괄 산출 (concurrency 5, KIS 무료 한도 안에서) ─ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAndGradeMany(stocks, concurrency = 5) {
  const out   = {};
  const queue = stocks.filter(s => s.code).map(s => s);
  let firstKeysLogged = false;
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        const rows = await fetchIncomeStatement(s.code);
        if (!firstKeysLogged && rows.length > 0) {
          console.log('[growth] sample raw keys:', rows[0]._rawKeys.slice(0, 25).join(','));
          firstKeysLogged = true;
        }
        out[s.code] = computeGrowthGrade(s, rows);
      } catch (e) {
        await sleep(300);
        try {
          const rows = await fetchIncomeStatement(s.code);
          out[s.code] = computeGrowthGrade(s, rows);
        } catch (e2) {
          out[s.code] = { grade: 'N/A', score: null, confidence: 'none',
            flags: [`수집 실패: ${String(e2.message || e2).slice(0, 80)}`], breakdown: null };
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/* ── (5) 캐시 빌더 (server.js에서 호출) ─────────────────────── */
async function buildGrowthGrades(stocks) {
  const grades = await fetchAndGradeMany(stocks, 5);
  return {
    asOf:       new Date().toISOString().slice(0, 10),
    updatedAt:  new Date().toISOString(),
    grades,
    rawCount:   Object.keys(grades).length,
    source:     'KIS income-statement (FHKST66430200) + prevDps/avgDps 근사',
  };
}

module.exports = { computeGrowthGrade, buildGrowthGrades, fetchIncomeStatement, gradeFromScore, scoreCAGR, scoreDividendRatio, calcCAGR };
