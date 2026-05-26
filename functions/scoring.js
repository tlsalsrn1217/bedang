/**
 * scoring.js — 배당주 종합 점수 엔진 (결정론적, 전 파라미터 조정 가능)
 * ------------------------------------------------------------------
 * 모든 수치는 config 객체로 주입 가능. 사용자가 설정탭에서 바꾸거나
 * AI(Gemini)가 추천한 값을 그대로 넣을 수 있다. config 미지정 시 DEFAULT 사용.
 *
 * 점수 = max(0, (1층 가중합) × 섹터승수 − 레드플래그감점)
 *
 * [분류 체계] GICS 기반 2단계 (sector 대분류, industry 소분류)
 * 비교 단위: industry 표본 ≥ 3이면 industry, 미만이면 sector 단위로 병합
 * 승수 조회: industry 오버라이드 → sector 기본값 순으로 적용
 */

const DEFAULT_CONFIG = {
  // ── 1층 기본 가중치 (합 = 1.0 권장, 코드가 자동 정규화) ──
  weights: {
    value: 0.32,        // 밸류 (PBR·PER) ★핵심
    profit: 0.23,       // 수익성 (ROE·ROE/PBR) ★핵심
    yield: 0.18,        // 배당매력 (현재 배당률) ★핵심
    durability: 0.17,   // 배당지속성 (전년/4년평균) ★핵심
    // ── 추가 지표 (보조, 기본 가중치 낮음) ──
    growth: 0.06,       // 배당 성장성 (전년 > 4년평균이면 가점)
    liquidity: 0.04,    // 유동성 (시가총액 클수록 안전)
  },
  // 밸류 내부 구성비
  valueMix: { pbr: 0.6, per: 0.4 },
  profitMix: { roe: 0.5, roePerPbr: 0.5 },

  // ── 2층 거시 섹터 승수 (GICS 11개 섹터 + 주요 업종 미세조정) ──
  // 업종(industry) 키가 있으면 섹터보다 우선 적용
  sectorMultipliers: {
    // GICS 대분류 섹터 기본값
    '금융': 1.02,
    '에너지': 1.04,
    '산업재': 1.00,
    '소재': 0.98,
    '경기소비재': 0.96,
    '필수소비재': 1.00,
    '헬스케어': 1.00,
    '정보기술': 0.98,
    '통신서비스': 1.02,
    '유틸리티': 1.00,
    '부동산': 0.98,
    // 소분류 미세조정 (섹터 기본값 오버라이드)
    '은행': 1.06,
    '보험': 1.05,
    '증권': 0.98,
    '여신': 0.96,
    '인프라펀드': 0.96,
    '금융서비스': 0.96,
    '부동산신탁': 0.96,
  },
  defaultMultiplier: 1.0,

  // ── 레드플래그 감점 (조정 가능) ──
  penalties: {
    deficit: 10,        // 적자/왜곡
    payoutOver100: 10,  // 배당성향 100% 초과
    divCut: 10,         // 배당 삭감
  },
  // 레드플래그 임계값
  thresholds: {
    payoutMax: 100,     // 배당성향 이 % 초과 시 경고
    divCutRatio: 0.7,   // 전년배당 < 4년평균×이값 → 삭감 경고
    liquidityFloor: 1000, // 시총(억) 이 값에서 유동성 0점, 10배에서 만점
  },

  // 업종별 가중치 오버라이드 (industry 기준, 지정 시 weights 대체)
  categoryWeights: {
    '은행':     { value: 0.32, profit: 0.28, yield: 0.18, durability: 0.12, growth: 0.06, liquidity: 0.04 },
    '보험':     { value: 0.36, profit: 0.18, yield: 0.18, durability: 0.18, growth: 0.06, liquidity: 0.04 },
    '증권':     { value: 0.28, profit: 0.28, yield: 0.18, durability: 0.16, growth: 0.06, liquidity: 0.04 },
    '복합기업': { value: 0.36, profit: 0.23, yield: 0.18, durability: 0.13, growth: 0.06, liquidity: 0.04 },
  },
};

