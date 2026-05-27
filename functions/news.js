/**
 * news.js — 뉴스 수집·필터·랭킹 (정성 레이어 보조)
 * ------------------------------------------------------------------
 * 원칙:
 *  - AI 자의 판단 금지: 매체 신뢰도는 도메인/매체명 화이트리스트, 이슈 유형은
 *    제목 키워드 매칭. AI 분류는 별도 라우트(/api/news-classify)에서만.
 *  - 전문 복제 금지: 제목 + 출처 + 날짜 + 링크만.
 *  - 공개 RSS / 공식 API만 사용 (Google News RSS, Naver Search API).
 *
 * 등급 분류:
 *  1 — 통신사, 주요 경제지·종합지, 공시(DART), 공영방송
 *  2 — 일반 종합·전문지
 *  3 — 미분류 (블로그/커뮤니티/출처 불명 포함)
 *
 * 이슈 유형 키워드 — 제목 매칭. 한 기사에 다중 태그 가능.
 */

// ── 등급 테이블 (도메인 → 등급) ────────────────────────────────
const TIER_BY_DOMAIN = {
  // 1등급 — 통신사 / 주요 경제지 / 공영방송 / 공시
  'yna.co.kr':            1, 'yonhapnews.co.kr':     1,
  'newsis.com':           1, 'infomax.co.kr':        1,
  'hankyung.com':         1, 'mk.co.kr':             1,
  'sedaily.com':          1, 'chosunbiz.com':        1,
  'biz.chosun.com':       1, 'chosun.com':           1,
  'joongang.co.kr':       1, 'donga.com':            1,
  'heraldcorp.com':       1, 'biz.heraldcorp.com':   1,
  'mt.co.kr':             1, // 머니투데이 (대형 경제지 — 사용자 판단에 따라 1)
  'kbs.co.kr':            1, 'imnews.imbc.com':      1,
  'mbc.co.kr':            1, 'sbs.co.kr':            1,
  'news.sbs.co.kr':       1, 'ytn.co.kr':            1,
  'dart.fss.or.kr':       1, // 공시
  // 2등급 — 일반 종합·전문지
  'edaily.co.kr':         2,
  'asiae.co.kr':          2, 'fnnews.com':           2,
  'dailian.co.kr':        2, 'news1.kr':             2,
  'newsway.co.kr':        2, 'newdaily.co.kr':       2,
  'etoday.co.kr':         2, 'newstomato.com':       2,
  'ekn.kr':               2, 'businesspost.co.kr':   2,
  'thebell.co.kr':        2, 'investchosun.com':     2,
  'etnews.com':           2, 'zdnet.co.kr':          2,
  'dailypharm.com':       2,
  'fortune-korea.com':    2,
  'theguru.co.kr':        2,
  'datanet.co.kr':        2,
  'segye.com':            2, 'munhwa.com':           2,
  'hankookilbo.com':      2,
};

