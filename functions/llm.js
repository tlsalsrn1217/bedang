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

/* ── (1) 종목 해설 프롬프트 — 지표·점수 근거 전용 ── */
function buildExplainPrompt(stock) {
  const b = stock.breakdown;
  const pct = (v) => v != null ? (v * 100).toFixed(2) + '%' : '-';
  return `당신은 배당주 점수 모델 해설가입니다.
아래 종목의 정량 지표와 각 세부 점수가 왜 그 값인지 초보 투자자에게 쉬운 한국어로 설명하세요.
외부 뉴스·예측·시황은 언급하지 마세요. 제공된 수치만 근거로 삼으세요.

[종목] ${stock.name} (${stock.category})
[종합점수] ${stock.score}/100 = 기본점수 ${stock.baseScore} × 섹터승수 ${stock.multiplier}
[세부점수] 밸류 ${b.value} / 수익성 ${b.profit} / 배당매력 ${b.yield} / 배당지속성 ${b.durability} / 성장 ${b.growth} / 유동성 ${b.liquidity}
[시장지표] PER ${stock.per} · PBR ${stock.pbr} · ROE ${stock.roe}% · 배당성향 ${stock.payout}%
[배당지표] 배당률 ${pct(stock.divYield)} · 4년평균배당률 ${pct(stock.avgYield)} · 전년DPS ${stock.prevDps ?? '-'}원 · 4년평균DPS ${stock.avgDps ? Math.round(stock.avgDps) : '-'}원
[경고] ${stock.flags && stock.flags.length ? stock.flags.join(', ') : '없음'}

반드시 아래 JSON 형식만 출력하세요. 마크다운 기호(#, *, -, \`, > 등) 절대 사용 금지. 순수 JSON만.
{"summary":"종합점수 근거 한줄평 (1~2문장)","score_reason":"세부 점수 중 높거나 낮은 항목의 근거 설명 (2~3문장)","risks":"경고·주의 지표 해설 및 투자 시 주의사항 (없으면 '특이 경고 없음')","checkpoints":"이 종목 투자 전 직접 확인해야 할 체크리스트 2~3가지"}`;
}

/* ── (1-a) 해설 생성 — JSON 모드, 그라운딩 없음 ── */
async function explainStock(stock, apiKey) {
  const raw = await callGemini(buildExplainPrompt(stock), { json: true, apiKey });
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

module.exports = { explainStock, streamExplainStock, parseExplainRaw, recommendConfig, classifyCategory, classifyAndCheck, MODEL, PRO_MODEL };
