// マイ・スイング解析 — 動画から骨格を推定し、スイングの各動作を判定する

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------- 設定（端末内に保存） ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('swing.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('swing.' + k, JSON.stringify(v)); } catch { /* 保存できない環境では無視 */ } },
};

const S = {
  viewPref: 'auto', club: store.get('club', 'dr'), hand: 'R', heightCm: 170, entry: null,
  frames: [], n: 0, dt: 1 / 30, W: 0, H: 0, vw: 0, vh: 0,
  view: null, autoView: null, ph: null, checks: [], score: 0,
  skel: true, path: true, ref: true, rate: 0.25, analyzed: false, fileName: '',
  fcache: new Map(), vizTok: 0, // 解説図用：コマ画像の保存場所と、描き直しの番号
};

const PHASES = [
  { key: 'address', name: 'アドレス', desc: 'アドレス＝ボールに向かって構えた状態。ここでの姿勢がスイング全体の土台になります。' },
  { key: 'takeaway', name: 'テークバック', desc: 'テークバック＝クラブを振り上げ始める動き。軌道の方向がここでほぼ決まります。' },
  { key: 'top', name: 'トップ', desc: 'トップ＝クラブを一番上まで振り上げた位置。体のねじれ（パワーの貯金）が最大になる場面です。' },
  { key: 'downswing', name: 'ダウンスイング', desc: 'ダウンスイング＝トップから振り下ろす動き。切り返し（振り上げ→振り下ろしの切り替え）の順番が重要です。' },
  { key: 'impact', name: 'インパクト', desc: 'インパクト＝ボールに当たる瞬間。アドレスの形に近く、体重が目標側に乗っているのが理想です。' },
  { key: 'finish', name: 'フィニッシュ', desc: 'フィニッシュ＝振り切った最後の姿勢。ここでバランス良く止まれるかで、スイング全体の良し悪しが分かります。' },
];

// ---------- クラブ別の判定基準 ----------
// クラブが長いほど：スタンス広め・前傾浅め・ボールから遠め・トップはフラット・
// インパクトは頭をより後ろに残し、ハンドファーストは弱め（ドライバーはアッパーに打つ）。
// [良いの範囲, 注意の範囲, 目安の文] — 範囲外は「要改善」
const CLUB_NAME = { dr: 'ドライバー', fw: 'FW・UT', ir: 'アイアン', wg: 'ウェッジ' };
const clubName = (c) => CLUB_NAME[c] || 'クラブ未設定';
const CRIT = {
  // 正面：両足首の間隔 ÷ 肩幅
  stance: {
    dr: [[1.15, 1.8], [0.95, 2.05], '肩幅の約1.2〜1.6倍（広めに構えて大きな回転を支える）'],
    fw: [[1.0, 1.65], [0.85, 1.9], '肩幅の約1.0〜1.5倍'],
    ir: [[0.85, 1.45], [0.7, 1.7], '肩幅くらい（約0.9〜1.3倍）'],
    wg: [[0.7, 1.25], [0.55, 1.5], '肩幅よりやや狭め（約0.8〜1.1倍）'],
  },
  // 正面：構えでの肩の傾き（後ろ側の肩が下がる角度）
  tilt: {
    dr: [[7, 20], [3, 25], '約8〜18°（ボールを左足寄りに置くぶん、傾きは大きめ）'],
    fw: [[5, 17], [1, 22], '約6〜15°'],
    ir: [[2, 14], [-1, 20], '約5〜12°'],
    wg: [[0, 10], [-3, 15], '約2〜8°（ほぼ水平に近い）'],
  },
  // 正面：インパクトでの腰の移動（目標方向が＋、身長比）
  shift: {
    dr: [[0.015, 1], [-0.02, 1], '構えより目標方向へ移動（ドライバーはアイアンより控えめでOK）'],
    fw: [[0.02, 1], [-0.015, 1], '構えより目標方向へ移動している'],
    ir: [[0.025, 1], [-0.01, 1], '構えより目標方向へ移動している'],
    wg: [[0.025, 1], [-0.005, 1], '構えより目標方向へしっかり移動している'],
  },
  // 正面：インパクトでの頭の移動（目標方向が＋）
  head: {
    dr: [[-1, 0.015], [-1, 0.04], '構えた位置より後ろ（ボールのかなり後ろに頭を残す）'],
    fw: [[-1, 0.025], [-1, 0.05], '構えた位置か、それより後ろ'],
    ir: [[-1, 0.03], [-1, 0.06], '構えた位置か、それより少し後ろ'],
    wg: [[-1, 0.04], [-1, 0.07], 'ほぼ構えた位置（ボールのほぼ真上）'],
  },
  // 正面：インパクトでの手元の移動（目標方向が＋）
  hands: {
    dr: [[-0.04, 1], [-0.07, 1], '構えとほぼ同じ位置（ドライバーはアッパーに打つので強いハンドファーストは不要）'],
    fw: [[-0.02, 1], [-0.05, 1], '構えと同じか、やや目標方向'],
    ir: [[-0.01, 1], [-0.04, 1], '構えと同じか、それより目標方向（ハンドファースト）'],
    wg: [[0.005, 1], [-0.02, 1], '構えより目標方向（しっかりハンドファースト）'],
  },
  // 後方：前傾角度
  spine: {
    dr: [[25, 42], [18, 50], '約25〜40°（クラブが長いので浅め）'],
    fw: [[28, 45], [20, 52], '約30〜42°'],
    ir: [[30, 48], [22, 56], '約32〜45°'],
    wg: [[33, 52], [25, 58], '約35〜48°（クラブが短いので深め）'],
  },
  // 後方：構えた時の手元の位置（肩よりボール側が＋）
  reach: {
    dr: [[0, 0.12], [-0.03, 0.16], '肩の真下よりやや前（クラブが長いぶんボールから遠め）'],
    fw: [[-0.02, 0.1], [-0.05, 0.14], '肩の真下〜やや前'],
    ir: [[-0.03, 0.09], [-0.06, 0.13], '肩の真下〜やや前（腕が自然に垂れる位置）'],
    wg: [[-0.05, 0.07], [-0.08, 0.11], '肩のほぼ真下（ボールに近め）'],
  },
  // 後方：トップでの手元（肩よりボール側が＋＝アップライト）
  top: {
    dr: [[-0.12, 0.05], [-0.17, 0.1], '後ろ側の肩の上〜やや背中側（ドライバーはややフラット）'],
    fw: [[-0.1, 0.06], [-0.15, 0.11], '後ろ側の肩の上あたり'],
    ir: [[-0.09, 0.07], [-0.14, 0.12], '後ろ側の肩の上あたり'],
    wg: [[-0.07, 0.09], [-0.12, 0.14], '後ろ側の肩の上〜ややボール側（ウェッジはアップライト）'],
  },
  // 後方：振り下ろしの軌道（振り上げより外側が＋）
  path: {
    dr: [[-0.08, 0.02], [-0.12, 0.05], '振り上げより少し内側から（ドライバーはややインサイドアウトでOK）'],
    fw: [[-0.07, 0.02], [-0.11, 0.05], '振り上げより少し内側から下ろす'],
    ir: [[-0.07, 0.02], [-0.11, 0.05], '振り上げより少し内側から下ろす'],
    wg: [[-0.06, 0.025], [-0.1, 0.055], '振り上げとほぼ同じ所を通す'],
  },
};
const crit = (k) => { const c = CRIT[k][S.club] || CRIT[k].ir; return { good: c[0], warn: c[1], ideal: c[2] }; };

// MediaPipe の関節番号
const L = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], [0, 11], [0, 12]];

// 利き打ちに応じて「目標側（リード）」「反対側（トレール）」を割り当て
function sides() {
  const R = S.hand === 'R';
  return {
    leadSh: R ? L.lSh : L.rSh, trailSh: R ? L.rSh : L.lSh,
    leadEl: R ? L.lEl : L.rEl, trailEl: R ? L.rEl : L.lEl,
    leadWr: R ? L.lWr : L.rWr, leadHip: R ? L.lHip : L.rHip, trailHip: R ? L.rHip : L.lHip,
    trailKn: R ? L.rKn : L.lKn, leadAn: R ? L.lAn : L.rAn, trailAn: R ? L.rAn : L.lAn,
    trailHeel: R ? L.rHeel : L.lHeel, trailToe: R ? L.rToe : L.lToe,
    leadName: R ? '左' : '右', trailName: R ? '右' : '左',
  };
}

// ---------- 幾何の小道具 ----------
const P = (i, k) => { const f = S.frames[i]; return { x: f[k * 3], y: f[k * 3 + 1] }; };
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const deg = (r) => r * 180 / Math.PI;
function angleAt(a, b, c) { // b を頂点とする角度
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}
const hand = (i) => mid(P(i, L.lWr), P(i, L.rWr));
const hipM = (i) => mid(P(i, L.lHip), P(i, L.rHip));
const shM = (i) => mid(P(i, L.lSh), P(i, L.rSh));
const ankM = (i) => mid(P(i, L.lAn), P(i, L.rAn));
const spineAngle = (i) => { const h = hipM(i), s = shM(i); return deg(Math.atan2(Math.abs(s.x - h.x), h.y - s.y)); };

// ---------- AIモデル ----------
// Google公式の MediaPipe Pose（骨格推定AI）を公開配信元 jsDelivr から読み込む。
// 読み込むのはプログラムとモデルだけで、動画はこの端末の外に出ない。
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404';
let pose = null, lastResult = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('AIモデルを読み込めませんでした（通信環境を確認してください）'));
    document.head.appendChild(s);
  });
}
async function getPose() {
  if (pose) { pose.reset(); return pose; }
  if (!window.Pose) await loadScript(`${MP_BASE}/pose.js`);
  const p = new window.Pose({ locateFile: (f) => `${MP_BASE}/${f}` });
  p.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  p.onResults((r) => { lastResult = r; });
  await p.initialize();
  pose = p;
  return pose;
}
async function detect(canvas) {
  lastResult = null;
  await pose.send({ image: canvas });
  return lastResult && lastResult.poseLandmarks ? lastResult.poseLandmarks : null;
}

// ---------- 画面部品 ----------
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const msg = (t, err) => { const m = $('#msg'); m.textContent = (S.clipLabel || '') + t; m.className = err ? 'err' : 'note'; };
const bar = (p) => { $('#bar').style.width = Math.round(p * 100) + '%'; };

function segInit(id, cur, onChange) {
  const btns = $$(`#${id} button`);
  const paint = (v) => btns.forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  paint(cur);
  btns.forEach((b) => b.addEventListener('click', () => { paint(b.dataset.v); onChange(b.dataset.v); }));
  return paint;
}
segInit('segView', 'auto', (v) => { S.viewPref = v; if (S.analyzed) { S.view = v === 'auto' ? S.autoView : v; paintView2(S.view); evaluate(); } });
const paintView2 = segInit('segView2', '', (v) => { if (S.multi && S.multi.mixed) return; S.view = v; evaluate(); });
// クラブ（入力欄と結果欄の2か所。どちらで変えても両方そろえる）
let paintClub = () => {}, paintClub2 = () => {};
const setClub = (v) => {
  S.club = v; store.set('club', v);
  paintClub(v); paintClub2(v);
  if (S.analyzed) evaluate();
};
paintClub = segInit('segClub', S.club, setClub);
paintClub2 = segInit('segClub2', S.club, setClub);
segInit('segSpeed', '0.25', (v) => { S.rate = +v; video.playbackRate = S.rate; });

function toggle(id, key) {
  $(id).addEventListener('click', () => { S[key] = !S[key]; $(id).classList.toggle('on', S[key]); draw(); });
}
toggle('#tSkel', 'skel'); toggle('#tPath', 'path'); toggle('#tRef', 'ref');

// ---------- 動画の読み込み ----------
// 動画を読み込んで、表示枠の大きさを合わせる
async function loadVideo(url) {
  const same = video.dataset.loaded === url && video.readyState >= 2;
  if (!same) {
    video.src = url;
    video.muted = true; video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadeddata = () => { video.dataset.loaded = url; res(); };
      video.onerror = () => rej(new Error('この動画形式は読み込めませんでした'));
      video.load();
    });
  }
  S.vw = video.videoWidth; S.vh = video.videoHeight;
  const ar = S.vw / S.vh;
  const st = $('#stage');
  st.style.aspectRatio = `${S.vw} / ${S.vh}`;
  st.style.width = `min(100%, calc(70vh * ${ar}))`;
  sizeOverlay();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

const MAX_CLIPS = 5;
$('#file').addEventListener('change', async (e) => {
  const fl = Array.from((e.target.files) || []).slice(0, MAX_CLIPS);
  if (!fl.length) return;
  const f = fl[0];
  // 前に選んだ動画の後片付け
  if (S.clips) S.clips.forEach((c) => URL.revokeObjectURL(c.url));
  if (S.singleUrl) URL.revokeObjectURL(S.singleUrl);
  S.clips = fl.length > 1 ? fl.map((x) => ({ fileName: x.name, url: URL.createObjectURL(x) })) : null;
  S.singleUrl = S.clips ? null : URL.createObjectURL(f);
  S.multi = null; S.multiSkipped = [];
  S.analyzed = false; S.posed = false; S.fileName = f.name; S.entry = null; S.entryMix = null; S.fcache = new Map();
  $('#analyzeBtn').textContent = S.clips ? `② ${fl.length}本まとめて解析する` : '② この動画を解析する';
  $('#clipBox').classList.add('hidden');
  $('#results').classList.add('hidden');
  $('#playerBox').classList.add('hidden');
  $('#analyzeBox').classList.remove('hidden');
  $('#phaseTag').classList.add('hidden');
  $('#stageCard').classList.remove('hidden');
  $('#analyzeBtn').disabled = true;
  S.clipLabel = '';
  bar(0); msg('動画を読み込み中…');
  try { await loadVideo(S.clips ? S.clips[0].url : S.singleUrl); } catch (err) { msg(err.message, true); return; }
  const d = video.duration;
  if (S.clips) {
    msg(`${fl.length}本の動画を選びました（1本目を表示中）。同じ角度・同じクラブで撮った動画をまとめて判定し、毎回出ている課題を見つけます。1本ずつ読み取るので、本数に応じて時間がかかります。`);
  } else {
    msg(`動画の長さ：${d.toFixed(1)}秒。${d > 15 ? '※長めの動画です。解析に時間がかかります（スイング部分だけにカットするのがおすすめ）。' : '「解析する」を押してください。'}`);
  }
  $('#analyzeBtn').disabled = false;
  $('#stageCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function sizeOverlay() {
  const r = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, Math.round(r.width * dpr));
  overlay.height = Math.max(1, Math.round(r.height * dpr));
}
window.addEventListener('resize', () => { sizeOverlay(); draw(); });

function seek(t) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); res(); };
    video.addEventListener('seeked', fin);
    setTimeout(fin, 2000);
    video.currentTime = t;
  });
}

// ---------- 解析 ----------
$('#analyzeBtn').addEventListener('click', analyze);

async function analyze() {
  const btn = $('#analyzeBtn');
  btn.disabled = true;
  try {
    if (S.clips && S.clips.length > 1) await analyzeMulti();
    else {
      S.multi = null;
      if (!S.posed) await readPose();
      S.ph = detectPhases();
      S.autoView = detectView();
      S.view = S.viewPref === 'auto' ? S.autoView : S.viewPref;
    }
    paintView2(S.view);
    S.analyzed = true;
    S.entry = null; S.entryMix = null; // 今のプレーヤーの新しい記録として保存する
    msg('解析完了！'); bar(1);
    $('#analyzeBox').classList.add('hidden');
    $('#playerBox').classList.remove('hidden');
    $('#results').classList.remove('hidden');
    buildChips();
    evaluate(true);
    await serial(buildSequence);
    await seek(S.ph.address * S.dt);
    draw();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    msg('エラー：' + (err.message || err), true);
    btn.disabled = false;
  }
}

