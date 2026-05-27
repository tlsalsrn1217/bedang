/**
 * qualitative.js — 정성 분석 레이어 (점수와 완전 분리)
 * ------------------------------------------------------------------
 * 정량 점수(scoring.js)에 절대 개입하지 않는다.
 * 정량 점수가 놓치는 "미래 기대·시장 이슈"를 Gemini 그라운딩으로 수집해
 * 별도 레이어로 반환한다. (예: 미래에셋의 SpaceX 비상장 자산)
 *
 * 출력 스키마:
 *   {
 *     contextNote: 정량 점수가 놓친 맥락 (추측형, 1~2문장)
 *     premiumTag:  growth_expectation | simple_overvalued | temp_profit_dip | hidden_asset | none
 *     tagReason:   태그의 구체적 근거 사실
 *     risks:       반대 시나리오 (태그 부여 시 필수)
 *     disclaimer:  사용자 환기 문구
 *     sources:     [{ title, url, date }]
 *     asOf:        분석 기준일
 *   }
 *
 * 가드:
 *   1) sources 없으면 → tag를 강제로 "none"
 *   2) 단정 표현(반드시/확실히/지금이 기회/보장 등) 감지 → 보수적 다운그레이드
 *   3) disclaimer 누락 시 기본 문구로 채움
 */

const QUAL_MODEL = 'gemini-2.5-flash';

const DEFAULT_DISCLAIMER =
  '이는 시장 기대이며 실현을 보장하지 않습니다. 기대가 이미 주가에 반영되어 있을 수 있습니다(고점 매수 주의).';

const FORBIDDEN_RE =
  /(반드시\s*오른다|확실히\s*오른다|지금이\s*기회|반드시\s*상승|틀림없이|보장합니다|확정적|무조건|급등 확정)/;

const VALID_TAGS = new Set([
  'growth_expectation',
  'simple_overvalued',
  'temp_profit_dip',
  'hidden_asset',
  'none',
]);

function buildQualitativePrompt(stock) {
  const today = new Date().toISOString().slice(0, 10);
  const ind   = stock.industry || stock.sector || stock.category;
  return `당신은 한국 주식 시장 정성 분석가입니다. 오늘(${today}) Google 검색으로 최근 6개월 이내의 구체적 뉴스·공시를 조사한 뒤, 정량 점수가 놓칠 수 있는 맥락만 별도 레이어로 분석하세요. 정량 점수 자체를 평가하거나 수정하려 하지 마세요.

[종목] ${stock.name} (${stock.category} / ${ind})
[정량 점수] ${stock.score}/100 — 이 점수는 이미 결정되었습니다. 당신은 점수가 놓친 맥락만 본다.
[밸류 세부] ${stock.breakdown?.value ?? '-'} (낮을수록 동종 대비 비쌈)
[시장지표] PER ${stock.per} · PBR ${stock.pbr} · ROE ${stock.roe}%

[분석 절차]
1. ${stock.name}에 대한 최근 6개월 이내 한국어 뉴스/공시를 Google 검색으로 조사.
2. 구체적 사실(뉴스 제목·출처·날짜)이 존재하는 경우에만 premiumTag를 부여.
3. 구체적 근거가 없으면 반드시 premiumTag="none". 일반론·추측만으로 태그 부여 금지.

[태그 정의]
- growth_expectation: 비상장 자산(자회사 지분 등)·신사업·구조적 성장 기대가 현재 PER/PBR에 미반영. 시장이 선반영 중일 수 있음.
- simple_overvalued: 비싸지만 뚜렷한 미래 호재 뉴스 없음. 점수대로 신중.
- temp_profit_dip: 이익이 일시적으로 급감해 PER이 왜곡됨. 회복 가능성을 시사하는 구체적 사실 존재.
- hidden_asset: 본업 외 보유 자산(부동산·지분) 가치가 큼. 자산 저평가가 점수에 가려짐.
- none: 정량 외 특이 맥락이 검색되지 않음.

[표현 규칙 — 위반 시 분석은 폐기됩니다]
- 단정 표현 금지: "반드시 오른다", "확실히", "지금이 기회", "보장", "무조건" 사용 시 폐기.
- 추측형만 허용: "~로 기대됨", "~가능성이 거론됨", "시장은 ~로 보는 것으로 풀이됨".
- 태그를 부여하면 risks 필드에 반드시 반대 시나리오(태그가 무산될 경우)를 작성.
- 사실 없이 일반론·감(感) 금지. 모든 진술은 sources의 구체적 뉴스/공시에 근거.

[출력 — 순수 JSON. 마크다운 기호(#, *, -, \`) 금지]
{
  "contextNote": "정량 점수가 놓친 맥락 1~2문장(추측형). 'none'이면 '정량 지표 외 특이 맥락이 최근 6개월 내 검색되지 않음.'",
  "premiumTag": "growth_expectation | simple_overvalued | temp_profit_dip | hidden_asset | none",
  "tagReason": "태그의 구체적 근거 사실(어떤 뉴스/공시 — 날짜·핵심 내용). none이면 빈 문자열.",
  "risks": "맥락이 무산될 시나리오(태그 부여 시 필수). none이면 빈 문자열.",
  "disclaimer": "${DEFAULT_DISCLAIMER}",
  "sources": [
    {"title": "기사/공시 제목", "url": "https://...", "date": "YYYY-MM-DD"}
  ],
  "asOf": "${today}"
}`;
}

