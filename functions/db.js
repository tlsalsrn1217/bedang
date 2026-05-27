/**
 * db.js — Firestore 추상 레이어
 *
 * uid 있음 → userData/{uid}/stocks, userData/{uid}/settings, ...
 * uid 없음 → appData/stocks, appData/settings, ...  (비로그인 공용)
 */

const { getFirestore } = require('firebase-admin/firestore');

function docPath(uid, key) {
  return uid ? `userData/${uid}/data/${key}` : `appData/${key}`;
}
function explColl(uid) {
  return uid ? `userData/${uid}/explanations` : 'explanations';
}
function qualColl(uid) {
  return uid ? `userData/${uid}/qualitative` : 'qualitative';
}

// undefined 제거 (Firestore는 undefined 불허)
function clean(val) {
  return JSON.parse(JSON.stringify(val === undefined ? null : val));
}

async function load(uid = null) {
  const db = getFirestore();
  const [stocksSnap, settingsSnap, metaSnap, explanationsSnap] = await Promise.all([
    db.doc(docPath(uid, 'stocks')).get(),
    db.doc(docPath(uid, 'settings')).get(),
    db.doc(docPath(uid, 'meta')).get(),
    db.collection(explColl(uid)).get(),
  ]);

  const explanations = {};
  explanationsSnap.docs.forEach(d => { explanations[d.id] = d.data(); });

  return {
    stocks:      stocksSnap.exists    ? stocksSnap.data().items               : [],
    settings:    settingsSnap.exists  ? settingsSnap.data()                   : { sectorMultipliers: {} },
    lastRefresh: metaSnap.exists      ? (metaSnap.data().lastRefresh || null)  : null,
    holdings:    metaSnap.exists      ? (metaSnap.data().holdings    || [])    : [],
    explanations,
  };
}

/**
 * 변경된 키만 전달 → 해당 문서만 쓰임
 *   save({ stocks: [...] }, uid)       → userData/{uid}/stocks 만
 *   save({ lastRefresh: '...' }, uid)  → userData/{uid}/meta 만
 */
async function save(data, uid = null) {
  const db = getFirestore();
  const batch = db.batch();
  let hasBatch = false;

  if (data.stocks !== undefined) {
    batch.set(db.doc(docPath(uid, 'stocks')), { items: clean(data.stocks) });
    hasBatch = true;
  }
  if (data.settings !== undefined) {
    batch.set(db.doc(docPath(uid, 'settings')), clean(data.settings));
    hasBatch = true;
  }
  if (data.lastRefresh !== undefined || data.holdings !== undefined) {
    const metaData = {};
    if (data.lastRefresh !== undefined) metaData.lastRefresh = clean(data.lastRefresh);
    if (data.holdings    !== undefined) metaData.holdings    = clean(data.holdings);
    batch.set(db.doc(docPath(uid, 'meta')), metaData, { merge: true });
    hasBatch = true;
  }

  if (hasBatch) await batch.commit();

  if (data.explanations !== undefined) {
    const writes = Object.entries(data.explanations).map(([name, expl]) =>
      db.collection(explColl(uid)).doc(name).set(clean(expl))
    );
    await Promise.all(writes);
  }
}

// ── 정성 분석 레이어 단건 I/O (점수 파이프라인과 무관, 모달 진입 시에만 호출) ──
async function loadQualitative(uid, stockName) {
  const db   = getFirestore();
  const snap = await db.doc(`${qualColl(uid)}/${stockName}`).get();
  return snap.exists ? snap.data() : null;
}

async function saveQualitative(uid, stockName, data) {
  const db = getFirestore();
  await db.doc(`${qualColl(uid)}/${stockName}`).set(clean(data));
}

/**
 * 정성 분석 일괄 조회 — 랭킹 표 아이콘용.
 * 반환: { [stockName]: { premiumTag, at } } — 표 행 아이콘에 필요한 최소 필드만.
 */
async function loadAllQualitative(uid) {
  const db   = getFirestore();
  const snap = await db.collection(qualColl(uid)).get();
  const out  = {};
  snap.docs.forEach(d => {
    const data = d.data();
    const tag  = data?.result?.premiumTag;
    if (tag && tag !== 'none') {
      out[d.id] = { premiumTag: tag, at: data.at || null };
    }
  });
  return out;
}

// ── 시장·업종 기준선 (전 사용자 공유, appData 단건) ─────────────
async function loadBaseline() {
  const db   = getFirestore();
  const snap = await db.doc('appData/baseline').get();
  return snap.exists ? snap.data() : null;
}

async function saveBaseline(data) {
  const db = getFirestore();
  await db.doc('appData/baseline').set(clean(data));
}

module.exports = { load, save, loadQualitative, saveQualitative, loadAllQualitative, loadBaseline, saveBaseline };