// ---------- 複数の動画をまとめて解析 ----------
// 1本ずつ骨格を読み取り、それぞれ判定してから「毎回出ている課題」をまとめる。
// 動画ごとの情報（骨格・動作の区切り・解説図用のコマ画像）は clip に保存し、必要な時に入れ替える。
const CLIP_KEYS = ['frames', 'ph', 'n', 'dt', 'W', 'H', 'vw', 'vh', 'autoView', 'fcache', 'fileName', 'view'];
const saveClip = (c) => { CLIP_KEYS.forEach((k) => { c[k] = S[k]; }); };
const setClip = (c) => { CLIP_KEYS.forEach((k) => { S[k] = c[k]; }); };
function withClip(c, fn) {
  const keep = {}; CLIP_KEYS.forEach((k) => { keep[k] = S[k]; });
  setClip(c);
  try { return fn(); } finally { CLIP_KEYS.forEach((k) => { S[k] = keep[k]; }); }
}
const silentEval = () => { S.silent = true; try { return evalCore(); } finally { S.silent = false; } };

async function analyzeMulti() {
  const clips = S.clips;
  for (let j = 0; j < clips.length; j++) {
    const c = clips[j];
    if (c.frames || c.err) continue; // 読み取り済み
    S.clipLabel = `【${j + 1}/${clips.length}本目】`;
    try {
      await loadVideo(c.url);
      S.fcache = new Map(); S.fileName = c.fileName;
      await readPose();
      S.ph = detectPhases();
      S.autoView = detectView();
      // 解説図に使うコマを、この動画を開いている間に切り出しておく
      S.view = S.viewPref === 'auto' ? S.autoView : S.viewPref;
      silentEval();
      for (const i of new Set(S.checks.filter((x) => x.viz).map((x) => x.viz.i))) await frameImg(i);
      saveClip(c);
    } catch (err) {
      console.error(err);
      c.err = err.message || String(err);
    }
  }
  S.clipLabel = '';
  const ok = clips.filter((c) => c.frames);
  if (!ok.length) throw new Error('どの動画からもスイングを見つけられませんでした。' + (clips[0].err || ''));
  // 撮影角度：自動判定なら動画ごとの判定を使い、正面と後方が混ざっていれば両方まとめて判定する。
  // 角度を指定した場合は、全部その角度として判定する
  ok.forEach((c) => { c.view = S.viewPref === 'auto' ? c.autoView : S.viewPref; });
  const mixed = new Set(ok.map((c) => c.view)).size > 1;
  const nFo = ok.filter((c) => c.view === 'fo').length;
  S.view = nFo * 2 >= ok.length ? 'fo' : 'dtl';
  const use = ok;
  S.multiSkipped = clips.filter((c) => !use.includes(c)).map((c) => `${c.fileName}（スイングを見つけられませんでした）`);
  if (use.length > 1) {
    S.multi = { clips: use, cur: null, mixed };
    // 代表の動画＝点数が真ん中の動画（極端に良い・悪い1本に引っ張られないように）。正面と後方が混ざる時は、多い方の角度から選ぶ
    const pool = use.filter((c) => c.view === S.view);
    const sc = pool.map((c) => withClip(c, () => { silentEval(); return S.score; }));
    const med = [...sc].sort((x, y) => x - y)[Math.floor(sc.length / 2)];
    await showClip(pool[sc.indexOf(med)], false);
  } else {
    S.multi = null;
    await loadVideo(use[0].url);
    setClip(use[0]); S.posed = true;
    S.view = use[0].view;
  }
}

// 表示する動画を切り替える（複数解析のとき）
async function showClip(c, rebuild = true) {
  if (!S.multi) return;
  video.pause();
  await loadVideo(c.url);
  setClip(c); S.posed = true;
  S.multi.cur = c;
  renderClipTabs();
  if (rebuild) {
    buildChips();
    await serial(buildSequence);
    await seek(S.ph.address * S.dt);
    draw();
  }
}

function renderClipTabs() {
  const box = $('#clipBox');
  if (!S.multi) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const vn = (v) => (v === 'fo' ? '正面' : '後方');
  $('#clipTabs').innerHTML = S.multi.clips.map((c, i) => `<button data-i="${i}" class="${c === S.multi.cur ? 'on' : ''}">${i + 1}本目${S.multi.mixed ? '・' + vn(c.view) : ''}${c.score != null ? `（${c.score}点）` : ''}</button>`).join('');
  $$('#clipTabs button').forEach((b) => b.addEventListener('click', () => showClip(S.multi.clips[+b.dataset.i])));
  $('#clipName').textContent = `表示中：${S.multi.cur ? S.multi.cur.fileName : ''}`;
}

// 各動画の判定をまとめる：良い100・注意50・要改善0 の平均で決める（75より上＝良い、30以上＝注意）
function aggregate(per, cur) {
  const keys = [];
  for (const c of per) for (const x of c.checks) { const k = x.phase + '|' + x.name; if (!keys.includes(k)) keys.push(k); }
  const PH = PHASES.map((p) => p.key);
  keys.sort((x, y) => PH.indexOf(x.split('|')[0]) - PH.indexOf(y.split('|')[0]));
  const agg = [];
  for (const k of keys) {
    const find = (c) => c.checks.find((x) => x.phase + '|' + x.name === k);
    // その項目がある角度の動画だけを数える（正面だけの項目は、正面の動画の中で判断する）
    const vs = new Set(per.filter((c) => find(c)).map((c) => c.view));
    const elig = per.filter((c) => vs.has(c.view));
    const items = elig.map(find).filter((x) => x && x.status !== 'na');
    if (!items.length || items.length * 2 < elig.length) continue; // 半分以上の動画で判定できた項目だけ
    const mean = items.reduce((t, x) => t + PT[x.status], 0) / items.length;
    const st = mean > 75 ? 'good' : mean >= 30 ? 'warn' : 'bad'; // 良い1本＋注意1本は「注意」（たまたま良かった1本で甘くしない）
    // 説明文は、まとめた判定と同じ（無ければ近い・悪い方の）判定が出た動画のものを使う。代表の動画を優先
    const pick = [...items].sort((x, y) => (x.status === st ? 0 : 1) - (y.status === st ? 0 : 1)
      || Math.abs(PT[x.status] - mean) - Math.abs(PT[y.status] - mean) || PT[x.status] - PT[y.status]
      || (x.__clip === cur ? -1 : 0) - (y.__clip === cur ? -1 : 0))[0];
    const cnt = { good: 0, warn: 0, bad: 0 };
    items.forEach((x) => { cnt[x.status] += 1; });
    agg.push({ ...pick, status: st, link: '', multi: { cnt, n: items.length, views: [...vs] } });
  }
  return agg;
}

// 後方の「スイング軌道」がアウトサイドインの時、正面の判定から原因を示す
function linkCauses(agg) {
  const pth = agg.find((c) => c.name.includes('スイング軌道'));
  if (!pth || pth.status === 'good' || !/アウトサイドイン/.test(pth.value)) return;
  const causes = ['肩の回転（推定）', '下半身リード', '体重移動', '胸の向き'].map((k) => agg.find((c) => c.name.includes(k))).filter(Boolean);
  if (!causes.length) return;
  const bad = causes.filter((c) => c.status !== 'good').sort((x, y) => PT[x.status] - PT[y.status]);
  pth.link = bad.length
    ? `正面の判定から、原因の可能性が高いのは「${bad.map((c) => c.name.replace(/（.*?）/g, '')).join('」「')}」です。先にそちらを直すと、軌道も良くなりやすいです。`
    : '正面の判定では、体の回転や体重移動に大きな問題は見つかりませんでした。腕や手先で軌道を作っていないか確認し、切り返しで手元を真下に下ろす意識を持ちましょう。';
  for (const c of bad) c.link = c.link || '後方の判定でアウトサイドイン（スライスの原因）が出ています。この項目はその原因になりやすい動きです。';
}

function evaluateMulti() {
  const M = S.multi;
  if (!M.mixed) M.clips.forEach((c) => { c.view = S.view; }); // 結果画面で角度を切り替えた時
  for (const c of M.clips) {
    withClip(c, () => {
      c.tempo = silentEval();
      c.score = S.score;
      c.checks = S.checks.map((x) => Object.assign(x, { __clip: c }));
    });
  }
  const agg = aggregate(M.clips, M.cur);
  if (M.mixed) linkCauses(agg);
  S.checks = agg;
  S.score = calcScore(agg.map((c) => ({ name: c.name, st: c.status })));
  const avgT = (cs) => { const b = cs.reduce((t, c) => t + c.tempo.back, 0) / cs.length, d = cs.reduce((t, c) => t + c.tempo.down, 0) / cs.length; return { back: b, down: d, ratio: b / (d || 1) }; };
  const T = avgT(M.clips);
  M.byView = {};
  for (const v of ['fo', 'dtl']) {
    const cs = M.clips.filter((c) => c.view === v);
    if (!cs.length) continue;
    const g = aggregate(cs, M.cur);
    M.byView[v] = { clips: cs, checks: g, score: calcScore(g.map((c) => ({ name: c.name, st: c.status }))), tempo: avgT(cs) };
  }
  renderClipTabs();
  render(T.back, T.down, T.ratio);
  if (!M.mixed) recordEntry(T.back, T.down, T.ratio);
  else {
    // 成長の記録は角度ごとに分けて保存する（同じ角度どうしで比べるため）
    S.entryMix = S.entryMix || {};
    const texts = Object.entries(M.byView).map(([v, g]) => `${v === 'fo' ? '正面' : '後方'}：${recordEntry(g.tempo.back, g.tempo.down, g.tempo.ratio, { view: v, checks: g.checks, score: g.score, clips: g.clips, slot: v })}`);
    const vs = $('#vsPrev'); if (vs) vs.textContent = texts.join('／');
    gView = S.view; gClub = S.club;
    applyProfile(); renderGrowth();
  }
  return T;
}

// 動画の各コマから骨格を読み取る（動画ごとに1回だけ）
async function readPose() {
  {
    // iPhoneのSafariでは、一度再生操作をしておくとコマ送りが安定する
    try { await video.play(); video.pause(); } catch { /* 無視 */ }
    msg('AIモデルを準備中…（初回のみ数十秒かかることがあります）'); bar(0.02);
    await getPose();

    const dur = video.duration;
    const fps = dur <= 12 ? 30 : Math.max(12, Math.floor(360 / dur));
    S.dt = 1 / fps;
    S.n = Math.max(2, Math.floor((dur - 0.05) / S.dt));
    const scale = Math.min(1, 640 / Math.max(S.vw, S.vh));
    S.W = Math.round(S.vw * scale); S.H = Math.round(S.vh * scale);
    const cv = document.createElement('canvas'); cv.width = S.W; cv.height = S.H;
    const cx = cv.getContext('2d', { willReadFrequently: false });

    const raw = new Array(S.n).fill(null);
    let found = 0;
    let t0 = performance.now();
    for (let i = 0; i < S.n; i++) {
      await seek(i * S.dt + 0.001);
      cx.drawImage(video, 0, 0, S.W, S.H);
      const lms = await detect(cv);
      if (lms) {
        const a = new Float32Array(33 * 3);
        lms.forEach((p, k) => { a[k * 3] = p.x * S.W; a[k * 3 + 1] = p.y * S.H; a[k * 3 + 2] = p.visibility ?? 1; });
        raw[i] = a; found++;
        if (i % 3 === 0) drawLive(a);
      }
      bar(0.05 + 0.9 * (i + 1) / S.n);
      if (i === 1) t0 = performance.now(); // 1コマ目は準備時間を含むので除外
      if (i % 4 === 0) {
        const el = (performance.now() - t0) / 1000;
        const rest = i >= 4 ? `（残り約${Math.ceil(el / i * (S.n - i - 1))}秒）` : '';
        msg(`体の動きを読み取り中… ${i + 1}/${S.n}コマ${rest}`);
        await new Promise((r2) => setTimeout(r2, 0));
      }
    }
    if (found < S.n * 0.5) throw new Error('体をうまく検出できませんでした。全身が映っているか、明るさは十分かを確認してください。');
    S.frames = smooth(fill(raw));
    S.posed = true;
  }
}

// 検出できなかったコマを前後から補う
function fill(raw) {
  const n = raw.length;
  const firstIdx = raw.findIndex((f) => f);
  const out = new Array(n);
  let last = firstIdx;
  for (let i = 0; i < n; i++) {
    if (raw[i]) { out[i] = raw[i]; last = i; continue; }
    let nx = i + 1; while (nx < n && !raw[nx]) nx++;
    const a = raw[last], b = nx < n ? raw[nx] : raw[last];
    if (i < firstIdx) { out[i] = raw[firstIdx]; continue; }
    const t = nx < n ? (i - last) / (nx - last) : 0;
    const f = new Float32Array(99);
    for (let k = 0; k < 99; k++) f[k] = a[k] + (b[k] - a[k]) * t;
    out[i] = f;
  }
  return out;
}
// 手ブレ的な揺れをならす（前後2コマの平均）
function smooth(fr) {
  const n = fr.length, w = 2;
  return fr.map((_, i) => {
    const o = new Float32Array(99);
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { c++; for (let k = 0; k < 99; k++) o[k] += fr[j][k]; }
    for (let k = 0; k < 99; k++) o[k] /= c;
    return o;
  });
}

function bodyScale(i) { return dist(P(i, L.nose), ankM(i)) || S.H * 0.8; }

// ---------- 動作（フェーズ）の自動判定 ----------
function detectPhases() {
  const n = S.n, dt = S.dt;
  const hy = [], sp = [0];
  for (let i = 0; i < n; i++) hy.push(hand(i).y);
  for (let i = 1; i < n; i++) sp.push(dist(hand(i), hand(i - 1)) / dt);
  const sc = [];
  for (let i = 0; i < n; i++) sc.push(bodyScale(i));
  const scale = sc.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
  const argmin = (a, lo, hi) => { let b = lo; for (let i = lo; i <= hi; i++) if (a[i] < a[b]) b = i; return b; };
  const argmax = (a, lo, hi) => { let b = lo; for (let i = lo; i <= hi; i++) if (a[i] > a[b]) b = i; return b; };
  const sec = (s) => Math.round(s / dt);

  const iMax = argmax(sp, 2, n - 2);
  const top = argmin(hy, Math.max(0, iMax - sec(2.0)), iMax);
  const impact = argmax(hy, top, Math.min(n - 1, top + sec(1.0)));
  // バックスイング開始＝トップから遡って手が止まっている所
  const still = 0.22 * scale;
  let start = 0;
  // トップで一瞬止まる人（タメを作る人）を「構え」と間違えないよう、
  // 手がトップと構えの中間より下にある所から遡って探す
  const lowY = hy[argmax(hy, Math.max(0, top - sec(3.0)), top)];
  let from = top;
  while (from > 2 && hy[from] - hy[top] < 0.5 * (lowY - hy[top])) from--;
  for (let i = from; i >= 2; i--) { if (sp[i] < still && sp[i - 1] < still && sp[i - 2] < still) { start = i; break; } }
  const address = Math.max(0, start - 1);
  // フィニッシュ＝インパクト後に手が止まった所
  let finish = -1;
  for (let i = impact + sec(0.3); i < n - 2; i++) { if (sp[i] < still * 1.5 && sp[i + 1] < still * 1.5 && sp[i + 2] < still * 1.5) { finish = i; break; } }
  if (finish < 0) finish = argmin(hy, impact, Math.min(n - 1, impact + sec(2.0)));
  const yA = hy[address], yT = hy[top], yI = hy[impact];
  if (yA - yT < 0.2 * scale || impact <= top) throw new Error('スイングの動きを見つけられませんでした。スイング全体（構え〜振り切り）が映っているか確認してください。');
  let takeaway = address + 1;
  for (let i = address; i <= top; i++) { if (yA - hy[i] >= 0.15 * (yA - yT)) { takeaway = i; break; } }
  let downswing = top + 1;
  for (let i = top; i <= impact; i++) { if (hy[i] - yT >= 0.6 * (yI - yT)) { downswing = i; break; } }
  return { start, address, takeaway, top, downswing, impact, finish, scale, speed: sp };
}

