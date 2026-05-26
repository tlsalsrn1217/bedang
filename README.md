# 배당주 종합 점수 대시보드

엑셀 `투자지침판`을 재현한 웹앱. 실시간 크롤링 + 카테고리별 멀티팩터 점수 + Gemini 해설 + 수익 계산기.

## 빠른 시작

### 1) 프론트엔드만 미리보기 (백엔드 불필요)
```bash
# frontend/index.html 을 브라우저로 열기만 하면 됨.
# 인라인 시드 데이터로 점수표·모달·계산기가 즉시 작동.
open frontend/index.html
```

### 2) 백엔드 연결 (실시간 크롤링 + Gemini 해설)
```bash
cd backend
npm install
cp .env.example .env       # GEMINI_API_KEY 입력
npm start                  # http://localhost:3001
```
그 후 `frontend/index.html`의 fetch 경로(`/api/...`)가 백엔드를 향하도록
같은 호스트에서 서빙하거나 프록시 설정.

## 점수는 어떻게 나오나
`backend/scoring.js` 한 파일에 전부 있습니다. 2층 구조:
1. **카테고리 내 상대평가**(밸류·수익성·배당매력·배당지속성) → 1층 점수
2. **거시 섹터 승수 × + 레드플래그 감점** → 최종 점수

자세한 공식·근거·할 일은 **SPEC.md** 참고.

## Claude Code로 이어서 개발하기
이 폴더를 열고 `SPEC.md`를 먼저 읽게 하세요. 우선순위:
크롤러 셀렉터 보강 → 종목코드 매핑 → (선택)React 전환 → 배포.

## 면책
개인 투자 참고용. 투자 권유 아님. 점수는 미래 수익을 보장하지 않음.
크롤링 데이터는 상업적 재배포 금지.
