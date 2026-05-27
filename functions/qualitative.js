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
  const codeStr = stock.code ? `(종목코드 ${stock.code})` : '';
  return `당신은 한국 주식 시장 정성 분석가입니다. 오늘(${today}) Google 검색으로 최근 6개월 이내의 구체적 뉴스·공시를 조사한 뒤, 정량 점수가 놓칠 수 있는 맥락만 별도 레이어로 분석합니다.

[종목] ${stock.name} ${codeStr} (${stock.category} / ${ind})
[정량 점수] ${stock.score}/100 — 이미 결정된 값. 평가·수정 금지.
[밸류 세부] ${stock.breakdown?.value ?? '-'} (낮을수록 동종 대비 비쌈)
[시장지표] PER ${stock.per} · PBR ${stock.pbr} · ROE ${stock.roe}%

[분석 절차]
1. "${stock.name}" ${codeStr ? '및 종목코드 ' + stock.code : ''}로 최근 6개월 한국어 뉴스/공시 검색.
2. 검색 결과 정보가 부족하더라도 반드시 유효한 JSON 객체를 반환하세요. 정보 부족 시 premiumTag="none", contextNote에는 "정량 지표 외 특이 맥락이 검색되지 않음" 류로 기재.
3. 구체적 뉴스/공시 근거가 있을 때만 premiumTag를 none 외 값으로.

[태그 정의]
- growth_expectation: 비상장 자산·신사업·구조적 성장 기대가 현재 PER/PBR에 미반영.
- simple_overvalued: 비싸지만 뚜렷한 미래 호재 뉴스 없음.
- temp_profit_dip: 이익 일시 급감으로 PER 왜곡, 회복 시사 사실 존재.
- hidden_asset: 본업 외 보유 자산이 크고 자산가치가 점수에 가려짐.
- none: 정량 외 특이 맥락 없음.

[표현 규칙]
- 단정 표현("반드시 오른다", "확실히", "지금이 기회", "보장", "무조건") 사용 시 분석 폐기.
- 추측형만 허용: "~로 기대됨", "~가능성이 거론됨".
- 태그 부여 시 risks에 반드시 반대 시나리오.

[★ 출력 형식 — 절대 규칙]
- 응답의 첫 문자는 반드시 "{" 입니다.
- 응답의 마지막 문자는 반드시 "}" 입니다.
- JSON 앞뒤에 인사말·요약·머리말·코드펜스(\`\`\`)·설명 절대 금지.
- 마크다운 기호(#, *, -, \`, >) 금지.
- 모든 문자열은 큰따옴표로 감쌉니다.

[JSON 스키마]
{
  "contextNote": "맥락 1~2문장(추측형). 정보 부족 시 '정량 지표 외 특이 맥락이 최근 6개월 내 검색되지 않음.'",
  "premiumTag": "growth_expectation | simple_overvalued | temp_profit_dip | hidden_asset | none",
  "tagReason": "태그 근거 사실(날짜·핵심). none이면 빈 문자열.",
  "risks": "반대 시나리오. none이면 빈 문자열.",
  "disclaimer": "${DEFAULT_DISCLAIMER}",
  "sources": [{"title": "기사/공시 제목", "url": "https://...", "date": "YYYY-MM-DD"}],
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
    generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(35000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  const finishReason = cand?.finishReason || '';
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const groundingSources = chunks
    .filter(c => c && c.web)
    .map(c => ({ title: (c.web.title || '').trim(), url: c.web.uri || '' }))
    .filter(s => s.url && s.title);
  return { text, groundingSources, finishReason };
}

/**
 * 그라운딩 응답은 ```json 펜스·인용 마커·트레일링 텍스트가 흔해
 * 단순 JSON.parse는 자주 실패한다. 견고한 추출:
 *   1) 코드 펜스 제거
 *   2) 첫 { ~ 마지막 } 추출
 *   3) 트레일링 comma 보정
 */
function parseQualRaw(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const body = s.slice(first, last + 1);
  try { return JSON.parse(body); } catch (_) {}
  try { return JSON.parse(body.replace(/,(\s*[}\]])/g, '$1')); } catch (_) {}
  return null;
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
  const { text, groundingSources, finishReason } = await callGeminiGrounded(buildQualitativePrompt(stock), apiKey);
  const parsed = parseQualRaw(text);

  // 파싱 실패 시 — 진단 로깅 후, 그라운딩 출처가 있으면 그것으로 degraded 결과 구성
  if (!parsed || typeof parsed !== 'object') {
    console.error('[qualitative] parse failed', {
      stock:           stock.name,
      finishReason,
      textLen:         text.length,
      textHead:        text.slice(0, 300),
      groundingCount:  groundingSources.length,
    });
    const note = finishReason === 'MAX_TOKENS'
      ? '응답이 길어 잘렸습니다 (토큰 한도). ↻ 재분석하면 다시 시도합니다.'
      : groundingSources.length > 0
        ? '관련 뉴스는 찾았으나 구조화된 분석을 생성하지 못했습니다. 아래 출처를 직접 참고하세요.'
        : `"${stock.name}"에 대한 최근 6개월 한국어 뉴스/공시 정보가 부족해 정성 분석이 어렵습니다.`;
    return applyGuards({
      contextNote: note,
      premiumTag:  'none',
      sources:     groundingSources.slice(0, 5).map(g => ({ title: g.title, url: g.url, date: '' })),
    });
  }

  // 그라운딩 메타의 실제 (title, url) 페어로 sources 대체 — 모델 date는 보존 시도
  if (groundingSources.length > 0) {
    const dateByTitle = {};
    for (const s of parsed.sources || []) {
      if (s && s.title && s.date) dateByTitle[s.title.trim()] = s.date;
    }
    parsed.sources = groundingSources.slice(0, 5).map(g => ({
      title: g.title,
      url:   g.url,
      date:  dateByTitle[g.title] || '',
    }));
  }

  return applyGuards(parsed);
}

module.exports = { analyzeQualitative, applyGuards, DEFAULT_DISCLAIMER, VALID_TAGS };