// 正面か後方か：構えた時の肩幅と胴の長さの比で判定
function detectView() {
  const i = S.ph.address;
  const w = Math.abs(P(i, L.lSh).x - P(i, L.rSh).x) + Math.abs(P(i, L.lHip).x - P(i, L.rHip).x);
  const torso = dist(shM(i), hipM(i)) || 1;
  return w / torso > 0.6 ? 'fo' : 'dtl'; // 正面なら肩幅＋腰幅が胴の長さ並みに見える
}

// ---------- 判定 ----------
// 採点：良い100・注意50・要改善0 を、項目の重み（球筋への影響の大きさ）で平均する
const PT = { good: 100, warn: 50, bad: 0 };
const W3 = ['テンポ', '肩の回転（推定）', '下半身リード', '胸の向き', '体重移動', 'スイング軌道', '腰の突っ込み', '前傾角度のキープ（インパクト）', '腰の開き'];
const W2 = ['捻転差', 'スウェー', '頭の位置', 'ハンドファースト', '手元の位置（インパクト）', 'テークバックの方向', 'フライングエルボー', '頭の高さ', '前傾角度のキープ（トップ）', 'トップの手の位置', '頭の前後', 'チキンウィング', '三角形'];
const weightOf = (name) => (W3.some((w) => name.includes(w)) ? 3 : W2.some((w) => name.includes(w)) ? 2 : 1);
function calcScore(list) { // list: [{name, st}]
  let sw = 0, sp = 0;
  for (const c of list) { if (!(c.st in PT)) continue; const w = weightOf(c.name); sw += w; sp += w * PT[c.st]; }
  return sw ? Math.round(sp / sw) : 0;
}
const LEVELS = [[90, 'プロ級'], [80, '上級者レベル'], [70, '中級者レベル'], [60, '初中級者レベル'], [0, 'これから伸びる段階']];
const levelOf = (sc) => LEVELS.find(([min]) => sc >= min)[1];
const SCORE_VER = 2;
const cm = (norm) => Math.round(Math.abs(norm) * S.heightCm * 0.89);
function grade(v, good, warn) {
  if (v >= good[0] && v <= good[1]) return 'good';
  if (v >= warn[0] && v <= warn[1]) return 'warn';
  return 'bad';
}

// 判定の入口：複数の動画を解析したときは、まとめて判定する
function evaluate(saveHist) {
  if (S.multi && !S.silent) return evaluateMulti();
  return evalCore(saveHist);
}