// ── 등급 테이블 (매체명 → 등급) ── 한국어·영문 별칭 함께. Google RSS <source> 매칭용.
const TIER_BY_NAME = {
  // 1등급 — 통신사
  '연합뉴스': 1, 'Yonhap News': 1, 'Yonhap News Agency': 1, 'Yonhap': 1,
  '뉴시스': 1, 'Newsis': 1,
  '연합인포맥스': 1, 'Yonhap Infomax': 1,
  // 1등급 — 주요 경제지
  '한국경제': 1, '한국경제신문': 1, 'Korea Economic Daily': 1, 'The Korea Economic Daily': 1, 'Hankyung': 1,
  '매일경제': 1, 'Maeil Business': 1, 'Maeil Business Newspaper': 1, 'MK': 1, 'mk.co.kr': 1,
  '서울경제': 1, 'Seoul Economic Daily': 1, 'Sedaily': 1,
  '조선비즈': 1, 'Chosun Biz': 1, 'ChosunBiz': 1,
  '헤럴드경제': 1, 'Herald Economy': 1, 'Heraldcorp': 1,
  '머니투데이': 1, 'Money Today': 1, 'MoneyToday': 1,
  // 1등급 — 주요 종합지
  '조선일보': 1, 'Chosun Ilbo': 1, 'The Chosun Daily': 1,
  '중앙일보': 1, 'JoongAng Ilbo': 1, 'The JoongAng': 1, 'Korea JoongAng Daily': 1,
  '동아일보': 1, 'Dong-A Ilbo': 1, 'The Dong-A Ilbo': 1,
  '한겨레': 2, '한겨레신문': 2, 'Hankyoreh': 2, 'The Hankyoreh': 2,
  '경향신문': 2, 'Kyunghyang Shinmun': 2,
  // 1등급 — 공영방송·통신
  'KBS': 1, 'KBS World': 1, 'KBS 뉴스': 1,
  'MBC': 1, 'MBC 뉴스': 1, 'iMBC': 1,
  'SBS': 1, 'SBS News': 1, 'SBS 뉴스': 1,
  'YTN': 1, 'YTN 뉴스': 1,
  '한국경제TV': 1, 'Korea Economic TV': 1,
  'MBN': 1, '매일방송': 1,
  '연합뉴스TV': 1, 'Yonhap News TV': 1,
  // 1등급 — 공시·당국
  '금융감독원': 1, '금감원': 1, '한국거래소': 1, 'DART': 1, '전자공시': 1,
  // 2등급 — 일반 경제지
  '이데일리': 2, 'Edaily': 2, 'eDaily': 2,
  '아시아경제': 2, 'Asia Economy': 2, 'Asiae': 2,
  '파이낸셜뉴스': 2, 'Financial News': 2,
  '데일리안': 2, 'Daily An': 2, 'Dailian': 2,
  '뉴스1': 2, 'News1': 2, 'News 1': 2,
  '뉴스웨이': 2, 'Newsway': 2,
  '뉴데일리': 2, 'New Daily': 2,
  '이투데이': 2, 'Etoday': 2,
  '뉴스토마토': 2, 'Newstomato': 2,
  '에너지경제': 2, 'Energy Economy': 2, 'EKN': 2,
  '비즈니스포스트': 2, 'Business Post': 2, 'BusinessPost': 2,
  '더벨': 2, 'TheBell': 2, 'The Bell': 2,
  '인베스트조선': 2, 'Invest Chosun': 2,
  '전자신문': 2, 'ETNews': 2, 'Electronic Times': 2,
  'ZDNet Korea': 2, 'ZDNet': 2,
  '데일리팜': 2, 'Daily Pharm': 2,
  '브릿지경제': 2, 'Bridge Economy': 2,
  '머니S': 2, 'MoneyS': 2,
  '포춘코리아': 2, 'Fortune Korea': 2,
  '글로벌이코노믹': 2, 'Global Economic': 2,
  // 2등급 — 일반 종합지
  '세계일보': 2, 'Segye Ilbo': 2,
  '문화일보': 2, 'Munhwa Ilbo': 2,
  '한국일보': 2, 'Hankook Ilbo': 2, 'The Korea Times': 2,
  '코리아헤럴드': 2, 'The Korea Herald': 2, 'Korea Herald': 2,
};

// ── 이슈 유형 키워드 (제목 매칭) ──────────────────────────────
const ISSUE_TYPES = {
  '실적':         /(실적|영업이익|매출|순이익|어닝|분기|당기순|영업손실|적자|흑자|어닝쇼크|어닝서프라이즈)/,
  'M&A':         /(인수|합병|지분 (?:매입|매각|취득|확보)|M&A|매각|출자|증자|상장|IPO|스핀오프|분할)/,
  '신사업':       /(신사업|진출|런칭|출시|신규 (?:공장|진출|투자)|확장|진입|개시|착공)/,
  '배당·주주환원': /(배당|자사주|주주환원|DPS|배당금|배당률|소각|환원|자기주식)/,
  '규제·소송':    /(규제|소송|제재|벌금|당국|조사|검찰|공정위|금감원|국세청|적발|위반|과징금|영업정지)/,
  '경영진':       /(대표이사|CEO|회장|사장|임원|선임|사임|취임|내정|교체|퇴진|등기)/,
};

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
}

