/**
 * baseline.js — 시장·업종 기준선 (KRX 정보데이터시스템)
 * ------------------------------------------------------------------
 * 점수 공식·가중치는 그대로 두고, 상대비교의 "기준선"만 진짜 시장 수치로 교체.
 *
 * 소스: data.krx.co.kr getJsonData.cmd
 *   - MDCSTAT00701: 전 지수(시장·업종) PER/PBR/배당수익률(%)
 *     params: trdDd, idxIndMidclssCd (01=KOSPI, 02=KOSDAQ, 03=KRX 시리즈)
 *   - 응답: { output: [{ IDX_NM_KOR, CLSPRC_IDX, PER, PBR, DVD_YLD, ... }] }
 *
 * KRX 응답 단위:
 *   - PER, PBR: 배수 (예: 11.3)
 *   - DVD_YLD: 퍼센트 (예: 2.34)  ← 우리 stocks.divYield는 비율(0.0234)이라 비교 시 ×100 보정 필요
 *
 * 주의: KRX 지수 fundamental에는 ROE 없음 → ROE는 기존 동종 분포 폴백.
 *
 * 캐시: appData/baseline 단일 문서. 매일 1회 수동/스케줄 갱신 권장.
 */

const KRX_URL = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';

const KRX_HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':           'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer':          'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201010107',
  'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
};

// 한국시간 기준 가장 최근 영업일 (보수적으로 어제부터 역산)
function recentTradingDate() {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const d = new Date(kstNow);
  d.setDate(d.getDate() - 1); // 오늘 데이터는 장 마감 후에야 채워지므로 어제부터
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function fetchIndexFundamentals(trdDd, midCls) {
  const body = new URLSearchParams({
    bld:              'dbms/MDC/STAT/standard/MDCSTAT00701',
    trdDd,
    idxIndMidclssCd:  midCls,
    share:            '1',
    money:            '1',
    csvxls_isNo:      'false',
  });
  const res = await fetch(KRX_URL, {
    method:  'POST',
    headers: KRX_HEADERS,
    body:    body.toString(),
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`KRX HTTP ${res.status} (midCls=${midCls})`);
  const data = await res.json();
  return Array.isArray(data?.output) ? data.output : [];
}

function _num(s) {
  const n = parseFloat(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function normalizeRow(r) {
  return {
    name:       String(r.IDX_NM_KOR || '').trim(),
    per:        _num(r.PER),
    pbr:        _num(r.PBR),
    divYieldPc: _num(r.DVD_YLD),    // 퍼센트(예: 2.34)
    close:      _num(r.CLSPRC_IDX),
  };
}

/**
 * 우리 분류(GICS) → KRX 지수명 매핑.
 * KRX에 1:1 대응 지수가 있으면 사용, 없으면 null → 시장 평균(KOSPI)로 폴백.
 * 키는 우리 stocks의 industry 또는 sector 값과 정확히 일치해야 함.
 */
const INDUSTRY_TO_KRX = {
  // GICS 대분류
  '금융':         '코스피 금융업',
  '에너지':       null,                  // 단독 지수 없음
  '산업재':       null,
  '소재':         '코스피 화학',
  '경기소비재':   null,
  '필수소비재':   '코스피 음식료품',
  '헬스케어':     '코스피 의약품',
  '정보기술':     '코스피 전기전자',
  '통신서비스':   '코스피 통신업',
  '유틸리티':     '코스피 전기가스업',
  '부동산':       null,
  // industry 소분류 (우선)
  '은행':         '코스피 은행',
  '증권':         '코스피 증권',
  '보험':         '코스피 보험',
  '여신':         '코스피 금융업',
  '금융서비스':   '코스피 금융업',
  '인프라펀드':   null,
  '부동산신탁':   null,
  '복합기업':     null,
};

async function buildBaseline() {
  const trdDd = recentTradingDate();
  const [k1, k2, k3] = await Promise.all([
    fetchIndexFundamentals(trdDd, '01').catch(e => { console.error('[baseline] KOSPI:', e.message); return []; }),
    fetchIndexFundamentals(trdDd, '02').catch(e => { console.error('[baseline] KOSDAQ:', e.message); return []; }),
    fetchIndexFundamentals(trdDd, '03').catch(e => { console.error('[baseline] KRX:', e.message); return []; }),
  ]);
  const all   = [...k1, ...k2, ...k3].map(normalizeRow).filter(r => r.name);
  const byName = {};
  for (const r of all) byName[r.name] = r;

  if (all.length === 0) {
    throw new Error('KRX 응답이 비어 있음 — 거래일 또는 접근 차단 확인');
  }

  // 시장 평균
  const market = {
    kospi:  byName['코스피']  || null,
    kosdaq: byName['코스닥']  || null,
  };

  // 업종 매핑
  const industries = {};
  for (const [ourKey, krxName] of Object.entries(INDUSTRY_TO_KRX)) {
    if (krxName && byName[krxName]) {
      industries[ourKey] = { ...byName[krxName], krxName };
    }
  }

  return {
    asOf:       trdDd,
    updatedAt:  new Date().toISOString(),
    market,
    industries,
    rawCount:   all.length,
    source:     'KRX MDCSTAT00701',
  };
}

/**
 * 종목 지표(value) vs 기준선 중앙값(median) → 0~100 점수.
 * higherBetter=true: 높을수록 좋음(ROE, divYield), false: 낮을수록 좋음(PER, PBR).
 * 중앙값과 같으면 50점, 절반/두 배에서 0/100 양 끝으로 수렴(클램프).
 */
function relativeFromMedian(value, median, higherBetter) {
  if (value == null || median == null || !Number.isFinite(median) || median <= 0) return null;
  if (!Number.isFinite(value)) return null;
  const ratio = value / median;
  const score = higherBetter
    ? 50 + (ratio - 1) * 50
    : 50 + (1 - ratio) * 50;
  return Math.max(0, Math.min(100, score));
}

/**
 * 종목의 매칭되는 기준선(업종 우선, 없으면 시장)을 돌려준다.
 * 시장 폴백 순서: industry → sector → KOSPI → KOSDAQ.
 */
function pickBaseline(baseline, stock) {
  if (!baseline) return null;
  const ind = stock.industry || stock.category;
  const sec = stock.sector   || stock.category;
  return (baseline.industries?.[ind])
      || (baseline.industries?.[sec])
      || baseline.market?.kospi
      || baseline.market?.kosdaq
      || null;
}

module.exports = { buildBaseline, relativeFromMedian, pickBaseline, INDUSTRY_TO_KRX };