function evalCore(saveHist) {
  const sd = sides();
  const ph = S.ph;
  const a = ph.address, tk = ph.takeaway, tp = ph.top, ds = ph.downswing, im = ph.impact, fi = ph.finish;
  const H = bodyScale(a);
  const C = [];
  const add = (phase, o) => C.push({ phase, ...o });
  // 解説図の指定：i＝描くコマ、ref＝比べる基準のコマ（黄色の点線）、seg＝線、ang＝関節の角度、
  // mark＝点、vline/hline＝基準の縦線・横線、path＝手の通り道、refPt＝基準の点
  const J = (k) => (f) => P(f, k);
  const NOSE = J(L.nose);
  const vz = (key, v) => { const c = C.find((x) => x.name.includes(key)); if (c && c.status !== 'na' && v.i >= 0 && v.i < S.n) c.viz = v; };
  const SHL = [J(L.lSh), J(L.rSh)], HIPL = [J(L.lHip), J(L.rHip)];

  // テンポ（両方の角度で共通）
  const back = (tp - ph.start) * S.dt, down = Math.max(S.dt, (im - tp) * S.dt), ratio = back / down;
  const tSt = grade(ratio, [2.4, 3.6], [1.8, 4.6]);
  add('top', {
    name: 'スイングテンポ（リズム）', status: tSt,
    value: `振り上げ ${back.toFixed(2)}秒 ： 振り下ろし ${down.toFixed(2)}秒 ＝ 約 ${ratio.toFixed(1)} ： 1`,
    ideal: '約 3 ： 1（プロの多くがこの比率）',
    about: '振り上げにかかる時間と、振り下ろしにかかる時間の比率です。比率が安定すると当たりも安定します。',
    fix: tSt === 'good' ? 'とても良いリズムです。この比率を毎回再現できるようにしましょう。'
      : ratio < 2.4 ? '振り上げが速すぎます（打ち急ぎ）。トップまで「ゆっくり大きく」上げる意識を持ちましょう。'
        : '振り上げに対して振り下ろしが遅めです。トップで止まりすぎず、下半身から一気に振り下ろしましょう。',
    drill: '「イーチ、ニー、サン（振り上げ）」「シッ（振り下ろし）」と声に出して素振り。メトロノームアプリのテンポに合わせるのも効果的です。',
  });

  if (S.view === 'fo') {
    // ===== 正面から =====
    const tdir = Math.sign(P(a, sd.leadHip).x - P(a, sd.trailHip).x) || 1; // 目標方向（画面上の+x/-x）
    const along = (p, q) => (q.x - p.x) * tdir / H; // 目標方向への移動量（身長比）
    const shW0 = Math.abs(P(a, L.lSh).x - P(a, L.rSh).x), hipW0 = Math.abs(P(a, L.lHip).x - P(a, L.rHip).x);
    const turn = (i, k1, k2, w0) => deg(Math.acos(Math.min(1, Math.abs(P(i, k1).x - P(i, k2).x) / (w0 || 1))));

    // アドレス
    const stance = Math.abs(P(a, L.lAn).x - P(a, L.rAn).x) / (shW0 || 1);
    const c1 = crit('stance');
    const st1 = grade(stance, c1.good, c1.warn);
    add('address', {
      name: 'スタンス幅（足の開き）', status: st1,
      value: `肩幅の 約${stance.toFixed(1)}倍`, ideal: c1.ideal,
      about: '両足の間隔です。狭すぎると体がふらつき、広すぎると体が回りにくくなります。長いクラブほど広く、短いクラブほど狭く構えます。',
      fix: st1 === 'good' ? `${clubName(S.club)}に合ったスタンス幅です。` : stance < c1.good[0] ? `${clubName(S.club)}にしてはスタンスが狭めです。もう少し足を広げて、体の回転を支えましょう。` : `${clubName(S.club)}にしてはスタンスが広すぎます。腰が回りにくくなるので少し狭めましょう。`,
      drill: 'クラブを肩に当てて真下に下ろし、足の位置の目印にして構える練習。',
    });
    const tilt = deg(Math.atan2(P(a, sd.trailSh).y - P(a, sd.leadSh).y, Math.abs(P(a, sd.trailSh).x - P(a, sd.leadSh).x)));
    const c2 = crit('tilt');
    const st2 = grade(tilt, c2.good, c2.warn);
    add('address', {
      name: '肩の傾き', status: st2,
      value: `${sd.trailName}肩が 約${tilt.toFixed(0)}° 下がっている${tilt < 0 ? `（${sd.leadName}肩の方が低い）` : ''}`, ideal: `${sd.trailName}肩がやや低い：${c2.ideal}`,
      about: `${sd.trailName}手は${sd.leadName}手より下でグリップするため、自然に${sd.trailName}肩が少し下がるのが正しい構えです。ボールを${sd.leadName}足寄りに置くドライバーほど傾きが大きくなります。`,
      fix: st2 === 'good' ? '自然な傾きです。' : tilt < c2.good[0] ?`肩が水平か${sd.leadName}肩が下がっています。背骨をほんの少し${sd.trailName}に傾けて構えましょう。` : `${sd.trailName}肩が下がりすぎです。体が${sd.trailName}に傾くとダフり（ボールの手前を打つミス）の原因に。`,
      drill: `構えたら${sd.trailName}手を${sd.trailName}ひざに軽く当ててから、そっとグリップに戻すと自然な傾きが作れます。`,
    });

    // テークバック
    const elT = angleAt(P(tk, sd.leadSh), P(tk, sd.leadEl), P(tk, sd.leadWr));
    const st3 = grade(elT, [158, 181], [140, 181]);
    add('takeaway', {
      name: `${sd.leadName}腕の伸び（三角形のキープ）`, status: st3,
      value: `${sd.leadName}ひじの角度 約${elT.toFixed(0)}°`, ideal: '160°以上（ほぼまっすぐ）',
      about: '両肩と両手で作る「三角形」を崩さずに振り上げると、軌道が安定します。',
      fix: st3 === 'good' ? '三角形を保ったまま上げられています。' : '腕だけでクラブを上げてひじが曲がっています。肩とお腹を回してクラブを動かしましょう。',
      drill: '両脇にタオルをはさんで、落とさないようにハーフスイング（腰から腰までの小さな振り）。',
    });

    // トップ
    const shT = turn(tp, L.lSh, L.rSh, shW0), hipT = turn(tp, L.lHip, L.rHip, hipW0), xf = shT - hipT;
    const st4 = grade(shT, [72, 120], [55, 120]);
    add('top', {
      name: '肩の回転（推定）', status: st4,
      value: `約${shT.toFixed(0)}°`, ideal: '約80〜90°（背中が目標を向くくらい）',
      about: '振り上げた時の肩の回転量です。回転が浅いと手打ちになり、飛距離が出ません。',
      fix: st4 === 'good' ? 'しっかり肩が回っています。' : '肩の回転が浅めです。腕を上げるのではなく、背中を目標に向けるイメージで回しましょう。',
      drill: 'クラブを両肩にかついで、背中が目標を向くまで回す「肩回し体操」を毎日10回。',
    });
    const st5 = grade(xf, [25, 90], [12, 90]);
    add('top', {
      name: '捻転差（Xファクター）', status: st5,
      value: `肩 約${shT.toFixed(0)}° − 腰 約${hipT.toFixed(0)}° ＝ 約${xf.toFixed(0)}°`, ideal: '25°以上（肩が腰より大きく回る）',
      about: '捻転差（ねんてんさ）＝肩と腰の回転量の差。ゴムをねじるように体に「ねじれ」をためることで飛距離が生まれます。',
      fix: st5 === 'good' ? '十分なねじれが作れています。' : '腰も一緒に回りすぎていて、ねじれが小さいです。腰の回転は肩の半分くらいに抑えましょう。',
      drill: `${sd.trailName}ひざの角度を変えないように意識して、肩だけを深く回す素振り。`,
    });
    const sway = along(hipM(tp), hipM(a)); // 目標と反対方向への腰の移動（＋がスウェー）
    const st6 = grade(sway, [-1, 0.04], [-1, 0.07]);
    add('top', {
      name: 'スウェー（腰の横ズレ）', status: st6,
      value: `腰が目標と反対に 約${cm(Math.max(0, sway))}cm 移動`, ideal: '約7cm以内（その場で回る）',
      about: 'スウェー＝振り上げで腰が横に流れてしまう動き。回転ではなく横移動になるため、当たりが不安定になります。',
      fix: st6 === 'good' ? 'その場でしっかり回れています。' : `腰が${sd.trailName}に流れています。${sd.trailName}足の内側で踏ん張り、${sd.trailName}ひざが外に逃げないようにしましょう。`,
      drill: `${sd.trailName}足のつま先の下にボールやタオルを置き、足の内側に体重を感じながら振り上げる。`,
    });
    const headT = Math.abs(along(P(a, L.nose), P(tp, L.nose)));
    const st7 = grade(headT, [0, 0.045], [0, 0.08]);
    add('top', {
      name: '頭の横ブレ', status: st7,
      value: `約${cm(headT)}cm 移動`, ideal: '約8cm以内',
      about: '頭はスイングの「軸」です。大きく動くと、ボールに当たる位置がずれます。',
      fix: st7 === 'good' ? '軸が安定しています。' : '頭が大きく動いています。振り上げで頭を体と一緒に横へ動かさないようにしましょう。',
      drill: '壁に頭を軽く当てた状態（または誰かに頭を押さえてもらう）でシャドースイング。',
    });
    const elTop = angleAt(P(tp, sd.leadSh), P(tp, sd.leadEl), P(tp, sd.leadWr));
    const st8 = grade(elTop, [150, 181], [128, 181]);
    add('top', {
      name: `トップでの${sd.leadName}腕の伸び`, status: st8,
      value: `${sd.leadName}ひじの角度 約${elTop.toFixed(0)}°`, ideal: '150°以上',
      about: 'トップで腕が大きく曲がると、スイングの円（スイングアーク）が小さくなり飛距離が落ちます。',
      fix: st8 === 'good' ? 'スイングアークが大きく保てています。' : `${sd.leadName}ひじが曲がっています。腕を伸ばしたまま、上げられる所までで止めましょう（トップは浅くてもOK）。`,
      drill: `${sd.leadName}手一本でクラブを短く持ち、ひじを伸ばしたまま振り上げる練習。`,
    });

    // ダウンスイング
    const lower = along(hipM(tp), hipM(ds));
    const st9 = grade(lower, [0.025, 1], [0, 1]);
    add('downswing', {
      name: '下半身リード（切り返し）', status: st9,
      value: lower >= 0 ? `腰が目標方向へ 約${cm(lower)}cm 先行` : `腰が目標と反対に 約${cm(lower)}cm 残っている`, ideal: '腰から先に目標方向へ動き出す',
      about: '切り返し＝振り上げから振り下ろしへの切り替え。上手な人は腕より先に「腰（下半身）」から動き出します。',
      fix: st9 === 'good' ? '下半身から動き出せています。' : `腕や肩から振り下ろしています（いわゆる手打ち）。トップで一瞬「${sd.leadName}足を踏み込む」ことから振り下ろしを始めましょう。`,
      drill: `ステップ打ち：両足をそろえて振り上げ、トップで${sd.leadName}足を目標方向へ一歩踏み出してから振り下ろす。`,
    });

    // ハーフウェイダウン（手元が腰の高さまで下りた所）で、胸がまだ後ろを向いているか
    const waistY = (hipM(a).y + shM(a).y) / 2 + 0.25 * (hipM(a).y - shM(a).y);
    let hw = -1;
    for (let i = tp; i <= im; i++) { if (hand(i).y >= waistY) { hw = i; break; } }
    if (hw > tp && hw < im) {
      const shHW = turn(hw, L.lSh, L.rSh, shW0);
      const st9b = grade(shHW, [28, 90], [15, 90]);
      add('downswing', {
        name: '胸の向き（ハーフウェイダウン）', status: st9b,
        value: `手元が腰の高さに来た時、肩が 約${shHW.toFixed(0)}° 後ろ向き`, ideal: `まだ${sd.trailName}斜め後ろ（約30〜45°）を向いている`,
        about: 'ハーフウェイダウン＝振り下ろしの途中で、手元が腰の高さまで下りた場面。ここで胸がまだ後ろを向いていると、クラブが内側から下りてきます。早く目標を向くと、外から下りるアウトサイドイン（スライス）の原因になります。',
        fix: st9b === 'good' ? '胸を開かずに振り下ろせています。' : `振り下ろしの途中で胸が早く目標を向いています（上半身が先に回っている）。手元が${sd.trailName}腰の前に来るまで、胸は${sd.trailName}斜め後ろに向けたままにしましょう。`,
        drill: `腰から腰までの小さなスイング（ハーフスイング）を鏡の前で。手元が${sd.trailName}腰の前に来た所で止め、胸が${sd.trailName}斜め後ろを向いているか確認します。両足をそろえて打つと、手先でなく体の回転で振る感覚がつかめます。`,
      });
    }

    // インパクト
    const wShift = along(hipM(a), hipM(im));
    const hipI = turn(im, L.lHip, L.rHip, hipW0);
    const stHip = grade(hipI, [25, 90], [12, 90]);
    add('impact', {
      name: 'インパクトでの腰の開き', status: stHip,
      value: `腰が構えより 約${hipI.toFixed(0)}° 目標方向へ回っている`, ideal: '約30〜45°（腰は先に回り、肩はほぼ正面）',
      about: '上手な人は、インパクトの瞬間にはもう腰が目標方向へ回り始めています（肩はほぼ正面）。腰が構えと同じ向きのままだと、腕の力だけで打つ「手打ち」になり、飛距離も方向も安定しません。',
      fix: stHip === 'good' ? '腰がしっかり先に回っています。' : `腰の回転が止まったまま打っています（手打ち）。振り下ろしでは${sd.leadName}腰を後ろへ引くように回し、インパクトでベルトのバックルが目標の少し${sd.leadName}を向くようにしましょう。`,
      drill: `クラブを腰に当てて構え、振り下ろしの動きで腰だけを回す練習。インパクトの位置で、クラブの先が目標より${sd.leadName}を向くまで回します。`,
    });

    const c10 = crit('shift');
    const st10 = grade(wShift, c10.good, c10.warn);
    add('impact', {
      name: '体重移動', status: st10,
      value: wShift >= 0 ? `腰が構えより目標方向へ 約${cm(wShift)}cm` : `腰が構えより後ろに 約${cm(wShift)}cm 残っている`, ideal: c10.ideal,
      about: `インパクトで体重が${sd.leadName}足に乗っていると、ボールを上から力強く打てます。`,
      fix: st10 === 'good' ? '体重がしっかり目標側に移っています。' : `体重が${sd.trailName}足に残っています（すくい打ち・ダフリの原因）。インパクトで${sd.leadName}腰が${sd.leadName}足の上に来るように。`,
      drill: `${sd.trailName}足のかかとを上げた状態で構え、そのまま打つ練習（強制的に${sd.leadName}足体重になる）。`,
    });
    const headI = along(P(a, L.nose), P(im, L.nose));
    const c11 = crit('head');
    const st11 = grade(headI, c11.good, c11.warn);
    add('impact', {
      name: '頭の位置（ビハインド・ザ・ボール）', status: st11,
      value: headI > 0 ? `頭が目標方向へ 約${cm(headI)}cm 突っ込んでいる` : `頭は構えの位置の 約${cm(headI)}cm 後ろ`, ideal: c11.ideal,
      about: 'インパクトでは、体重は目標側に移りつつ「頭はボールより後ろ」に残すのが理想です。ドライバーほど頭を後ろに残し、ウェッジは頭がボールのほぼ真上に来ます。',
      fix: st11 === 'good' ? '頭が残せています。' : '頭が目標方向に突っ込んでいます。ボールの後ろ側を見たままインパクトしましょう。',
      drill: `ボールの${sd.trailName}側（目標と反対側）にコインを置き、打ち終わるまでコインを見続ける練習。`,
    });
    const handI = along(hand(a), hand(im));
    const c12 = crit('hands');
    const st12 = grade(handI, c12.good, c12.warn);
    add('impact', {
      name: S.club === 'dr' ? '手元の位置（インパクト）' : 'ハンドファースト', status: st12,
      value: handI >= 0 ? `手元が構えより目標方向に 約${cm(handI)}cm` : `手元が構えより後ろに 約${cm(handI)}cm`, ideal: c12.ideal,
      about: S.club === 'dr'
        ? 'ドライバーはティーアップしたボールを下から上へ（アッパーに）打つので、アイアンほど手元を先行させません。ただし手元が大きく遅れると、手首がほどけてすくい打ちになります。'
        : 'ハンドファースト＝インパクトで手元がクラブヘッドより目標側にある形。上からボールをとらえ、しっかりつかまえられます。短いクラブほど重要です。',
      fix: st12 === 'good' ? (S.club === 'dr' ? '手元の位置が適切です。' : '手元が先行できています。')
        : S.club === 'dr' ? '手元が構えより大きく後ろに残り、手首がほどけています。インパクトで手元が構えた位置に戻ってくるように振りましょう。'
          : '手首をほどいて「すくい上げて」います。手元を目標側に押し込むようにインパクトしましょう。',
      drill: S.club === 'dr'
        ? `ハーフスイングで、インパクトの瞬間に手元が構えた位置に戻ってくる形で止める。`
        : `クロスハンド（${sd.leadName}手を下、${sd.trailName}手を上にして握る）でハーフスイング。${sd.trailName}手首の甲側への折れ（タメ）がインパクトまで自然に残り、手元が先行する感覚がつかめます。慣れたら普通の握りで、手元が${sd.leadName}太ももの前に来る形で止める。`,
    });

    // フォロー：インパクト後、手元が腰の高さに来た所で目標側の腕が伸びているか（チキンウィング）
    let fo = -1;
    for (let i = im + 1; i < fi; i++) { if (hand(i).y <= waistY) { fo = i; break; } }
    if (fo > im) {
      const elF = angleAt(P(fo, sd.leadSh), P(fo, sd.leadEl), P(fo, sd.leadWr));
      const stCw = grade(elF, [145, 181], [125, 181]);
      add('finish', {
        name: `フォローでの${sd.leadName}腕の伸び（チキンウィング）`, status: stCw,
        value: `${sd.leadName}ひじの角度 約${elF.toFixed(0)}°`, ideal: '140°以上（目標方向へ腕が伸びている）',
        about: `チキンウィング＝インパクト後に${sd.leadName}ひじが引けて曲がり、外へ逃げる形。アウトサイドイン軌道の人によく出る症状で、フェースが開いてスライスの原因になります。`,
        fix: stCw === 'good' ? '目標方向へ腕を伸ばして振り抜けています。' : `${sd.leadName}ひじが引けています。インパクト後は${sd.leadName}腕を目標方向へ伸ばし、体の回転と一緒に振り抜きましょう。`,
        drill: `${sd.leadName}手1本でウェッジを短く持ち、ティーアップしたボールを軽く打つ。手先で操作できないので、体の回転で振り抜く感覚が身につきます。`,
      });
    }

    // フィニッシュ
    const shF = turn(fi, L.lSh, L.rSh, shW0);
    const st13 = grade(shF, [60, 120], [40, 120]);
    add('finish', {
      name: '振り切り（体の回転）', status: st13,
      value: `肩が 約${shF.toFixed(0)}° 回転`, ideal: 'おへそが目標を向くまで回り切る',
      about: '最後まで体を回し切ることで、スイング中に減速せずに振り抜けます。',
      fix: st13 === 'good' ? 'しっかり回り切れています。' : '回転が途中で止まっています。おへそと胸を目標に向けるまで回し切りましょう。',
      drill: 'フィニッシュの形で3秒止まる「フィニッシュ素振り」を10回。',
    });
    const onLead = along(P(fi, sd.leadAn), hipM(fi));
    const st14 = grade(onLead, [-0.05, 1], [-0.1, 1]);
    add('finish', {
      name: `${sd.leadName}足への乗り`, status: st14,
      value: onLead >= -0.05 ? `腰が${sd.leadName}足の上にある` : `腰が${sd.leadName}足より 約${cm(onLead)}cm 後ろ`, ideal: `体重のほぼ全部が${sd.leadName}足に乗る`,
      about: `フィニッシュで${sd.leadName}足一本で立てるのが、体重移動ができた証拠です。`,
      fix: st14 === 'good' ? '体重が移り切っています。' : `体重が${sd.trailName}足に残っています。${sd.trailName}足はつま先だけ地面に触れている状態を目指しましょう。`,
      drill: `フィニッシュで${sd.trailName}足を浮かせて3秒キープできるかチェック。`,
    });
    const heel = (P(fi, sd.trailToe).y - P(fi, sd.trailHeel).y) / H;
    const st15 = grade(heel, [0.012, 1], [0, 1]);
    add('finish', {
      name: `${sd.trailName}かかとの上がり`, status: st15,
      value: st15 === 'good' ? `${sd.trailName}かかとが上がっている` : `${sd.trailName}かかとがあまり上がっていない`, ideal: `${sd.trailName}足はつま先立ち、靴の裏が後ろから見える`,
      about: `${sd.trailName}かかとが上がるのは、体重が目標側へ移り、腰が回り切った結果です。`,
      fix: st15 === 'good' ? '良い形です。' : `${sd.trailName}足がべた足のままです。インパクト後は${sd.trailName}ひざを${sd.leadName}ひざに寄せるように回しましょう。`,
      drill: `振り終わりに${sd.trailName}ひざを${sd.leadName}ひざにくっつける素振り。`,
    });

    // 正面の解説図
    const armAng = (f) => ({ i: f, ang: [J(sd.leadSh), J(sd.leadEl), J(sd.leadWr)] });
    vz('スタンス幅', { i: a, seg: [[J(L.lAn), J(L.rAn)], SHL] });
    vz('肩の傾き', { i: a, seg: [[J(sd.leadSh), J(sd.trailSh)]], hline: P(a, sd.leadSh) });
    vz('三角形', armAng(tk));
    vz('肩の回転（推定）', { i: tp, ref: a, seg: [SHL] });
    vz('捻転差', { i: tp, ref: a, seg: [SHL, HIPL] });
    vz('スウェー', { i: tp, ref: a, mark: [hipM], vline: hipM(a) });
    vz('頭の横ブレ', { i: tp, ref: a, mark: [NOSE], vline: P(a, L.nose) });
    vz(`トップでの${sd.leadName}腕`, armAng(tp));
    vz('下半身リード', { i: ds, ref: tp, mark: [hipM], vline: hipM(tp) });
    vz('胸の向き', { i: hw, ref: a, seg: [SHL] });
    vz('腰の開き', { i: im, ref: a, seg: [HIPL] });
    vz('体重移動', { i: im, ref: a, mark: [hipM], vline: hipM(a) });
    vz('ビハインド', { i: im, ref: a, mark: [NOSE], vline: P(a, L.nose) });
    vz(S.club === 'dr' ? '手元の位置（インパクト）' : 'ハンドファースト', { i: im, ref: a, mark: [hand], vline: hand(a) });
    vz('チキンウィング', armAng(fo));
    vz('振り切り', { i: fi, ref: a, seg: [SHL] });
    vz(`${sd.leadName}足への乗り`, { i: fi, mark: [hipM], vline: P(fi, sd.leadAn) });
    vz('かかとの上がり', { i: fi, seg: [[J(sd.trailHeel), J(sd.trailToe)]], hline: P(fi, sd.trailToe) });
  } else {
    // ===== 後方から =====
    const fdir = Math.sign((P(a, L.lToe).x + P(a, L.rToe).x) - (P(a, L.lHeel).x + P(a, L.rHeel).x))
      || Math.sign(P(a, L.nose).x - mid(P(a, L.lEar), P(a, L.rEar)).x) || 1; // ボール方向
    const toward = (p, q) => (q.x - p.x) * fdir / H; // ボール方向への移動量

    const sp0 = spineAngle(a);
    const cs1 = crit('spine');
    const s1 = grade(sp0, cs1.good, cs1.warn);
    add('address', {
      name: '前傾角度', status: s1,
      value: `約${sp0.toFixed(0)}°`, ideal: cs1.ideal,
      about: '前傾角度＝構えた時に上半身を前に倒す角度。股関節（足の付け根）から倒すのがポイントです。長いクラブほど浅く、短いクラブほど深くなります。',
      fix: s1 === 'good' ? `${clubName(S.club)}に合った前傾姿勢です。` : sp0 < cs1.good[0] ? '上体が起きすぎています。お尻を後ろに突き出すように、足の付け根から前に倒しましょう。' : '前に倒れすぎています。背筋を伸ばし、腕が肩から真下に垂れる位置まで起こしましょう。',
      drill: 'クラブを背中（頭・背中・お尻）に当てたまま、足の付け根から前に倒す練習。',
    });
    const kn = angleAt(P(a, sd.trailHip), P(a, sd.trailKn), P(a, sd.trailAn));
    const s2 = grade(kn, [142, 172], [130, 178]);
    add('address', {
      name: 'ひざの曲げ', status: s2,
      value: `ひざの角度 約${kn.toFixed(0)}°`, ideal: '約150〜165°（軽く曲げる程度）',
      about: 'ひざを軽く曲げると下半身が安定し、回転しやすくなります。',
      fix: s2 === 'good' ? '適度に曲がっています。' : kn > 172 ? 'ひざが伸びきっています。軽く曲げてクッションを作りましょう。' : 'ひざを曲げすぎです。座り込まず、軽く曲げる程度にしましょう。',
      drill: 'その場で軽くジャンプして着地した時のひざの角度が目安です。',
    });
    const reach = toward(shM(a), hand(a));
    const cs3 = crit('reach');
    const s3 = grade(reach, cs3.good, cs3.warn);
    add('address', {
      name: '手の位置（腕の垂れ方）', status: s3,
      value: reach >= 0 ? `手元が肩より 約${cm(reach)}cm ボール側` : `手元が肩より 約${cm(reach)}cm 体側`, ideal: cs3.ideal,
      about: '腕は肩から自然に垂らした位置でグリップするのが基本。遠すぎても近すぎても軌道が乱れます。長いクラブほどボールから遠く立ちます。',
      fix: s3 === 'good' ? '自然な位置です。' : reach > cs3.good[1] ? 'ボールから離れすぎて手が前に伸びています。一歩ボールに近づきましょう。' : '手元が体に近すぎます。少しボールから離れて立ちましょう。',
      drill: '構えた後に一度腕の力を抜いてダラリと垂らし、その位置でクラブを握り直す。',
    });

    const tkd = toward(hand(a), hand(tk));
    const s4 = grade(tkd, [-0.07, 0.03], [-0.11, 0.06]);
    add('takeaway', {
      name: 'テークバックの方向', status: s4,
      value: tkd < -0.07 ? `手元が体の方へ 約${cm(tkd)}cm（インに引きすぎ）` : tkd > 0.03 ? `手元がボール側へ 約${cm(tkd)}cm（アウトに上げている）` : '手元がほぼまっすぐ上がっている',
      ideal: '手元は体の近くを通り、まっすぐ後ろへ',
      about: 'インサイド＝体の内側、アウトサイド＝体の外側（ボール側）。テークバックの方向は、そのままダウンスイングの軌道に影響します。',
      fix: s4 === 'good' ? '良い方向に上げられています。' : tkd < -0.07 ? '手で体の内側に引き込みすぎています。最初の30cmはクラブヘッドを目標の反対方向へまっすぐ引きましょう。' : '手元が体から離れて外に上がっています。腕ではなく胸を回してクラブを上げましょう。',
      drill: 'ボールの後方30cmに別のボールを置き、テークバックでそのボールをまっすぐ押しのける練習。',
    });

    const spT = spineAngle(tp);
    const s5 = grade(sp0 - spT, [-6, 6], [-10, 10]);
    add('top', {
      name: '前傾角度のキープ（トップ）', status: s5,
      value: `構え ${sp0.toFixed(0)}° → トップ ${spT.toFixed(0)}°`, ideal: '変化が±6°以内',
      about: '振り上げで上体が起き上がると、元の位置に戻すのが難しくなり、ミスが増えます。',
      fix: s5 === 'good' ? '前傾が保たれています。' : sp0 > spT ? '振り上げで上体が起き上がっています。胸を地面に向けたまま回しましょう。' : '振り上げで前に突っ込んでいます。背中側に回すイメージを持ちましょう。',
      drill: 'クラブを胸の前で抱え、前傾したまま肩を回す練習（胸が地面を向いたまま）。',
    });
    const elUp = (P(tp, sd.trailSh).y - P(tp, sd.trailEl).y) / H;
    const s6 = grade(elUp, [-1, 0.03], [-1, 0.07]);
    add('top', {
      name: `${sd.trailName}ひじの位置（フライングエルボー）`, status: s6,
      value: elUp > 0 ? `${sd.trailName}ひじが肩より 約${cm(elUp)}cm 高い` : `${sd.trailName}ひじは肩より低い位置`, ideal: `${sd.trailName}ひじは地面の方を向き、肩より低め`,
      about: `フライングエルボー＝トップで${sd.trailName}ひじが外に浮く形。振り下ろしで外側から下りやすくなります。`,
      fix: s6 === 'good' ? 'ひじの位置が良いです。' : `${sd.trailName}ひじが浮いています。トップで${sd.trailName}ひじが地面を指すように、脇を軽く締めましょう。`,
      drill: `${sd.trailName}脇にヘッドカバーをはさんで、落とさないようにトップまで上げる。`,
    });
    const topPos = toward(P(tp, sd.trailSh), hand(tp));
    const cs7 = crit('top');
    const s7 = grade(topPos, cs7.good, cs7.warn);
    add('top', {
      name: 'トップの手の位置（スイングプレーン）', status: s7,
      value: topPos > cs7.good[1] ? '手元が肩より大きくボール側（アップライト）' : topPos < cs7.good[0] ? '手元が肩より大きく背中側（フラット）' : '手元がほぼ肩の上',
      ideal: cs7.ideal,
      about: 'スイングプレーン＝スイング中にクラブが描く面。トップで手が肩の上にあると、正しい面に乗りやすくなります。長いクラブほど面はフラット（寝た角度）になります。',
      fix: s7 === 'good' ? '良い位置にトップが収まっています。' : topPos > cs7.good[1] ? '手を高く上げすぎています（アップライト）。もう少し体を回して、手は肩の高さあたりに。' : '手元が背中側に入りすぎています（フラット）。腕を少し高く上げましょう。',
      drill: '後方から撮影した動画で、トップの手元が肩の真上付近に来るか毎回チェック。',
    });

    // ダウンスイング：同じ高さでのバックスイングとの比較＝スイング軌道
    const yD = hand(ds).y;
    let bi = ph.address, best = 1e9;
    for (let i = ph.address; i <= tp; i++) { const d = Math.abs(hand(i).y - yD); if (d < best) { best = d; bi = i; } }
    const path = toward(hand(bi), hand(ds));
    const cs8 = crit('path');
    const s8 = grade(path, cs8.good, cs8.warn);
    add('downswing', {
      name: 'スイング軌道（インサイドアウト／アウトサイドイン）', status: s8,
      value: path > cs8.good[1] ? `振り下ろしが振り上げより 約${cm(path)}cm 外側（アウトサイドイン）` : path < cs8.good[0] ? `振り下ろしが振り上げより 約${cm(path)}cm 内側（インサイドアウトが強い）` : '振り上げと同じか、やや内側から下りている（理想的）',
      ideal: cs8.ideal,
      about: 'アウトサイドイン＝外側から内側へ振る軌道。スライス（右に曲がる球、左打ちは左）の一番の原因です。インサイドアウト＝内側から外側へ振る軌道。ドローボールにつながりますが、強すぎるとフック・プッシュの原因に。',
      fix: s8 === 'good' ? '理想的な軌道です。動画の青線より赤線が少し内側を通っているか確認しましょう。'
        : path > cs8.good[1] ? '切り返しで肩や腕から動き、外から下りています。トップから「手元を真下に下ろす」イメージで、下半身から切り返しましょう。アウトサイドインのよくある原因は「トップで肩の回転が浅い」「振り下ろしで上半身が先に動く」「体重が右足に残る」の3つです。正面からも撮影すると、どれが当てはまるかアプリで確認できます。'
          : '内側から入りすぎています。体の回転を止めずに、目標方向へ振り抜きましょう。',
      drill: path > cs8.good[1] ? 'ボールの外側（向こう側）にヘッドカバーなどを置き、当てないように打つ練習（外から下りると当たる）。' : 'ボールの内側（手前）に障害物を置き、当てないように打つ練習。',
    });

    const headF = toward(P(a, L.nose), P(im, L.nose));
    const sHf = grade(headF, [-0.04, 0.03], [-0.07, 0.06]);
    add('impact', {
      name: '頭の前後の動き（インパクト）', status: sHf,
      value: headF > 0.03 ? `頭が構えよりボール側へ 約${cm(headF)}cm 出ている` : headF < -0.04 ? `頭が構えより体側へ 約${cm(headF)}cm 引けている（のけぞり）` : '頭の前後の位置が保たれている',
      ideal: '構えた位置から約5cm以内',
      about: '頭がボール側へ出るのは上体が突っ込んでいるサイン、体側へ引けるのは上体がのけぞっているサインです。どちらも前傾が崩れ、クラブの通り道がずれる原因になります。',
      fix: sHf === 'good' ? '頭の位置が安定しています。' : headF > 0 ? '上体がボール側へ突っ込んでいます。体重はかかと寄りに感じたまま、その場で回りましょう。' : '上体がのけぞっています。インパクトまで胸を地面に向けたまま回しましょう。',
      drill: '後方から撮影するときに、構えた頭の位置に目印（画面にマスキングテープなど）を付け、打ち終わるまで頭がはみ出さないか確認。',
    });

    const ee = toward(hipM(a), hipM(im));
    const s9 = grade(ee, [-1, 0.025], [-1, 0.05]);
    add('impact', {
      name: '腰の突っ込み（アーリーエクステンション）', status: s9,
      value: ee > 0 ? `腰が構えよりボール側へ 約${cm(ee)}cm 出ている` : '腰の位置が保たれている', ideal: '腰の位置は構えと同じか、やや後ろ',
      about: 'アーリーエクステンション＝インパクトで腰がボール側へ出て、体が伸び上がる動き。アマチュアに最も多いミスの一つで、シャンクやトップの原因になります。',
      fix: s9 === 'good' ? '腰の位置が保てています。' : 'インパクトで腰がボール側へ出ています。お尻を後ろに引いたまま回転する意識を持ちましょう。',
      drill: 'お尻を壁（または椅子の背もたれ）に軽く当てて構え、振り下ろしまでお尻が壁から離れないように素振り。',
    });
    const spI = spineAngle(im);
    const s10 = grade(sp0 - spI, [-6, 7], [-10, 12]);
    add('impact', {
      name: '前傾角度のキープ（インパクト）', status: s10,
      value: `構え ${sp0.toFixed(0)}° → インパクト ${spI.toFixed(0)}°`, ideal: '変化が±7°以内',
      about: 'インパクトで上体が起き上がると、ボールの頭を打つ「トップ」や、ボールが右に飛ぶミスが出やすくなります。',
      fix: s10 === 'good' ? '前傾がキープできています。' : sp0 > spI ? 'インパクト前に上体が起き上がっています。ボールを打ち終わるまで胸を地面に向けておきましょう。' : '前傾が深くなっています（突っ込み）。頭の高さを変えないようにしましょう。',
      drill: '前傾したまま、インパクト後も2秒ボールのあった場所を見続ける。',
    });
    const headDy = (P(im, L.nose).y - P(a, L.nose).y) / H;
    const s11 = grade(Math.abs(headDy), [0, 0.035], [0, 0.06]);
    add('impact', {
      name: '頭の高さ（上下動）', status: s11,
      value: headDy < 0 ? `頭が 約${cm(headDy)}cm 上がっている` : `頭が 約${cm(headDy)}cm 下がっている`, ideal: '約5cm以内',
      about: '頭の高さが変わると、クラブが地面に届く高さも変わり、ダフリやトップの原因になります。',
      fix: s11 === 'good' ? '頭の高さが安定しています。' : headDy < 0 ? '頭が上がっています（伸び上がり）。ひざの曲げを保ったまま打ちましょう。' : '頭が下がっています。沈み込まず、構えた高さで回転しましょう。',
      drill: '誰かに頭の上に手をかざしてもらい、当たらない・離れないように素振り。',
    });

    const handF = (shM(fi).y - hand(fi).y) / H;
    const s12 = grade(handF, [0.0, 1], [-0.08, 1]);
    add('finish', {
      name: '高いフィニッシュ', status: s12,
      value: handF >= 0 ? '手元が肩より高い位置で止まっている' : '手元が肩より低い位置で止まっている', ideal: '手元が頭の横、肩より高い位置',
      about: '大きく高いフィニッシュは、インパクト後も減速せずに振り抜けている証拠です。',
      fix: s12 === 'good' ? '大きく振り抜けています。' : 'インパクトで振りが止まっています。ボールの先までクラブを走らせ、高く振り抜きましょう。',
      drill: 'ボールを打たずに「フィニッシュの形で3秒止まる」素振りを10回。',
    });

    // 後方の解説図（名前が似ているので、長い名前から先に指定する）
    const spineLn = [hipM, shM];
    vz('前傾角度のキープ（トップ）', { i: tp, ref: a, seg: [spineLn] });
    vz('前傾角度のキープ（インパクト）', { i: im, ref: a, seg: [spineLn] });
    vz('前傾角度', { i: a, seg: [spineLn], vline: hipM(a) });
    vz('ひざの曲げ', { i: a, ang: [J(sd.trailHip), J(sd.trailKn), J(sd.trailAn)] });
    vz('手の位置（腕の垂れ方）', { i: a, seg: [[shM, hand]], vline: shM(a) });
    vz('テークバックの方向', { i: tk, ref: a, mark: [hand], vline: hand(a) });
    vz('フライングエルボー', { i: tp, seg: [[J(sd.trailSh), J(sd.trailEl)]], hline: P(tp, sd.trailSh) });
    vz('トップの手の位置', { i: tp, mark: [hand], vline: P(tp, sd.trailSh) });
    vz('スイング軌道', { i: ds, path: true, mark: [hand], refPt: hand(bi) });
    vz('頭の前後', { i: im, ref: a, mark: [NOSE], vline: P(a, L.nose) });
    vz('腰の突っ込み', { i: im, ref: a, mark: [hipM], vline: hipM(a) });
    vz('頭の高さ', { i: im, ref: a, mark: [NOSE], hline: P(a, L.nose) });
    vz('高いフィニッシュ', { i: fi, mark: [hand], hline: shM(fi) });
  }

  // フィニッシュのバランス（共通）：止まってからの体の揺れ
  const end = Math.min(S.n - 1, fi + Math.round(0.6 / S.dt));
  if (end - fi >= Math.round(0.3 / S.dt)) {
    let mx = 0;
    for (let i = fi; i <= end; i++) mx = Math.max(mx, dist(hipM(i), hipM(fi)) / H, dist(P(i, L.nose), P(fi, L.nose)) / H);
    const sb = grade(mx, [0, 0.03], [0, 0.06]);
    add('finish', {
      name: 'フィニッシュのバランス', status: sb,
      value: `振り終わり後の体の揺れ 約${cm(mx)}cm`, ideal: 'ピタッと止まる（約5cm以内）',
      about: 'フィニッシュで3秒止まれるかどうかは、スイング全体のバランスの総合チェックです。',
      fix: sb === 'good' ? 'バランス良く止まれています。' : 'フィニッシュでふらついています。8割の力で振って、毎回フィニッシュで止まることを優先しましょう。',
      drill: 'フィニッシュで3秒止まれなかったショットは「失敗」とカウントする練習。',
    });
  } else {
    add('finish', { name: 'フィニッシュのバランス', status: 'na', value: '動画がフィニッシュ直後で終わっているため判定できません', ideal: '振り終わった後も1〜2秒撮影する', about: '', fix: '次回はフィニッシュの後も2秒ほど撮り続けてください。', drill: '' });
  }

  vz('フィニッシュのバランス', { i: end, ref: fi, mark: [hipM, NOSE] });
  S.checks = C;
  const scored = C.filter((c) => c.status !== 'na');
  S.score = calcScore(scored.map((c) => ({ name: c.name, st: c.status })));
  if (S.silent) return { back, down, ratio };
  render(back, down, ratio);
  recordEntry(back, down, ratio);
  return { back, down, ratio };
}

