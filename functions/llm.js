/**
 * llm.js — Gemini API 연동
 * ------------------------------------------------------------------
 *  (1) explainStock()       : 종목 해설 (캐시 재사용 시 폴백)
 *  (2) streamExplainStock() : 종목 해설 — 그라운딩+스트리밍 (SSE)
 *  (3) recommendConfig()    : 거시·뉴스 기반 파라미터 조정안 제안
 */

const MODEL = 'gemini-2.5-flash';
const PRO_MODEL = 'gemini-2.5-pro';

async function callGemini(prompt, { model = MODEL, json = false, grounding = false, apiKey } = {}) {
  apiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: grounding ? 4000 : 2000,
      ...(!grounding && json ? { responseMimeType: 'application/json' } : {}),
      ...(!grounding ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (grounding) body.tools = [{ googleSearch: {} }];
  const res = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

/* ── (1) 종목 해설 프롬프트 — 지표·점수 근거 전용 (baseline 통합) ── */
function buildExplainPrompt(stock, marketBaseline) {
  const b   = stock.breakdown;
  const pct = (v) => v != null ? (v * 100).toFixed(2) + '%' : '-';
  const fmt = (v, k) => {
    if (v == null || !Number.isFinite(Number(v))) return '-';
    const n = Number(v);
    return k === 'pct' ? n.toFixed(2) + '%' : n.toFixed(2);
  };
  const diff = (val, med, lowerBetter) => {
    if (val == null || med == null || !Number.isFinite(med) || med <= 0) return '-';
    const p = (val - med) / med * 100;
    if (Math.abs(p) < 3) return '평균과 비슷';
    const isLow = p < 0;
    const good  = lowerBetter ? isLow : !isLow;
    const arrow = isLow ? '↓' : '↑';
    const tag   = lowerBetter ? (good ? '저평가' : '고평가') : (good ? '우수' : '부진');
    return `${arrow}${Math.abs(p).toFixed(0)}% (${tag})`;
  };

  const ind   = stock.baseline; // 업종 평균(없으면 시장)
  const mkt   = marketBaseline; // 시장 평균 (KOSPI 시드 표본)
  const indNm = ind?.name || '동종 업종';

  // 성장 등급 블록 (KIS 다년치 손익 기반, 종합점수와 별도)
  const gg = stock.growthGrade ? {
    grade:      stock.growthGrade,
    score:      stock.growthScore,
    confidence: stock.growthConfidence,
    bd:         stock.growthBreakdown || {},
    flags:      stock.growthFlags || [],
  } : null;
  const growthBlock = gg ? `
[성장 등급 — 종합점수와 별도 지표 (KIS 다년치 손익 기반)]
· 등급: ${gg.grade}  · 점수: ${gg.score ?? '-'}/100  · 신뢰도: ${gg.confidence || '-'}
· 순이익 3년 CAGR: ${gg.bd.netIncome?.cagr != null ? (gg.bd.netIncome.cagr >= 0 ? '+' : '') + gg.bd.netIncome.cagr.toFixed(2) + '%/년' : '-'}  → 점수 ${gg.bd.netIncome?.score ?? '-'}
· 매출 3년 CAGR: ${gg.bd.sales?.cagr != null ? (gg.bd.sales.cagr >= 0 ? '+' : '') + gg.bd.sales.cagr.toFixed(2) + '%/년' : '-'}  → 점수 ${gg.bd.sales?.score ?? '-'}
· 배당 (전년/4년평균 비율): ${gg.bd.dividend?.ratio ?? '-'}  → 점수 ${gg.bd.dividend?.score ?? '-'}
· 플래그: ${gg.flags.length ? gg.flags.join(', ') : '없음'}` : '';

  // 정성 분석 태그 (있을 때만 — 모달 진입 시 별도로 호출되므로 보통은 미주입)
  // 정성 태그가 stock 객체에 첨부돼 있으면 활용 (server에서 옵션 주입 가능)
  const qualTag    = stock.qualPremiumTag || null;
  const qualBlock  = qualTag && qualTag !== 'none' ? `
[정성 분석 태그 (사용자 별도 분석 결과)]
· 정성 태그: ${qualTag}
※ 정량 성장 등급(${gg?.grade || '-'})과 비교해 일치/불일치를 언급할 것.` : '';

  // 종목값 (PER/PBR/ROE/배당률)을 baseline과 비교
  const stockDivPc = stock.divYield != null ? stock.divYield * 100 : null;
  const baseBlock = (ind || mkt) ? `
[기준선 — 시드 표본 중앙값 (KIS 집계, 매일 1회 갱신)]
${ind ? `· ${indNm} 평균: PER ${fmt(ind.per)} / PBR ${fmt(ind.pbr)} / ROE ${fmt(ind.roe,'pct')} / 배당률 ${fmt(ind.divYieldPc,'pct')}  (표본 ${ind.sampleSize ?? '?'}종)` : '· 업종 평균 데이터 없음'}
${mkt ? `· KOSPI 시장 평균:  PER ${fmt(mkt.per)} / PBR ${fmt(mkt.pbr)} / ROE ${fmt(mkt.roe,'pct')} / 배당률 ${fmt(mkt.divYieldPc,'pct')}  (표본 ${mkt.sampleSize ?? '?'}종)` : '· 시장 평균 데이터 없음'}

[이 종목 vs ${indNm} 평균]
· PER:   ${diff(stock.per, ind?.per, true)}
· PBR:   ${diff(stock.pbr, ind?.pbr, true)}
· ROE:   ${diff(stock.roe, ind?.roe, false)}
· 배당률: ${diff(stockDivPc, ind?.divYieldPc, false)}` : '';

  return `당신은 배당주 점수 모델 해설가입니다.
아래 종목의 정량 지표가 같은 업종/시장 평균과 어떻게 다른지 초보 투자자에게 쉬운 한국어로 설명하세요.
외부 뉴스·예측·시황은 언급하지 마세요. 제공된 수치만 근거로 삼으세요.

[종목] ${stock.name} (${stock.category})
[종합점수] ${stock.score}/100 = 기본점수 ${stock.baseScore} × 섹터승수 ${stock.multiplier}
[세부점수] 밸류 ${b.value} / 수익성 ${b.profit} / 배당매력 ${b.yield} / 배당지속성 ${b.durability} / 성장 ${b.growth} / 유동성 ${b.liquidity}
[시장지표] PER ${stock.per} · PBR ${stock.pbr} · ROE ${stock.roe}% · 배당성향 ${stock.payout}%
[배당지표] 배당률 ${pct(stock.divYield)} · 4년평균배당률 ${pct(stock.avgYield)} · 전년DPS ${stock.prevDps ?? '-'}원 · 4년평균DPS ${stock.avgDps ? Math.round(stock.avgDps) : '-'}원
[경고] ${stock.flags && stock.flags.length ? stock.flags.join(', ') : '없음'}
${baseBlock}
${growthBlock}
${qualBlock}

[해설 규칙]
- "PER 5.77은 낮다" 같은 일반론 대신 "${indNm} 평균 대비 X% 저평가" 식으로 ★기준선 대비★ 해설할 것.
- 표본이 시드 종목(주로 배당주)이라 시장 전체와 편향이 있을 수 있음을 한 번 언급(과장 X).
- 단정 표현 금지 — "~한 편으로 보입니다", "~로 해석됩니다" 식 추측형.
- ★ 성장 흐름은 별도 항목(growth_note)에서 다룰 것. 종합점수에 자동 가산되지 않는 별도 지표임을 명시.
- 종합점수(저평가)와 성장 등급(꾸준한 개선)의 ★일치/불일치★를 자연스럽게 코멘트:
  · 종합점수 높음 + 성장 A 계열 → "저평가 + 성장의 황금 조합으로 보입니다"
  · 종합점수 높음 + 성장 D 계열 → "현재는 싸지만 성장이 정체된 모습이라 가치 함정 여부를 점검할 필요가 있어 보입니다"
  · 종합점수 낮음 + 성장 A 계열 → "프리미엄을 받고 있으나 이력상 꾸준히 좋아지는 모습입니다"
- 정성 태그(qualPremiumTag)가 있으면 정량 성장 등급과 비교해 같은 방향/어긋남을 한 문장으로 언급.

반드시 아래 JSON 형식만 출력하세요. 마크다운 기호(#, *, -, \`, > 등) 절대 사용 금지. 순수 JSON만.
{"summary":"종합점수 근거 한줄평 (1~2문장, 업종 평균 대비 위치 명시)","score_reason":"세부 점수가 높거나 낮은 이유를 기준선 비교로 설명 (2~3문장)","growth_note":"성장 등급 ${gg?.grade || '-'}의 근거(순이익·매출 CAGR·배당 추이)와 종합점수와의 관계 한 단락. ${gg ? '신뢰도 ' + gg.confidence + '도 함께 언급.' : '성장 데이터 부족 시 그 사실 명시.'}","risks":"경고·주의 지표 해설 및 투자 시 주의사항 (없으면 '특이 경고 없음')","checkpoints":"이 종목 투자 전 직접 확인해야 할 체크리스트 2~3가지"}`;
}

/* ── (1-a) 해설 생성 — JSON 모드, 그라운딩 없음. marketBaseline은 KOSPI 시드 표본 평균 ── */
async function explainStock(stock, apiKey, marketBaseline) {
  const raw = await callGemini(buildExplainPrompt(stock, marketBaseline), { json: true, apiKey });
  return parseExplainRaw(raw);
}

function parseExplainRaw(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  }
  if (!parsed) {
    const plain = raw.replace(/[#*`>~_[\]]/g, '').trim();
    parsed = { summary: plain || '해설 생성 실패', strengths: '', risks: '', checkpoints: '', news: '' };
  }
  return parsed;
}

/* ── (1-b) 스트리밍 해설 — async generator ── */
async function* streamExplainStock(stock, apiKey) {
  apiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const body = {
    contents: [{ parts: [{ text: buildExplainPrompt(stock) }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 미완성 줄은 다음 chunk로
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json) continue;
      try {
        const obj = JSON.parse(json);
        const text = obj?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        if (text) yield text;
      } catch (_) {}
    }
  }
}

/* ── (2) 파라미터 AI 추천 ── */
function buildConfigPrompt(currentConfig, categories) {
  return `당신은 한국 주식시장 거시 전략가입니다. 오늘 날짜 기준 한국 경기상황, 금리·환율·유가, 업종별 최신 뉴스와 리스크를 검색해 파악한 뒤, 아래 배당주 점수 모델의 파라미터를 조정 제안하세요.

[현재 설정]
${JSON.stringify(currentConfig, null, 2)}

[대상 카테고리] ${categories.join(', ')}

[규칙 — 반드시 준수]
- 섹터 승수(sectorMultipliers)는 0.90~1.10 범위만. 한 번에 ±0.06 이내로 조정.
- 가중치(weights)는 기본 4대 지표(value/profit/yield/durability)가 항상 합산 비중 80% 이상 유지. 추가지표(growth/liquidity)는 최대 20%.
- 근거 없는 변경 금지. 모든 변경에 "오늘의 구체적 이슈" 근거를 붙일 것.
- 변경이 불필요한 항목은 현재값 유지.

[출력] 순수 JSON만. 형식:
{
  "asOf": "YYYY-MM-DD",
  "macroSummary": "오늘 거시 환경 3~4문장 요약(근거 뉴스 포함)",
  "recommendedConfig": { ...조정된 전체 config... },
  "changes": [
    {"path":"sectorMultipliers.은행","from":1.06,"to":1.08,"reason":"구체적 근거"}
  ],
  "warnings": ["주의할 점"]
}`;
}
async function recommendConfig(currentConfig, categories, apiKey) {
  const raw = await callGemini(buildConfigPrompt(currentConfig, categories),
    { model: PRO_MODEL, json: true, grounding: true, apiKey });
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { error: 'JSON 파싱 실패', raw };
  }
  return parsed;
}

/* ── (3) 종목 카테고리 AI 분류 ── */
async function classifyCategory(name, categories, apiKey) {
  const prompt = `한국 주식 종목 "${name}"의 배당주 투자 카테고리를 분류하세요.
기존 카테고리: ${categories.join(', ')}
반드시 기존 카테고리 중 하나를 선택하세요. 맞는 게 없으면 가장 유사한 것 선택.
순수 JSON만: {"category":"카테고리명"}`;
  const raw = await callGemini(prompt, { json: true, apiKey: apiKey || process.env.GEMINI_API_KEY });
  const m = raw.match(/\{[\s\S]*?\}/);
  return (m ? JSON.parse(m[0]) : JSON.parse(raw)).category;
}

/* ── (4) 카테고리 분류 + 배당주 여부 동시 확인 ── */
async function classifyAndCheck(name, categories, apiKey) {
  const prompt = `한국 주식 종목 "${name}"에 대해 두 가지를 답하세요.
기존 카테고리: ${categories.join(', ')}

순수 JSON만 출력:
{"category":"위 카테고리 중 가장 적합한 것","isDividend":true,"dividendWarning":""}
isDividend가 false이면 dividendWarning에 한 문장으로 이유 작성. 배당주면 빈 문자열.`;
  const raw = await callGemini(prompt, { json: true, apiKey: apiKey || process.env.GEMINI_API_KEY });
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*?\}/);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  }
  return parsed || { category: categories[0] || '기타', isDividend: null, dividendWarning: '' };
}

