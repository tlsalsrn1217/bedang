/**
 * baseline.js — 시장·업종 기준선 (KIS 직접 집계)
 * ------------------------------------------------------------------
 * 결정 사항(2026-05-27): KRX 직접 호출은 GCP IP가 차단됨(LOGOUT).
 * → KIS API로 이미 수집한 db.stocks의 지표를 업종별로 중앙값 집계.
 *
 * 장점:
 *  - 추가 API 호출 0건 (이미 refresh 시점에 KIS로 받아 둔 값을 재사용)
 *  - ROE도 함께 집계 가능 (KIS 응답에 있음 — KRX 지수에는 없었음)
 *
 * 한계:
 *  - 표본이 우리 시드 종목(주로 배당주)이라 진짜 KOSPI 평균이 아님 → 편향
 *  - sampleSize, source 명시로 투명하게 표시
 *  - 후속 단계로 KOSPI200 / KOSDAQ150 시드 확장 가능
 *
 * 집계 방식:
 *  - 업종별(industry) ≥ 3개 → 업종 중앙값
 *  - 시장(KOSPI) = 모든 유효 종목 중앙값
 *  - PER/PBR/ROE는 KIS fetchMetrics 응답값 그대로
 *  - divYield는 stocks.divYield(비율)를 ×100해서 % 단위로 통일
 */

const { load } = require('./db');

function _median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _today() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

function _aggregate(items, label) {
  const pers = items.map(s => s.per).filter(v => Number.isFinite(v) && v > 0);
  const pbrs = items.map(s => s.pbr).filter(v => Number.isFinite(v) && v > 0);
  const roes = items.map(s => s.roe).filter(v => Number.isFinite(v));
  // divYield: 비율(0.05) → 퍼센트(5.0)로 통일
  const divs = items
    .map(s => s.divYield)
    .filter(v => Number.isFinite(v) && v > 0)
    .map(v => v * 100);
  return {
    name:       label,
    per:        _median(pers),
    pbr:        _median(pbrs),
    roe:        _median(roes),
    divYieldPc: _median(divs),
    sampleSize: items.length,
    valid: {
      per: pers.length, pbr: pbrs.length, roe: roes.length, divYield: divs.length,
    },
  };
}

async function buildBaseline() {
  // 공용 시드 stocks를 표본으로 사용 (이미 KIS로 갱신된 최신 지표 포함)
  const db    = await load();
  const stocks = (db.stocks || []).filter(s =>
    Number.isFinite(s.per) && s.per > 0 &&
    Number.isFinite(s.pbr) && s.pbr > 0
  );
  if (stocks.length === 0) {
    throw new Error('appData/stocks 가 비었거나 PER/PBR이 모두 누락 — KIS refresh 먼저 필요');
  }

  // 업종별 그룹 (industry 우선, 없으면 sector, 그것도 없으면 category)
  const byGroup = {};
  for (const s of stocks) {
    const k = s.industry || s.sector || s.category;
    if (!k) continue;
    (byGroup[k] = byGroup[k] || []).push(s);
  }
  const industries = {};
  for (const [grp, items] of Object.entries(byGroup)) {
    if (items.length < 3) continue; // 표본 너무 작으면 제외
    industries[grp] = _aggregate(items, grp);
  }

  const market = {
    kospi:  _aggregate(stocks, 'KOSPI 표본 평균'),
    kosdaq: null, // 우리 시드는 KOSPI 중심
  };

  return {
    asOf:      _today(),
    updatedAt: new Date().toISOString(),
    market,
    industries,
    rawCount:  stocks.length,
    source:    'KIS aggregate (in-app stocks)',
    note:      '시드 종목(주로 배당주) 기반 표본 평균 — 전체 시장 평균과는 편향이 있을 수 있음',
  };
}

/**
 * 종목 지표(value) vs 기준선 중앙값(median) → 0~100 점수.
 * higherBetter=true: 높을수록 좋음(ROE, divYield), false: 낮을수록 좋음(PER, PBR).
 */
function relativeFromMedian(value, median, higherBetter) {
  if (value == null || median == null || !Number.isFinite(median) || median <= 0) return null;
  if (!Number.isFinite(value)) return null;
  const ratio = value / median;
  const raw   = higherBetter ? 50 + (ratio - 1) * 50 : 50 + (1 - ratio) * 50;
  return Math.max(0, Math.min(100, raw));
}

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

module.exports = { buildBaseline, relativeFromMedian, pickBaseline };