// ---------- 結果の表示 ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BADGE = { good: '良い', warn: '注意', bad: '要改善', na: '判定不可' };

function render(back, down, ratio) {
  $('#scoreNum').innerHTML = `${S.score}<small>/100</small>`;
  $('#segView2').parentElement.classList.toggle('hidden', !!(S.multi && S.multi.mixed)); // 正面と後方をまとめた時は、角度の切り替えは不要
  const nG = S.checks.filter((c) => c.status === 'good').length;
  const nW = S.checks.filter((c) => c.status === 'warn').length;
  const nB = S.checks.filter((c) => c.status === 'bad').length;
  $('#summaryKv').innerHTML = `
    ${S.multi ? `<dt>解析した動画</dt><dd>${S.multi.clips.length}本（${S.multi.clips.map((c) => (S.multi.mixed ? (c.view === 'fo' ? '正面' : '後方') : '') + c.score + '点').join('・')}）の判定をまとめた結果</dd>` : ''}
    ${S.multi && S.multi.mixed ? `<dt>角度別</dt><dd>${Object.entries(S.multi.byView || {}).map(([v, g]) => `${v === 'fo' ? '正面' : '後方'} ${g.score}点（${g.clips.length}本）`).join('・')}（成長の記録には角度ごとに保存）</dd>` : ''}
    ${S.multiSkipped && S.multiSkipped.length ? `<dt>外した動画</dt><dd>${esc(S.multiSkipped.join('、'))}</dd>` : ''}
    <dt>クラブ</dt><dd>${clubName(S.club)}</dd>
    <dt>撮影角度</dt><dd>${S.multi && S.multi.mixed ? '正面＋後方' : S.view === 'fo' ? '正面' : '後方'}${S.viewPref === 'auto' ? '（自動判定）' : ''}</dd>
    <dt>テンポ</dt><dd>約 ${ratio.toFixed(1)} : 1</dd>
    <dt>スイング時間</dt><dd>${(back + down).toFixed(2)}秒（トップまで ${back.toFixed(2)}秒）</dd>
    <dt>レベル</dt><dd>${levelOf(S.score)}</dd>
    <dt>判定</dt><dd>良い ${nG}・注意 ${nW}・要改善 ${nB}</dd>
    <dt>前回比</dt><dd id="vsPrev">－</dd>`;

  const order = PHASES.map((p) => p.key);
  // 優先度＝重み×深刻さ（要改善は注意の2倍）。同じなら早い動作から（前の乱れが後に連鎖するため）
  const prio = (c) => weightOf(c.name) * (c.status === 'bad' ? 2 : 1);
  const issues = S.checks.filter((c) => c.status === 'bad' || c.status === 'warn')
    .sort((x, y) => prio(y) - prio(x) || order.indexOf(x.phase) - order.indexOf(y.phase));
  const pName = (k) => PHASES.find((p) => p.key === k).name;
  const gain = (c) => { // この項目が「良い」になったら何点上がるか
    const list = S.checks.filter((x) => x.status !== 'na').map((x) => ({ name: x.name, st: x === c ? 'good' : x.status }));
    return calcScore(list) - S.score;
  };
  const card = (c, i) => `<div class="theme ${c.status}"><b>${i + 1}. 【${pName(c.phase)}】${esc(c.name)}<span class="note" style="font-weight:400">（直すと +${gain(c)}点）</span></b>${esc(c.fix)}<br><span class="note">練習法：${esc(c.drill)}</span>${c.link ? `<br><span class="note">🔗 ${esc(c.link)}</span>` : ''}</div>`;
  const rest = issues.slice(3);
  $('#themes').innerHTML = issues.length
    ? issues.slice(0, 3).map(card).join('')
      + (rest.length ? `<details><summary>ほかの改善点（${rest.length}件）</summary><p class="note">上の3つが直ってきたら、次はこちらに取り組みましょう（大事な順）。</p>${rest.map((c, i) => card(c, i + 3)).join('')}</details>` : '')
    : '<p>大きな課題は見つかりませんでした。今の動きを再現できるよう、同じ条件で撮影して比べていきましょう。</p>';

  $('#phases').innerHTML = PHASES.map((p) => {
    const cs = S.checks.filter((c) => c.phase === p.key);
    return `<div class="phase"><div class="row" style="justify-content:space-between"><h3>${p.name}</h3>
      <button class="btn small" data-jump="${p.key}">▶ この場面を見る</button></div>
      <p class="desc">${p.desc}</p>
      ${cs.length ? cs.map((c) => `<div class="check">${c.viz ? `<canvas class="vz" data-ci="${S.checks.indexOf(c)}" title="タップでこの場面へ"></canvas>` : ''}<div class="hd"><b>${S.multi && S.multi.mixed && c.multi ? `<span class="note" style="font-weight:400">［${c.multi.views.length > 1 ? '正面・後方' : c.multi.views[0] === 'fo' ? '正面' : '後方'}］</span>` : ''}${esc(c.name)}</b><span class="badge ${c.status}">${BADGE[c.status]}</span></div>${c.link ? `<p class="note" style="margin:2px 0;color:var(--text)">🔗 ${esc(c.link)}</p>` : ''}${c.multi ? `<p class="note" style="margin:2px 0">${c.multi.n}本の内訳：良い ${c.multi.cnt.good}・注意 ${c.multi.cnt.warn}・要改善 ${c.multi.cnt.bad}${c.multi.cnt.bad + c.multi.cnt.warn === c.multi.n && c.multi.n > 1 ? '（毎回出ている課題）' : ''}</p>` : ''}
        <div class="val">${esc(c.value)}<br><span>目安：${esc(c.ideal)}</span></div>
        ${c.about ? `<p><span class="lbl">ここを見ています：</span>${esc(c.about)}</p>` : ''}
        <p><span class="lbl">アドバイス：</span>${esc(c.fix)}</p>
        ${c.drill && c.status !== 'good' ? `<p><span class="lbl">練習法：</span>${esc(c.drill)}</p>` : ''}</div>`).join('')
        : `<p class="note">この角度（${S.view === 'fo' ? '正面' : '後方'}）では判定項目がありません。${S.view === 'fo' ? '後方' : '正面'}から撮るとこの場面もチェックできます。</p>`}
    </div>`;
  }).join('');
  $$('#phases [data-jump]').forEach((b) => b.addEventListener('click', () => jump(b.dataset.jump, true)));
  $$('#phases canvas.vz').forEach((cv) => cv.addEventListener('click', async () => {
    const c = S.checks[+cv.dataset.ci];
    if (!c || !c.viz) return;
    if (S.multi && c.__clip && c.__clip !== S.multi.cur) await showClip(c.__clip);
    jumpFrame(c.viz.i);
  }));
  queueViz();
  renderPros();
}