function toNum(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).replace(/,/g, '').trim();
  if (['#N/A', '-', '', 'N/A', '#REF!'].includes(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function percentileRank(val, pool, higherBetter) {
  const arr = pool.filter((a) => a !== null && a !== undefined);
  if (val === null || val === undefined || arr.length < 2) return 50;
  const below = arr.filter((a) => a < val).length;
  const p = (below / arr.length) * 100;
  return higherBetter ? p : 100 - p;
}

function normalizeWeights(w) {
  const sum = Object.values(w).reduce((a, b) => a + (b || 0), 0) || 1;
  const out = {};
  for (const k of Object.keys(w)) out[k] = (w[k] || 0) / sum;
  return out;
}

function deepMerge(base, over) {
  if (!over) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
      ? deepMerge(base[k] || {}, over[k]) : over[k];
  }
  return out;
}

function scoreStocks(stocks, userConfig = {}) {
  // null 키 제거 후 머지
  const clean = {};
  for (const k of Object.keys(userConfig || {})) {
    if (userConfig[k] !== null && userConfig[k] !== undefined) clean[k] = userConfig[k];
  }
  const cfg = deepMerge(DEFAULT_CONFIG, clean);

  // ── 비교 그룹 결정: industry ≥ 3이면 industry, 미만이면 sector ──
  const byInd = {};
  for (const s of stocks) {
    const ind = s.industry || s.category;
    (byInd[ind] = byInd[ind] || []).push(s);
  }
  const byGrp = {};
  for (const s of stocks) {
    const ind = s.industry || s.category;
    const sec = s.sector || s.category;
    const grpKey = (byInd[ind] || []).length >= 3 ? ind : sec;
    (byGrp[grpKey] = byGrp[grpKey] || []).push(s);
  }

  const results = [];
  for (const [grpKey, items] of Object.entries(byGrp)) {
    const pbrs = items.map((i) => toNum(i.pbr));
    const pers = items.map((i) => toNum(i.per));
    const roes = items.map((i) => toNum(i.roe));
    const rpbr = items.map((i) => {
      const r = toNum(i.roe), p = toNum(i.pbr);
      return r !== null && p !== null && p > 0 ? r / p : null;
    });
    const dys = items.map((i) => toNum(i.divYield));

    const rawW = cfg.categoryWeights[grpKey] || cfg.weights;
    const W = normalizeWeights(rawW);

    items.forEach((i, idx) => {
      const per = toNum(i.per), pbr = toNum(i.pbr), roe = toNum(i.roe),
            payout = toNum(i.payout), prevDps = toNum(i.prevDps),
            avgDps = toNum(i.avgDps), mcap = toNum(i.mcap);

      const flags = [];
      if ((per !== null && per < 0) || (roe !== null && roe < 0) || (payout !== null && payout < 0))
        flags.push('적자/왜곡 (분모 음수로 지표 신뢰 불가)');
      if (payout !== null && payout > cfg.thresholds.payoutMax)
        flags.push(`배당성향 ${cfg.thresholds.payoutMax}% 초과 (이익 초과 배당, 지속 불가능 우려)`);
      if (prevDps !== null && avgDps !== null && prevDps < avgDps * cfg.thresholds.divCutRatio)
        flags.push('배당 삭감 (전년 배당이 4년평균 대비 큰 폭 감소)');

      // 1층 지표
      const vPbr = percentileRank(pbr, pbrs, false);
      const vPer = per !== null && per > 0 ? percentileRank(per, pers, false) : 30;
      const value = cfg.valueMix.pbr * vPbr + cfg.valueMix.per * vPer;

      const pRoe = percentileRank(roe, roes, true);
      const pRp = percentileRank(rpbr[idx], rpbr, true);
      const profit = cfg.profitMix.roe * pRoe + cfg.profitMix.roePerPbr * pRp;

      const yieldScore = percentileRank(toNum(i.divYield), dys, true);

      let durability = 50;
      if (prevDps !== null && avgDps !== null && avgDps > 0) {
        const ratio = prevDps / avgDps;
        durability = Math.min(100, Math.max(0, ((ratio - 0.7) / 0.6) * 100));
      }

      // 배당 성장성
      let growth = 50;
      if (prevDps !== null && avgDps !== null && avgDps > 0) {
        const g = prevDps / avgDps;
        growth = Math.min(100, Math.max(0, (g - 0.7) / 0.6 * 100));
      }
      // 유동성
      let liquidity = 50;
      if (mcap !== null && mcap > 0) {
        const f = cfg.thresholds.liquidityFloor;
        liquidity = Math.min(100, Math.max(0, (Math.log10(mcap) - Math.log10(f)) / 1 * 100));
      }

      const parts = { value, profit, yield: yieldScore, durability, growth, liquidity };
      let baseScore = 0;
      for (const k of Object.keys(W)) baseScore += W[k] * (parts[k] ?? 50);

      // 승수: industry 오버라이드 → sector 기본값
      const indKey = i.industry || i.category;
      const secKey = i.sector || i.category;
      const mul = cfg.sectorMultipliers[indKey] ?? cfg.sectorMultipliers[secKey] ?? cfg.defaultMultiplier;

      let penalty = 0;
      if (flags.some((f) => f.startsWith('적자'))) penalty += cfg.penalties.deficit;
      if (flags.some((f) => f.includes('초과'))) penalty += cfg.penalties.payoutOver100;
      if (flags.some((f) => f.startsWith('배당 삭감'))) penalty += cfg.penalties.divCut;

      const score = Math.max(0, +(baseScore * mul - penalty).toFixed(1));

      results.push({
        ...i, score, baseScore: +baseScore.toFixed(1), multiplier: mul, flags,
        breakdown: {
          value: +value.toFixed(1), profit: +profit.toFixed(1),
          yield: +yieldScore.toFixed(1), durability: +durability.toFixed(1),
          growth: +growth.toFixed(1), liquidity: +liquidity.toFixed(1),
          weights: W,
        },
      });
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

module.exports = { scoreStocks, toNum, DEFAULT_CONFIG };