function _tierByDomain(url) {
  const dom = domainOf(url);
  if (!dom) return null;
  if (TIER_BY_DOMAIN[dom]) return TIER_BY_DOMAIN[dom];
  // 서브도메인이면 root 도메인(예: biz.chosun.com → chosun.com)으로 한 번 더 시도
  const parts = dom.split('.');
  if (parts.length > 2) {
    const root = parts.slice(-2).join('.');
    if (TIER_BY_DOMAIN[root]) return TIER_BY_DOMAIN[root];
  }
  return null;
}
function tierOf(source, url, sourceUrl) {
  // 1) source가 들고 있는 원본 URL(가능 시) → 2) 기사 link → 3) 매체명 매칭 순
  for (const u of [sourceUrl, url]) {
    const t = u ? _tierByDomain(u) : null;
    if (t) return t;
  }
  if (source) {
    for (const [name, tier] of Object.entries(TIER_BY_NAME)) {
      if (source.includes(name)) return tier;
    }
  }
  // 미분류 — 추후 매핑 보강용 진단 로그(1줄)
  if (process.env.NEWS_DEBUG_UNKNOWN === '1') {
    console.warn('[news] unknown tier', { source, url, sourceUrl, dom: domainOf(sourceUrl || url) });
  }
  return 3;
}

function detectTypes(title) {
  const out = [];
  for (const [type, re] of Object.entries(ISSUE_TYPES)) {
    if (re.test(title)) out.push(type);
  }
  return out;
}

function domainToSource(url) {
  const dom = domainOf(url);
  // domain → 매체명 (UI에 source 비어있을 때만 사용)
  const D2N = {
    'hankyung.com':'한국경제','mk.co.kr':'매일경제','chosun.com':'조선일보','chosunbiz.com':'조선비즈',
    'biz.chosun.com':'조선비즈','yna.co.kr':'연합뉴스','yonhapnews.co.kr':'연합뉴스',
    'newsis.com':'뉴시스','infomax.co.kr':'연합인포맥스','heraldcorp.com':'헤럴드경제',
    'biz.heraldcorp.com':'헤럴드경제','sedaily.com':'서울경제','edaily.co.kr':'이데일리',
    'mt.co.kr':'머니투데이','asiae.co.kr':'아시아경제','fnnews.com':'파이낸셜뉴스',
    'dailian.co.kr':'데일리안','kbs.co.kr':'KBS','imnews.imbc.com':'MBC','mbc.co.kr':'MBC',
    'sbs.co.kr':'SBS','news.sbs.co.kr':'SBS','ytn.co.kr':'YTN','news1.kr':'뉴스1',
    'donga.com':'동아일보','joongang.co.kr':'중앙일보','dart.fss.or.kr':'금융감독원',
    'etnews.com':'전자신문','thebell.co.kr':'더벨','businesspost.co.kr':'비즈니스포스트',
  };
  return D2N[dom] || '';
}

// ── 기간 필터 ──────────────────────────────────────────────────
function periodMs(period) {
  return ({ '7d': 7, '30d': 30, '90d': 90, '365d': 365 })[period]
    ? ({ '7d': 7, '30d': 30, '90d': 90, '365d': 365 })[period] * 86400000
    : Infinity; // 'all' 또는 미지정
}

// ── 구글 RSS 수집 ───────────────────────────────────────────────
async function fetchGoogleItems(stockName) {
  const q   = encodeURIComponent(`${stockName} 주식`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
  const r   = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const re  = /<item>([\s\S]*?)<\/item>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null && out.length < 30) {
    const t   = m[1];
    const get = tag => {
      const x = t.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
    };
    const linkM     = t.match(/<link[^/]?\/?>\s*(https?:\/\/[^\s<]+)/);
    const link      = linkM ? linkM[1].trim() : get('guid');
    const title     = get('title');
    const pubDate   = get('pubDate');
    // Google RSS의 <source url="https://원본매체.com">매체명</source> — url 속성에 원본 도메인이 들어있음
    const srcAttrM  = t.match(/<source[^>]*url="([^"]+)"/i);
    const sourceUrl = srcAttrM ? srcAttrM[1] : '';
    const source    = get('source') || domainToSource(sourceUrl || link);
    if (title && link) out.push({ title, link, pubDate, source, sourceUrl, via: 'google',
      ts: pubDate ? new Date(pubDate).getTime() : 0 });
  }
  return out;
}