// ---------- トッププロのお手本（ALBA Net のスイング連続写真へのリンク） ----------
// 写真そのものはアプリに取り込まず、同じクラブ・同じ角度のページへ案内する
const PRO_BASE = 'https://www.alba.co.jp/tour/swing-photo/';
const PROS = {
  'dr|fo': [['松山英樹', '20241022-matsuyama-hideki-driver-front/'], ['竹田麗央', '20250203-takeda-rio-driver-front/'], ['渋野日向子', '20250203-shibuno-hinako-driver-front/'], ['吉田優利', '20250203-yoshida-yuri-driver-front/'], ['勝みなみ', '20260209-minami-katsu-driver-front/']],
  'dr|dtl': [['石川遼', '20250624-ishikawa-ryo-driver-back/'], ['勝みなみ', '20260209-minami-katsu-driverr-back/'], ['石坂友宏', '20250624-ishizaka-tomohiro-driver-back/'], ['内山遥人', '20250720-uchiyama-haruto-driver-back/']],
  'fw|fo': [['藤本佳則（FW）', '20250624-fujimoto-yoshinori-fairwaywood-front/'], ['幡地隆寛（FW）', '20250624-hataji-hatakahiro-fairwaywood-front/']],
  'fw|dtl': [['蛭田みな美（FW）', '20250624-hiruta-minami-fairwaywood-back/']],
  'ir|fo': [['宮里藍（6番アイアン）', '20250203-miyazato-ai-6iron-front/']],
  'wg|fo': [['佐久間朱莉（ウェッジ）', 'jvo7m702y_2w/']],
};
const PRO_TIPS = {
  fo: ['アドレス：スタンスの幅と、肩の傾き', 'トップ：頭の位置が構えからどれだけ動いているか', 'インパクト：頭がボールの後ろに残り、腰が目標側へ移っているか', 'フィニッシュ：目標側の足一本で立てているか'],
  dtl: ['アドレス：前傾の深さと、手元と体の距離', 'トップ：手元が肩のどのあたりにあるか', 'ダウンスイング：手元が振り上げより内側を通っているか', 'インパクト：前傾とお尻の位置が構えのまま保たれているか'],
};
function renderPros() {
  const box = $('#pros');
  if (!box) return;
  const list = PROS[S.club + '|' + S.view] || [];
  const vName = S.view === 'fo' ? '正面' : '後方';
  let html = list.length
    ? `<div class="row">${list.map(([n, u]) => `<a class="btn small" href="${PRO_BASE}${u}" target="_blank" rel="noopener">${esc(n)}</a>`).join('')}</div>`
    : `<p class="note">${clubName(S.club)}・${vName}のお手本はまだ登録していません。下の一覧から探してみてください。</p>`;
  html += `<p class="note" style="margin:8px 0 2px"><b>見比べるポイント（${vName}）</b></p><ul class="note" style="margin:0;padding-left:1.2em">${PRO_TIPS[S.view].map((t) => `<li>${t}</li>`).join('')}</ul>`;
  html += `<p class="note" style="margin-top:8px"><a href="${PRO_BASE}" target="_blank" rel="noopener">プロのスイング連続写真をもっと見る（ALBA Net）</a></p>`;
  box.innerHTML = html;
}

function buildChips() {
  $('#phaseChips').innerHTML = PHASES.map((p) => `<button class="btn small" data-k="${p.key}">${p.name}</button>`).join('');
  $$('#phaseChips button').forEach((b) => b.addEventListener('click', () => jump(b.dataset.k)));
}

// ---------- 動作ごとの解説図 ----------
// 動画のコマ移動は同時に1つしかできないので、連続写真づくりと図づくりは順番に行う
let vizQ = Promise.resolve();
const serial = (fn) => (vizQ = vizQ.then(fn, fn));
function queueViz() { const tok = ++S.vizTok; serial(() => buildViz(tok)); }

async function frameImg(i) {
  if (S.fcache.has(i)) return S.fcache.get(i);
  await seek(i * S.dt + 0.001);
  const cv = document.createElement('canvas'); cv.width = S.W; cv.height = S.H;
  cv.getContext('2d').drawImage(video, 0, 0, S.W, S.H);
  S.fcache.set(i, cv);
  return cv;
}

async function buildViz(tok) {
  const cvs = $$('#phases canvas.vz');
  if (!cvs.length) return;
  const t0 = video.currentTime;
  let moved = false;
  for (const cv of cvs) {
    if (tok !== S.vizTok) return; // 判定し直したので、古い図づくりはやめる
    const c = S.checks[+cv.dataset.ci];
    if (!c || !c.viz) continue;
    if (c.__clip && S.multi) {
      withClip(c.__clip, () => { const img = S.fcache && S.fcache.get(c.viz.i); if (img) paintViz(cv, c, img); else cv.style.display = 'none'; });
      continue;
    }
    if (!S.fcache.has(c.viz.i)) moved = true;
    const img = await frameImg(c.viz.i);
    if (tok !== S.vizTok) return;
    paintViz(cv, c, img);
  }
  if (moved && video.paused) { await seek(t0); draw(); }
}