/* ── (5) 뉴스 영향도 분류 — 정성 레이어 보조 ── */
async function classifyNewsImpact(stockName, items, apiKey) {
  apiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');
  if (!Array.isArray(items) || items.length === 0) return [];
  const list = items.slice(0, 8);
  const titles = list.map((n, i) => `${i + 1}. ${n.title}`).join('\n');
  const prompt = `당신은 한국 주식 시장 뉴스 분석가입니다. "${stockName}" 관련 뉴스 ${list.length}건을 각각 분류하세요. 주가 영향이 이미 가격에 반영되었는지를 기준으로 합니다.

[분류 라벨]
- priced_in: 시장이 이미 알고 가격에 반영했을 정보 (이미 발표된 실적·공시·확정 사실)
- not_priced_in: 미래 잠재 이벤트, 새로 부각된 변수, 시장이 아직 충분히 반영하지 못했을 가능성
- neutral: 주가 영향이 미미하거나 일반 정보성 보도

[표현 규칙]
- reason은 한 줄(40자 이내), 추측형. "~로 보임", "~가능성".
- 단정 표현 금지.

[뉴스]
${titles}

[★ 출력]
- 첫 글자는 반드시 [, 마지막 글자는 ].
- 코드펜스(\`\`\`)·머리말·요약 절대 금지.
- 형식: [{"index":1,"impact":"priced_in","reason":"..."}, ...]
- index는 1부터 시작 (위 목록 순서).`;
  const raw = await callGemini(prompt, { model: MODEL, json: true, apiKey });
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    const m = String(raw).match(/\[[\s\S]*\]/);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  }
  if (!Array.isArray(parsed)) return [];
  const VALID = new Set(['priced_in', 'not_priced_in', 'neutral']);
  const FORBIDDEN = /(반드시|확실히|보장|무조건)/;
  return parsed
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      index:  Number(x.index) || 0,
      impact: VALID.has(x.impact) ? x.impact : 'neutral',
      reason: FORBIDDEN.test(String(x.reason || '')) ? '' : String(x.reason || '').trim().slice(0, 80),
    }))
    .filter(x => x.index >= 1 && x.index <= list.length);
}

module.exports = { explainStock, streamExplainStock, parseExplainRaw, recommendConfig, classifyCategory, classifyAndCheck, classifyNewsImpact, MODEL, PRO_MODEL };