// ── 네이버 검색 API 수집 ────────────────────────────────────────
async function fetchNaverItems(stockName) {
  const id     = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return [];
  const q   = encodeURIComponent(`${stockName} 주식`);
  const url = `https://openapi.naver.com/v1/search/news.json?query=${q}&display=30&sort=date`;
  const r   = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || []).map(item => {
    const title = item.title
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
    const link = item.originallink || item.link;
    return { title, link, pubDate: item.pubDate, source: domainToSource(link), via: 'naver',
      ts: item.pubDate ? new Date(item.pubDate).getTime() : 0 };
  });
}

/**
 * 통합 검색 — UI 옵션을 적용해 필터링·정렬·랭킹
 *  opts:
 *    platforms:   ['naver','google']   (기본 둘 다)
 *    period:      '7d'|'30d'|'90d'|'365d'|'all'   (기본 30d)
 *    maxTier:     1|2|3                  (보여줄 최대 등급, 기본 2)
 *    types:       ['배당·주주환원',...]  (필터, 비어있으면 전체)
 *    sort:        'recent'|'trust'       (기본 recent)
 *    limit:       반환 개수 (기본 12)
 */
async function searchNews(stockName, opts = {}) {
  const platforms = Array.isArray(opts.platforms) && opts.platforms.length ? opts.platforms : ['naver', 'google'];
  const period    = opts.period   || '30d';
  const maxTier   = [1, 2, 3].includes(Number(opts.maxTier)) ? Number(opts.maxTier) : 2;
  const types     = Array.isArray(opts.types) ? opts.types.filter(Boolean) : [];
  const sort      = opts.sort === 'trust' ? 'trust' : 'recent';
  const limit     = Math.min(Math.max(Number(opts.limit) || 12, 1), 30);

  const tasks = [];
  if (platforms.includes('naver'))  tasks.push(fetchNaverItems(stockName).catch(() => []));
  if (platforms.includes('google')) tasks.push(fetchGoogleItems(stockName).catch(() => []));
  const groups = await Promise.all(tasks);
  let merged = groups.flat();

  // 제목 정규화 dedup
  const norm = s => s.toLowerCase().replace(/\s+/g, '').replace(/[^\w가-힣]/g, '');
  const seen = new Set();
  merged = merged.filter(n => {
    const k = norm(n.title);
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });

  // 등급·유형 부가 (Google 항목은 sourceUrl 속성도 활용)
  merged = merged.map(n => ({
    ...n,
    tier:  tierOf(n.source, n.link, n.sourceUrl),
    types: detectTypes(n.title),
  }));

  // 기간 필터
  const cutoff = Date.now() - periodMs(period);
  merged = merged.filter(n => n.ts === 0 || n.ts >= cutoff);

  // 등급 필터
  merged = merged.filter(n => n.tier <= maxTier);

  // 유형 필터 (선택된 유형이 하나라도 매칭되면 포함)
  if (types.length > 0) {
    merged = merged.filter(n => n.types.some(t => types.includes(t)));
  }

  // 정렬
  if (sort === 'trust') {
    merged.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;        // 낮은 등급 숫자 = 높은 신뢰
      return b.ts - a.ts;
    });
  } else {
    const oneDayMs = 86400000;
    const now      = Date.now();
    merged.sort((a, b) => {
      const aT = (now - a.ts) < oneDayMs ? 0 : 1;
      const bT = (now - b.ts) < oneDayMs ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return b.ts - a.ts;
    });
  }

  return merged.slice(0, limit).map(({ ts, sourceUrl, ...n }) => n);
}

module.exports = { searchNews, tierOf, detectTypes, ISSUE_TYPES };