function paintViz(cv, c, img) {
  const v = c.viz;
  // 体の周りだけを切り抜く（基準のコマや手の通り道も入るように）
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const inc = (p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  const KEYS = [0, 11, 12, 15, 16, 23, 24, 27, 28, 29, 30, 31, 32];
  KEYS.forEach((k) => inc(P(v.i, k)));
  if (v.ref != null) KEYS.forEach((k) => inc(P(v.ref, k)));
  let ideal = null;
  if (v.path) { for (let i = S.ph.start; i <= v.i; i++) inc(hand(i)); ideal = idealPath(); [...ideal.back, ...ideal.down].forEach(inc); }
  const pad = 0.1 * Math.max(x1 - x0, y1 - y0);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(S.W, x1 + pad); y1 = Math.min(S.H, y1 + pad);
  const bw = Math.max(10, x1 - x0), bh = Math.max(10, y1 - y0);
  const outW = 320, outH = Math.round(Math.min(560, outW * bh / bw)), k = Math.min(outW / bw, outH / bh);
  cv.width = outW; cv.height = outH;
  const cx = cv.getContext('2d');
  const ox = (outW - bw * k) / 2, oy = (outH - bh * k) / 2;
  cx.fillStyle = '#000'; cx.fillRect(0, 0, outW, outH);
  cx.drawImage(img, x0, y0, bw, bh, ox, oy, bw * k, bh * k);
  cx.fillStyle = 'rgba(0,0,0,0.35)'; cx.fillRect(0, 0, outW, outH); // 線を見やすくするため少し暗く
  const T = (p) => ({ x: ox + (p.x - x0) * k, y: oy + (p.y - y0) * k });
  const lw = 3;
  const line = (p, q, color, dash, w) => {
    const a = T(p), b = T(q);
    cx.save(); cx.strokeStyle = color; cx.lineWidth = w || lw; cx.lineCap = 'round';
    if (dash) cx.setLineDash([7, 5]);
    cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke(); cx.restore();
  };
  const dot = (p, color, r, hollow) => {
    const a = T(p);
    cx.save(); cx.beginPath(); cx.arc(a.x, a.y, r || 6, 0, 7);
    if (hollow) { cx.strokeStyle = color; cx.lineWidth = 2.5; cx.setLineDash([4, 3]); cx.stroke(); } else { cx.fillStyle = color; cx.fill(); cx.strokeStyle = '#000'; cx.lineWidth = 1.5; cx.stroke(); }
    cx.restore();
  };
  const COL = { good: '#3ddc84', warn: '#ffb020', bad: '#ff5a46' }[c.status] || '#fff';
  const GH = '#ffd23f';
  // うっすら骨格
  const f = S.frames[v.i];
  cx.save(); cx.strokeStyle = 'rgba(255,255,255,0.4)'; cx.lineWidth = 1.5;
  for (const [p, q] of BONES) { const a = T({ x: f[p * 3], y: f[p * 3 + 1] }), b = T({ x: f[q * 3], y: f[q * 3 + 1] }); cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke(); }
  cx.restore();
  // 基準（黄色の点線）
  if (v.vline) line({ x: v.vline.x, y: y0 }, { x: v.vline.x, y: y1 }, GH, true, 2.5);
  if (v.hline) line({ x: x0, y: v.hline.y }, { x: x1, y: v.hline.y }, GH, true, 2.5);
  if (v.ref != null) {
    (v.seg || []).forEach(([p, q]) => line(p(v.ref), q(v.ref), GH, true, 2.5));
    (v.mark || []).forEach((m) => dot(m(v.ref), GH, 7, true));
  }
  if (v.path) {
    // お手本（白の点線）を先に描き、その上に本人の通り道を重ねる
    cx.save(); cx.translate(ox - x0 * k, oy - y0 * k);
    strokeIdeal(cx, ideal.back, k, 2.5); strokeIdeal(cx, ideal.down, k, 2.5);
    cx.restore();
    const seg = (from, to, color) => { for (let i = from; i < to; i++) line(hand(i), hand(i + 1), color, false, 2.5); };
    seg(S.ph.start, S.ph.top, '#2f8cff');
    seg(S.ph.top, v.i, '#ff5a36');
  }
  if (v.refPt) dot(v.refPt, GH, 7, true);
  // 今回の位置（判定の色）
  (v.seg || []).forEach(([p, q]) => line(p(v.i), q(v.i), COL, false, 4));
  if (v.ang) { const [p, q, r] = v.ang.map((fn) => fn(v.i)); line(p, q, COL, false, 4); line(q, r, COL, false, 4); dot(q, COL, 6); }
  (v.mark || []).forEach((m) => dot(m(v.i), COL, 7));
}

async function jumpFrame(i) {
  video.pause(); setPlayLabel();
  await seek(i * S.dt + 0.001);
  draw();
  $('#stageCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function jump(key, scroll) {
  video.pause(); setPlayLabel();
  await seek(S.ph[key] * S.dt + 0.001);
  draw();
  if (scroll) $('#stageCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function buildSequence() {
  const cv = document.createElement('canvas');
  const w = 360, h = Math.round(360 * S.vh / S.vw);
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  const out = [];
  for (const p of PHASES) {
    const i = S.ph[p.key];
    await seek(i * S.dt + 0.001);
    cx.drawImage(video, 0, 0, w, h);
    drawSkeleton(cx, i, w / S.W, 2);
    drawPath(cx, w / S.W, i, 2);
    out.push(`<figure data-k="${p.key}"><img src="${cv.toDataURL('image/jpeg', 0.8)}" alt="${p.name}"><figcaption>${p.name}</figcaption></figure>`);
  }
  $('#seq').innerHTML = out.join('');
  $$('#seq figure').forEach((f) => f.addEventListener('click', () => jump(f.dataset.k, true)));
}

// ---------- 描画 ----------
function curIndex() { return Math.max(0, Math.min(S.n - 1, Math.round(video.currentTime / S.dt))); }

function drawSkeleton(cx, i, k, lw) {
  const f = S.frames[i];
  cx.lineWidth = lw * 1.5; cx.strokeStyle = 'rgba(80,255,170,0.9)'; cx.lineCap = 'round';
  for (const [a, b] of BONES) { cx.beginPath(); cx.moveTo(f[a * 3] * k, f[a * 3 + 1] * k); cx.lineTo(f[b * 3] * k, f[b * 3 + 1] * k); cx.stroke(); }
  cx.fillStyle = '#fff';
  for (const j of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { cx.beginPath(); cx.arc(f[j * 3] * k, f[j * 3 + 1] * k, lw * 2, 0, 7); cx.fill(); }
}

// ---------- お手本の通り道（手元） ----------
// その人の体格・クラブに合わせて作る目安。
// 後方：構えた手元 →（ほぼまっすぐ）→ トップ、振り下ろしは振り上げより少し内側を通って構えた位置へ戻る。
//       トップの位置と内側への量は、判定の基準（クラブ別）の真ん中の値を使う。
// 正面：肩の中心を軸に、腕の長さを半径にした円を描く。
const IDEAL_COL = 'rgba(255,255,255,0.95)';
function idealPath() {
  const ph = S.ph, a = ph.address, tp = ph.top, sd = sides(), H = bodyScale(a);
  const h0 = hand(a);
  const midr = (r) => (r[0] + r[1]) / 2;
  const bez = (p0, c, p1) => Array.from({ length: 25 }, (_, j) => { const t = j / 24, u = 1 - t; return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y }; });
  if (S.view === 'dtl') {
    const fdir = Math.sign((P(a, L.lToe).x + P(a, L.rToe).x) - (P(a, L.lHeel).x + P(a, L.rHeel).x))
      || Math.sign(P(a, L.nose).x - mid(P(a, L.lEar), P(a, L.rEar)).x) || 1;
    const tsh = P(tp, sd.trailSh);
    const top = { x: tsh.x + fdir * H * midr(crit('top').good), y: hand(tp).y }; // 高さは本人のトップに合わせる
    const m = { x: (h0.x + top.x) / 2, y: (h0.y + top.y) / 2 };
    const dB = 0.02, dD = 2 * (midr(crit('path').good) + dB / 2); // ベジェ曲線の中間点は制御点の半分だけずれる
    return {
      back: bez(h0, { x: m.x + fdir * H * dB, y: m.y }, top),
      down: bez(top, { x: m.x + fdir * H * dD, y: m.y }, h0),
    };
  }
  // 正面：構えた手元・腕が地面と平行の所・本人のトップ の3点を通る円弧
  const tdir = Math.sign(P(a, sd.trailSh).x - P(a, sd.leadSh).x) || 1; // 画面上で後ろ側の肩がある向き
  // 腕が地面と平行の所：体が回っているので正面からは腕が短く見え、手元は後ろ側の足の真上〜少し外になる
  const sc = shM(a), hc = hipM(a);
  const M = { x: P(a, sd.trailAn).x + tdir * H * 0.03, y: (sc.y + hc.y) / 2 };
  const T = hand(tp);
  const arc3 = (p1, p2, p3) => {
    const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
    if (Math.abs(d) < 1e-6) return [p1, p2, p3];
    const q = (p) => p.x * p.x + p.y * p.y;
    const c = { x: (q(p1) * (p2.y - p3.y) + q(p2) * (p3.y - p1.y) + q(p3) * (p1.y - p2.y)) / d, y: (q(p1) * (p3.x - p2.x) + q(p2) * (p1.x - p3.x) + q(p3) * (p2.x - p1.x)) / d };
    const r = dist(c, p1), ang = (p) => Math.atan2(p.y - c.y, p.x - c.x);
    const a1 = ang(p1), a2 = ang(p2), a3 = ang(p3);
    const norm = (x) => { while (x < 0) x += 2 * Math.PI; while (x >= 2 * Math.PI) x -= 2 * Math.PI; return x; };
    // p1 から p2 を通って p3 へ向かう向きを選ぶ
    let sweep = norm(a3 - a1);
    if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI;
    return Array.from({ length: 31 }, (_, j) => { const t = a1 + sweep * j / 30; return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }; });
  };
  const back = arc3(h0, M, T);
  // フォローは振り上げの左右反転（構えた手元を通る縦線で折り返す）
  const follow = back.map((p) => ({ x: 2 * h0.x - p.x, y: p.y }));
  return { back, down: [], follow };
}

// お手本の線：見やすいように黒いふちを付けた白の点線
function strokeIdeal(cx, pts, k, w) {
  if (!pts || pts.length < 2) return;
  const path = () => { cx.beginPath(); pts.forEach((p, j) => (j ? cx.lineTo(p.x * k, p.y * k) : cx.moveTo(p.x * k, p.y * k))); };
  cx.save(); cx.lineJoin = 'round'; cx.lineCap = 'round';
  cx.setLineDash([w * 3, w * 2.2]);
  cx.strokeStyle = 'rgba(0,0,0,0.55)'; cx.lineWidth = w * 2; path(); cx.stroke();
  cx.strokeStyle = IDEAL_COL; cx.lineWidth = w; path(); cx.stroke();
  cx.restore();
}

function drawPath(cx, k, upto, lw) {
  const ip = idealPath();
  [ip.back, ip.down, ip.follow].forEach((pts) => strokeIdeal(cx, pts, k, lw * 1.4));
  const ph = S.ph;
  const seg = (from, to, color) => {
    const end = Math.min(to, upto);
    if (end <= from) return;
    cx.strokeStyle = color; cx.lineWidth = lw * 2.2; cx.lineJoin = 'round'; cx.beginPath();
    for (let i = from; i <= end; i++) { const h = hand(i); if (i === from) cx.moveTo(h.x * k, h.y * k); else cx.lineTo(h.x * k, h.y * k); }
    cx.stroke();
  };
  seg(ph.start, ph.top, '#2f8cff');
  seg(ph.top, ph.impact, '#ff5a36');
  seg(ph.impact, ph.finish, 'rgba(200,205,203,0.9)');
}

function drawRef(cx, k, lw) {
  const a = S.ph.address;
  cx.save();
  cx.strokeStyle = '#ffd23f'; cx.lineWidth = lw * 1.2; cx.setLineDash([8 * lw, 6 * lw]);
  const head = P(a, L.nose), H = bodyScale(a);
  cx.beginPath(); cx.arc(head.x * k, head.y * k, H * 0.07 * k, 0, 7); cx.stroke();
  if (S.view === 'fo') {
    const x = hipM(a).x * k;
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, S.H * k); cx.stroke();
  } else {
    const h = hipM(a), s = shM(a);
    const dx = s.x - h.x, dy = s.y - h.y;
    cx.beginPath(); cx.moveTo((h.x - dx * 0.6) * k, (h.y - dy * 0.6) * k); cx.lineTo((s.x + dx * 0.5) * k, (s.y + dy * 0.5) * k); cx.stroke();
    // お尻のライン（腰の突っ込みチェック用）
    const sd = Math.sign((P(a, L.lToe).x + P(a, L.rToe).x) - (P(a, L.lHeel).x + P(a, L.rHeel).x)) || 1;
    const bx = (h.x - sd * H * 0.07) * k;
    cx.beginPath(); cx.moveTo(bx, (h.y - H * 0.25) * k); cx.lineTo(bx, (h.y + H * 0.35) * k); cx.stroke();
  }
  cx.restore();
}

function draw() {
  if (!S.analyzed) return;
  const { k, lw } = fitTransform();
  const i = curIndex();
  if (S.ref) drawRef(octx, k, lw);
  if (S.path) drawPath(octx, k, i, lw);
  if (S.skel) drawSkeleton(octx, i, k, lw);
  octx.setTransform(1, 0, 0, 1, 0, 0);
  // 今どの動作か
  const ph = S.ph;
  let name = '準備';
  if (i >= ph.finish) name = 'フィニッシュ'; else if (i >= ph.impact) name = 'フォロー';
  else if (i >= ph.downswing) name = 'ダウンスイング'; else if (i > ph.top) name = '切り返し〜ダウン';
  else if (i === ph.top) name = 'トップ'; else if (i >= ph.takeaway) name = 'バックスイング';
  else if (i >= ph.start) name = 'テークバック'; else name = 'アドレス';
  const tag = $('#phaseTag'); tag.textContent = `${name}　${video.currentTime.toFixed(2)}秒`; tag.classList.remove('hidden');
  $$('#phaseChips button').forEach((b) => b.classList.toggle('on', S.ph[b.dataset.k] === i));
}

// 動画は枠内に「収まるように」表示されるので、同じ縮尺・余白で線を重ねる
function fitTransform() {
  const ow = overlay.width, oh = overlay.height;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, ow, oh);
  const k = Math.min(ow / S.W, oh / S.H);
  octx.translate((ow - S.W * k) / 2, (oh - S.H * k) / 2);
  return { k, lw: (S.W * k) / 400 };
}

function drawLive(a) {
  const { k, lw } = fitTransform();
  octx.lineWidth = lw * 1.5; octx.strokeStyle = 'rgba(80,255,170,0.9)';
  for (const [p, q] of BONES) { octx.beginPath(); octx.moveTo(a[p * 3] * k, a[p * 3 + 1] * k); octx.lineTo(a[q * 3] * k, a[q * 3 + 1] * k); octx.stroke(); }
  octx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------- 再生操作 ----------
function setPlayLabel() { $('#playBtn').textContent = video.paused ? '▶ 再生' : '❚❚ 停止'; }
$('#playBtn').addEventListener('click', async () => {
  if (video.paused) {
    if (video.currentTime >= video.duration - 0.05) video.currentTime = Math.max(0, S.ph.start * S.dt - 0.5);
    video.playbackRate = S.rate;
    try { await video.play(); } catch { /* 無視 */ }
    loop();
  } else video.pause();
  setPlayLabel();
});
video.addEventListener('pause', setPlayLabel);
video.addEventListener('ended', setPlayLabel);
function loop() { draw(); if (!video.paused && !video.ended) requestAnimationFrame(loop); }
const step = async (d) => { video.pause(); await seek(Math.max(0, Math.min(video.duration - 0.01, (curIndex() + d) * S.dt + 0.001))); draw(); };
$('#prevBtn').addEventListener('click', () => step(-1));
$('#nextBtn').addEventListener('click', () => step(1));

// ---------- プレーヤーと記録 ----------
// 記録はプレーヤーごとに「swing.hist.<プレーヤーID>」としてブラウザ内に保存する
const RANK = { good: 2, warn: 1, bad: 0 };
const ST_JA = { good: '良い', warn: '注意', bad: '要改善' };
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDay = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const phaseName = (k) => (PHASES.find((p) => p.key === k) || { name: '' }).name;

function profiles() {
  let ps = store.get('profiles', null);
  if (!ps || !ps.length) {
    // 初回：以前の設定と記録を「わたし」に引き継ぐ
    ps = [{ id: newId('p'), name: 'わたし', hand: store.get('hand', 'R'), height: store.get('height', 170) }];
    store.set('profiles', ps);
    store.set('cur', ps[0].id);
    const old = store.get('history', null);
    if (old && old.length) store.set('hist.' + ps[0].id, old.map((r) => ({ id: newId('h'), checks: [], ...r })));
  }
  return ps;
}
const curProfile = () => { const ps = profiles(); return ps.find((p) => p.id === store.get('cur', '')) || ps[0]; };
const hist = (pid) => store.get('hist.' + pid, []);
const setHist = (pid, h) => store.set('hist.' + pid, h);
const sorted = (h) => h.slice().sort((a, b) => (a.at < b.at ? -1 : 1));

function applyProfile() {
  const p = curProfile();
  S.hand = p.hand; S.heightCm = p.height;
  $('#playerSel').innerHTML = profiles().map((x) => `<option value="${x.id}"${x.id === p.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#playerInfo').textContent = `${p.hand === 'R' ? '右打ち' : '左打ち'}・身長${p.height}cm・記録${hist(p.id).length}件`;
}

// プレーヤーを切り替える。前のプレーヤーの記録は動かさず、表示中の結果は閉じる
function switchTo(pid) {
  store.set('cur', pid);
  closeResults();
  applyProfile();
  renderGrowth();
}

// 表示中の解析結果を閉じる（骨格データは残すので、同じ動画を読み取り直さずに判定し直せる）
function closeResults() {
  S.entry = null; S.entryMix = null;
  if (!S.analyzed) return;
  S.analyzed = false;
  video.pause();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  $('#phaseTag').classList.add('hidden');
  $('#results').classList.add('hidden');
  $('#playerBox').classList.add('hidden');
  $('#analyzeBox').classList.remove('hidden');
  const btn = $('#analyzeBtn');
  btn.disabled = false;
  btn.textContent = `② ${S.clips && S.clips.length > 1 ? `この${S.clips.length}本` : 'この動画'}を「${curProfile().name}」として判定する`;
  bar(0);
  msg('プレーヤーを切り替えたので、結果を閉じました（前のプレーヤーの記録はそのまま残っています）。同じ動画で判定する場合は上のボタンを押してください。体の読み取りは済んでいるので数秒で終わります。');
}
$('#playerSel').addEventListener('change', (e) => { closeForm(); gView = null; gClub = null; switchTo(e.target.value); });

let formMode = null, formHand = 'R';
const paintHand = segInit('segHand', 'R', (v) => { formHand = v; });
function openForm(mode) {
  formMode = mode;
  const p = curProfile();
  $('#pfName').value = mode === 'edit' ? p.name : '';
  formHand = mode === 'edit' ? p.hand : 'R'; paintHand(formHand);
  $('#pfHeight').value = mode === 'edit' ? p.height : 160;
  $('#pfDelete').classList.toggle('hidden', mode !== 'edit' || profiles().length < 2);
  $('#pfConfirm').innerHTML = '';
  $('#playerForm').classList.remove('hidden');
}
function closeForm() { formMode = null; $('#playerForm').classList.add('hidden'); $('#pfConfirm').innerHTML = ''; }
$('#playerAddBtn').addEventListener('click', () => openForm('add'));
$('#playerEditBtn').addEventListener('click', () => openForm('edit'));
$('#pfCancel').addEventListener('click', closeForm);
$('#pfSave').addEventListener('click', () => {
  const name = $('#pfName').value.trim() || 'プレーヤー';
  let h = +$('#pfHeight').value; if (!(h >= 120 && h <= 220)) h = 170;
  const ps = profiles();
  const mode = formMode;
  closeForm();
  if (mode === 'add') {
    const p = { id: newId('p'), name, hand: formHand, height: h };
    ps.push(p); store.set('profiles', ps); gView = null; gClub = null;
    switchTo(p.id);
  } else {
    Object.assign(ps.find((x) => x.id === curProfile().id), { name, hand: formHand, height: h });
    store.set('profiles', ps);
    applyProfile();
    if (S.analyzed) evaluate(); else renderGrowth();
  }
});
$('#pfDelete').addEventListener('click', () => {
  const p = curProfile(), n = hist(p.id).length;
  $('#pfConfirm').innerHTML = `<div id="confirmBox">「${esc(p.name)}」と、その記録${n}件を削除しますか？（元に戻せません）
    <div class="row" style="margin-top:6px"><button class="btn small" id="pfDelYes">削除する</button><button class="btn small" id="pfDelNo">やめる</button></div></div>`;
  $('#pfDelYes').addEventListener('click', () => {
    const ps = profiles().filter((x) => x.id !== p.id);
    store.set('profiles', ps);
    try { localStorage.removeItem('swing.hist.' + p.id); } catch { /* 無視 */ }
    store.set('cur', ps[0].id); gView = null; gClub = null;
    closeForm(); closeResults(); applyProfile(); renderGrowth();
  });
  $('#pfDelNo').addEventListener('click', () => { $('#pfConfirm').innerHTML = ''; });
});

// 解析結果を記録する（同じ動画で角度などを切り替えた時は、新しく増やさず上書き）
// o を渡すと、その角度・判定・点数で保存する（正面と後方をまとめて解析した時に、角度ごとに分けて保存するため）
function recordEntry(back, down, ratio, o = {}) {
  const view = o.view || S.view, score = o.score != null ? o.score : S.score;
  const clipsSrc = o.clips || (S.multi ? S.multi.clips : null);
  const getE = () => (o.slot ? S.entryMix[o.slot] : S.entry);
  const setE = (e) => { if (o.slot) S.entryMix[o.slot] = e; else S.entry = e; };
  const checks = (o.checks || S.checks).filter((c) => c.status !== 'na').map((c) => ({ k: c.phase + '|' + c.name, phase: c.phase, name: c.name, st: c.status, v: c.value }));
  const data = { file: clipsSrc ? clipsSrc.map((c) => c.fileName).join('、') : S.fileName, n: clipsSrc ? clipsSrc.length : 1, view, club: S.club, score, sv: SCORE_VER, tempo: +ratio.toFixed(1), back: +back.toFixed(2), down: +down.toFixed(2), checks };
  let txt = '';
  const e = getE();
  if (!(e && e.discarded)) {
    const pid = e ? e.pid : curProfile().id;
    const h = hist(pid);
    const i = e ? h.findIndex((r) => r.id === e.id) : -1;
    if (i >= 0) h[i] = { ...h[i], ...data };
    else { const id = newId('h'); h.unshift({ id, at: new Date().toISOString(), ...data }); setE({ pid, id }); }
    setHist(pid, h.slice(0, 300));
    // 総合結果の「前回比」
    const list = sorted(hist(pid)).filter((r) => r.view === view && clubOf(r) === S.club);
    const idx = list.findIndex((r) => r.id === getE().id);
    if (idx > 0) { const d = score - list[idx - 1].score; txt = `${d > 0 ? '+' : ''}${d}点（前回の${clubName(S.club)} ${list[idx - 1].score}点）`; }
    else txt = `初めての${view === 'fo' ? '正面' : '後方'}・${clubName(S.club)}の記録`;
  }
  if (o.slot) return txt;
  const vs = $('#vsPrev');
  if (vs && txt) vs.textContent = txt;
  gView = view; gClub = S.club;
  applyProfile();
  renderGrowth();
  return txt;
}

// ---------- 成長の記録 ----------
let gView = null, gClub = null;
const paintGView = segInit('segGView', '', (v) => { gView = v; renderGrowth(); });
// クラブ機能より前の記録は「未設定」として別に扱う（以前の基準で判定されているため）
const clubOf = (r) => r.club || 'none';

// 成長の記録のクラブ切り替えボタン（記録があるクラブ＋今のクラブだけ並べる）
function renderGClub(all) {
  const have = new Set(all.map(clubOf));
  const keys = ['dr', 'fw', 'ir', 'wg', 'none'].filter((c) => have.has(c) || c === gClub);
  const box = $('#segGClub');
  box.innerHTML = keys.map((c) => `<button data-v="${c}" class="${c === gClub ? 'on' : ''}">${c === 'none' ? '未設定' : clubName(c)}</button>`).join('');
  $$('#segGClub button').forEach((b) => b.addEventListener('click', () => { gClub = b.dataset.v; renderGrowth(); }));
}

function renderGrowth() {
  const p = curProfile();
  $('#growthTitle').textContent = `📈 成長の記録（${p.name}）`;
  const all = sorted(hist(p.id));
  renderHistory(p.id, all);
  if (!gView) gView = all.length ? all[all.length - 1].view : 'fo';
  if (!gClub) gClub = all.length ? clubOf(all[all.length - 1]) : S.club;
  paintGView(gView);
  renderGClub(all);
  const list = all.filter((r) => r.view === gView && clubOf(r) === gClub);
  const box = $('#growth');
  const vName = `${gView === 'fo' ? '正面' : '後方'}・${gClub === 'none' ? 'クラブ未設定' : clubName(gClub)}`;
  if (!list.length) { box.innerHTML = `<p class="note">${vName}の記録はまだありません。</p>`; return; }
  let html = chart(list.slice(-20));
  if (list.length < 2) { box.innerHTML = html + `<p class="note">${vName}でもう1回以上解析すると、前回との比較が表示されます。</p>`; return; }
  const last = list[list.length - 1], prev = list[list.length - 2];
  html += `<div class="gsec"><h3>前回（${fmtDate(prev.at)}）と比べて</h3>${compare(prev, last)}</div>`;
  if (list.length >= 3) {
    html += `<div class="gsec"><h3>はじめの記録（${fmtDate(list[0].at)}）と比べて</h3>${compare(list[0], last)}</div>`;
    html += habits(list);
  }
  box.innerHTML = html;
}

// スコアの推移グラフ
function chart(list) {
  const W = 600, H = 190, L = 34, R = 14, T = 16, B = 30;
  const x = (i) => (list.length === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (list.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / 100);
  let g = '';
  for (const v of [25, 50, 75, 100]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--sub)">${v}</text>`;
  const pts = list.map((r, i) => `${x(i)},${y(r.score)}`).join(' ');
  const every = Math.ceil(list.length / 8);
  const dots = list.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.score)}" r="4" fill="var(--brand)"/>
    <text x="${x(i)}" y="${y(r.score) - 8}" text-anchor="middle" font-size="11" fill="var(--ink)">${r.score}</text>
    ${i % every === 0 || i === list.length - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--sub)">${fmtDay(r.at)}</text>` : ''}`).join('');
  return `<svg class="gchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="スコアの推移">${g}
    <polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round"/>${dots}</svg>
    <p class="note" style="margin:0">総合スコアの推移（直近${list.length}回）</p>`;
}