async function callGeminiGrounded(prompt, apiKey) {
  apiKey = apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${QUAL_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools:    [{ googleSearch: {} }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

function parseQualRaw(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  }
  return parsed;
}

/**
 * 가드 적용: 정성 레이어가 점수를 덮어쓰지 않도록 보수적으로 다운그레이드
 */
function applyGuards(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      contextNote: '정성 분석 결과를 파싱하지 못했습니다.',
      premiumTag:  'none',
      tagReason:   '',
      risks:       '',
      disclaimer:  DEFAULT_DISCLAIMER,
      sources:     [],
      asOf:        new Date().toISOString().slice(0, 10),
    };
  }

  if (!VALID_TAGS.has(parsed.premiumTag)) parsed.premiumTag = 'none';
  if (!Array.isArray(parsed.sources))     parsed.sources    = [];

  parsed.sources = parsed.sources
    .filter(s => s && typeof s === 'object' && s.url && s.title)
    .slice(0, 5);

  if (parsed.sources.length === 0 && parsed.premiumTag !== 'none') {
    parsed.premiumTag = 'none';
    parsed.tagReason  = '';
    parsed.risks      = '';
    parsed.contextNote = parsed.contextNote ||
      '근거 뉴스가 확인되지 않아 정량 지표 외 특이 맥락을 단정할 수 없음.';
  }

  const allText = [parsed.contextNote, parsed.tagReason, parsed.risks].join(' ');
  if (FORBIDDEN_RE.test(allText)) {
    parsed.premiumTag  = 'none';
    parsed.tagReason   = '';
    parsed.risks       = '';
    parsed.contextNote = '단정 표현이 감지되어 정성 태그를 보수적으로 제거함.';
  }

  if (!parsed.disclaimer) parsed.disclaimer = DEFAULT_DISCLAIMER;

  parsed.contextNote = String(parsed.contextNote || '').trim();
  parsed.tagReason   = String(parsed.tagReason   || '').trim();
  parsed.risks       = String(parsed.risks       || '').trim();
  parsed.asOf        = parsed.asOf || new Date().toISOString().slice(0, 10);

  return parsed;
}

async function analyzeQualitative(stock, apiKey) {
  const raw    = await callGeminiGrounded(buildQualitativePrompt(stock), apiKey);
  const parsed = parseQualRaw(raw);
  return applyGuards(parsed);
}

module.exports = { analyzeQualitative, applyGuards, DEFAULT_DISCLAIMER, VALID_TAGS };