// 2つの記録を項目ごとに比べる
function compare(a, b) {
  const d = b.score - a.score;
  let html = `<p style="margin:4px 0">総合スコア <b>${a.score} → ${b.score}</b>（${d > 0 ? '+' : ''}${d}点）・テンポ ${a.tempo}:1 → ${b.tempo}:1</p>`;
  const map = new Map((a.checks || []).map((c) => [c.k, c]));
  const ups = [], downs = [];
  let same = 0;
  for (const c of b.checks || []) {
    const o = map.get(c.k);
    if (!o) continue;
    const diff = RANK[c.st] - RANK[o.st];
    if (diff > 0) ups.push([o, c]); else if (diff < 0) downs.push([o, c]); else same++;
  }
  const row = (cls, ic, [o, c]) => `<div class="delta ${cls}"><span class="ic">${ic}</span><div><b>${esc(c.name)}</b>（${phaseName(c.phase)}）：${ST_JA[o.st]} → <b>${ST_JA[c.st]}</b>
    <br><span class="note">前：${esc(o.v)}<br>今：${esc(c.v)}</span></div></div>`;
  if (!ups.length && !downs.length) {
    html += `<p class="note">判定が変わった項目はありません${same ? `（${same}項目が同じ判定）` : ''}。</p>`;
  } else {
    if (ups.length) html += `<p class="lbl" style="margin:8px 0 0;font-weight:700">よくなった項目（${ups.length}）</p>` + ups.map((x) => row('up', '▲', x)).join('');
    if (downs.length) html += `<p class="lbl" style="margin:8px 0 0;font-weight:700">悪くなった項目（${downs.length}）</p>` + downs.map((x) => row('dn', '▼', x)).join('');
    if (same) html += `<p class="note">ほか${same}項目は同じ判定です。</p>`;
  }
  return html;
}

// 直近3回の傾向：身についたこと／続いている課題
function habits(list) {
  const last3 = list.slice(-3), earlier = list.slice(0, -3);
  const keys = (list[list.length - 1].checks || []).map((c) => c);
  const stOf = (r, k) => { const c = (r.checks || []).find((x) => x.k === k); return c ? c.st : null; };
  const mastered = [], ongoing = [];
  for (const c of keys) {
    const sts = last3.map((r) => stOf(r, c.k));
    if (sts.some((s) => s == null)) continue;
    if (sts.every((s) => s === 'good') && earlier.some((r) => { const s = stOf(r, c.k); return s && s !== 'good'; })) mastered.push(c);
    if (sts.every((s) => s !== 'good')) ongoing.push(c);
  }
  ongoing.sort((a, b) => RANK[a.st] - RANK[b.st]);
  let html = '';
  if (mastered.length) html += `<div class="gsec"><h3>🏅 身についたこと（以前は課題 → 直近3回連続で「良い」）</h3>` + mastered.map((c) => `<div class="delta up"><span class="ic">✓</span><div><b>${esc(c.name)}</b>（${phaseName(c.phase)}）</div></div>`).join('') + '</div>';
  if (ongoing.length) html += `<div class="gsec"><h3>🔁 続いている課題（直近3回連続で「注意」以下）</h3>` + ongoing.slice(0, 6).map((c) => `<div class="delta st"><span class="ic">・</span><div><b>${esc(c.name)}</b>（${phaseName(c.phase)}）：今回 ${ST_JA[c.st]}</div></div>`).join('') + '<p class="note">ここが今のあなたの「くせ」です。練習テーマとして優先しましょう。</p></div>';
  return html;
}

// 記録の一覧（新しい順）
let pendingDel = null;
function renderHistory(pid, all) {
  const box = $('#history');
  const h = all.slice().reverse();
  if (!h.length) { box.innerHTML = '<p class="note">まだ記録がありません。</p>'; return; }
  box.innerHTML = h.map((r) => `<div class="hist-item"><div><b>${fmtDate(r.at)}</b>（${r.view === 'fo' ? '正面' : '後方'}・${r.club ? clubName(r.club) : 'クラブ未設定'}${r.n > 1 ? `・${r.n}本まとめ` : ''}）スコア <b>${r.score}</b>・テンポ ${r.tempo}:1
      <br><span class="note">${esc(r.file || '')}</span></div>
      <button class="btn small" data-del="${r.id}">削除</button></div>`).join('')
    + (pendingDel ? `<div id="confirmBox">この記録を削除しますか？（元に戻せません）
      <div class="row" style="margin-top:6px"><button class="btn small" id="delYes">削除する</button><button class="btn small" id="delNo">やめる</button></div></div>` : '');
  $$('#history [data-del]').forEach((b) => b.addEventListener('click', () => { pendingDel = b.dataset.del; renderGrowth(); }));
  if (pendingDel) {
    $('#delYes').addEventListener('click', () => {
      setHist(pid, hist(pid).filter((r) => r.id !== pendingDel));
      if (S.entry && S.entry.id === pendingDel) S.entry = { discarded: true };
      if (S.entryMix) for (const v of Object.keys(S.entryMix)) if (S.entryMix[v] && S.entryMix[v].id === pendingDel) S.entryMix[v] = { discarded: true };
      pendingDel = null; applyProfile(); renderGrowth();
    });
    $('#delNo').addEventListener('click', () => { pendingDel = null; renderGrowth(); });
  }
}

// ---------- バックアップ ----------
$('#exportBtn').addEventListener('click', () => {
  const ps = profiles();
  const data = { app: 'golf-swing', ver: 1, exportedAt: new Date().toISOString(), profiles: ps, hist: Object.fromEntries(ps.map((p) => [p.id, hist(p.id)])) };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `swing-records-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $('#backupMsg').textContent = '書き出しました（ダウンロードフォルダ／iPhoneは「ファイル」アプリに保存されます）。';
});
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'golf-swing' || !Array.isArray(data.profiles)) throw new Error('このアプリの記録ファイルではありません');
    const ps = profiles();
    let addedP = 0, addedH = 0;
    for (const p of data.profiles) {
      if (!p || !p.id || !p.name) continue;
      if (!ps.find((x) => x.id === p.id)) { ps.push({ id: String(p.id), name: String(p.name).slice(0, 12), hand: p.hand === 'L' ? 'L' : 'R', height: +p.height || 170 }); addedP++; }
      const h = hist(p.id);
      for (const r of (data.hist && data.hist[p.id]) || []) {
        if (r && r.id && r.at && !h.find((x) => x.id === r.id)) { h.push(r); addedH++; }
      }
      setHist(p.id, h);
    }
    store.set('profiles', ps);
    applyProfile(); renderGrowth();
    $('#backupMsg').textContent = `読み込みました：プレーヤー${addedP}人・記録${addedH}件を追加（重複分は除外）。`;
  } catch (err) {
    $('#backupMsg').textContent = '読み込めませんでした：' + (err.message || err);
  }
});

// 採点方法を変えたので、保存済みの記録の点数を新しい計算で付け直す（判定の中身は変えない）
function migrateScores() {
  for (const p of profiles()) {
    const h = hist(p.id);
    let changed = false;
    for (const r of h) {
      if (r.sv === SCORE_VER || !r.checks || !r.checks.length) continue;
      r.score = calcScore(r.checks.map((c) => ({ name: c.name, st: c.st })));
      r.sv = SCORE_VER; changed = true;
    }
    if (changed) setHist(p.id, h);
  }
}
migrateScores();
applyProfile();
renderGrowth();

// ---------- 用語集 ----------
const GLOSS = [
  ['アドレス', '構え。ボールに向かってクラブを地面に置いた姿勢。'],
  ['テークバック', 'クラブを振り上げ始める最初の動き。'],
  ['トップ', 'クラブを一番高く振り上げた位置。'],
  ['切り返し', '振り上げから振り下ろしへ切り替える瞬間。'],
  ['ダウンスイング', 'トップからボールに向かって振り下ろす動き。'],
  ['インパクト', 'クラブがボールに当たる瞬間。'],
  ['フォロー／フィニッシュ', 'ボールを打った後の振り抜き／振り終わりの姿勢。'],
  ['スイング軌道', 'クラブ（このアプリでは手元）が通る道筋。'],
  ['インサイドアウト', '体の内側から外側へ抜ける軌道。右打ちならボールが右に出て左に曲がる「ドロー」になりやすい。'],
  ['アウトサイドイン', '体の外側から内側へ抜ける軌道。右打ちなら右に曲がる「スライス」の主な原因。'],
  ['スウェー', '振り上げで腰や体が横にずれてしまう動き。'],
  ['前傾角度', '構えた時の上半身の前への倒れ具合。'],
  ['アーリーエクステンション', '振り下ろしで腰がボール側へ出て、体が起き上がる動き。'],
  ['捻転差（Xファクター）', 'トップでの肩の回転と腰の回転の差。大きいほどパワーが出る。'],
  ['ハンドファースト', 'インパクトで手元がクラブヘッドより目標側にある形。'],
  ['フライングエルボー', 'トップで後ろ側のひじが外に浮く形。'],
  ['ダフリ／トップ', 'ダフリ＝ボールの手前の地面を打つミス。トップ＝ボールの上部を打つミス（※トップの位置とは別の意味）。'],
  ['テンポ', 'スイングのリズム。振り上げ：振り下ろしの時間比で表す。'],
  ['手打ち', '体（腰や肩）の回転を使わず、腕の力だけでクラブを振ること。飛距離も方向も安定しない。'],
  ['インサイドイン', '体の内側から入り、内側へ抜ける軌道。方向性と飛距離が安定する、理想とされる軌道。'],
  ['ハーフウェイダウン', '振り下ろしの途中で、手元が腰の高さまで下りた場面。胸がまだ後ろを向いているのが理想。'],
  ['チキンウィング', 'インパクト後に目標側のひじが引けて曲がる形。アウトサイドイン軌道の人に多い。'],
];
$('#gloss').innerHTML = GLOSS.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('');
