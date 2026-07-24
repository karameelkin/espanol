import { createFSRS, AGAIN, HARD, GOOD, EASY } from './fsrs.js';
import { db } from './db.js';
import { createAudioPlayer } from './audio.js';

const AUDIO_CACHE = 'span-audio-v1';

const $ = (id) => document.getElementById(id);
const player = createAudioPlayer('audio/');

let deck = [];              // [{i,w,m,s,se,wa,sa}]
let byId = new Map();       // i -> card content
let states = new Map();     // i -> fsrs state {i,state,stability,difficulty,due,last_review,reps,lapses}
let settings = { newPerDay: 15, retention: 0.9 };
let fsrs = createFSRS({ requestRetention: settings.retention });

// session
let queue = [];
let pos = 0;
let revealed = false;
let sessionSeen = new Set();

// ---------- helpers ----------
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtInterval(days) {
  if (days <= 0) return '<10м';
  if (days < 30) return `${days}д`;
  if (days < 365) return `${Math.round(days / 30)}мес`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}г`;
}
function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(screen).classList.remove('hidden');
}

// ---------- data load ----------
async function load() {
  deck = await fetch('deck.json').then((r) => r.json());
  byId = new Map(deck.map((c) => [c.i, c]));
  settings = await db.getMeta('settings', settings);
  fsrs = createFSRS({ requestRetention: settings.retention });
  const cards = await db.allCards();
  states = new Map(cards.map((c) => [c.i, c]));
}

async function introducedToday() {
  const log = await db.getMeta('newlog', {});
  return log[todayKey()] || 0;
}
async function bumpIntroduced() {
  const log = await db.getMeta('newlog', {});
  const k = todayKey();
  log[k] = (log[k] || 0) + 1;
  await db.setMeta('newlog', log);
}

// ---------- home ----------
async function renderHome() {
  const now = Date.now();
  let due = 0;
  for (const st of states.values()) if (st.due <= now) due++;
  const introduced = await introducedToday();
  const unseen = deck.filter((c) => !states.has(c.i)).length;
  const newAvail = Math.min(Math.max(0, settings.newPerDay - introduced), unseen);
  $('stat-due').textContent = due;
  $('stat-new').textContent = newAvail;
  $('stat-learned').textContent = states.size;
  const nothing = due === 0 && newAvail === 0;
  $('start-btn').textContent = nothing ? 'Свободно повторять' : 'Учить';
  show('home');
}

// ---------- session ----------
async function buildQueue() {
  const now = Date.now();
  const reviews = [...states.values()]
    .filter((st) => st.due <= now)
    .sort((a, b) => a.due - b.due)
    .map((st) => byId.get(st.i))
    .filter(Boolean);

  const introduced = await introducedToday();
  const remainingNew = Math.max(0, settings.newPerDay - introduced);
  const news = deck.filter((c) => !states.has(c.i)).slice(0, remainingNew);

  // free-review fallback: nothing due & no new left -> practice soonest cards
  let base = reviews;
  if (reviews.length === 0 && news.length === 0) {
    base = [...states.values()].sort((a, b) => a.due - b.due).slice(0, 20).map((st) => byId.get(st.i)).filter(Boolean);
  }

  // interleave new cards through reviews
  const q = [];
  let ri = 0, ni = 0;
  const step = news.length ? Math.max(1, Math.floor(base.length / news.length)) : 1;
  while (ri < base.length || ni < news.length) {
    for (let k = 0; k < step && ri < base.length; k++) q.push(base[ri++]);
    if (ni < news.length) q.push(news[ni++]);
  }
  queue = q;
  pos = 0;
  sessionSeen = new Set();
}

async function startSession() {
  player.unlock();
  await buildQueue();
  if (queue.length === 0) { finishSession(); return; }
  showCurrent();
  show('study');
}

function updateProgress() {
  const left = Math.max(0, queue.length - pos);
  $('study-progress').textContent = left > 0 ? `осталось ${left}` : '';
}

function showCurrent() {
  const card = queue[pos];
  revealed = false;
  $('word').textContent = card.w;
  $('answer').classList.add('hidden');
  $('grades').classList.add('hidden');
  $('reveal-btn').classList.remove('hidden');
  updateProgress();
  player.playSequence([card.wa], 0);
  const nxt = queue[pos + 1];
  if (nxt) player.preload(nxt.wa);
}

function renderSentence(parts) {
  const el = $('sentence');
  el.textContent = '';
  for (const p of parts) {
    if (p.b) {
      const strong = document.createElement('strong');
      strong.textContent = p.t;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(p.t));
    }
  }
}

function reveal() {
  if (revealed) return;
  revealed = true;
  const card = queue[pos];
  $('meaning').textContent = card.m;
  renderSentence(card.s || []);
  $('sentence-en').textContent = card.se || '';

  // interval hints on grade buttons
  const st = states.get(card.i) || null;
  const preview = fsrs.preview(st);
  document.querySelectorAll('.grade').forEach((btn) => {
    const g = Number(btn.dataset.g);
    btn.querySelector('.g-int').textContent = fmtInterval(preview[g]);
  });

  $('answer').classList.remove('hidden');
  $('reveal-btn').classList.add('hidden');
  $('grades').classList.remove('hidden');
  player.playSequence([card.sa], 0);
}

async function grade(g) {
  if (!revealed) return;
  const card = queue[pos];
  const prev = states.get(card.i) || null;
  const wasNew = !prev;

  const next = fsrs.review(prev, g, { now: Date.now(), rng: Math.random });
  const persist = {
    i: card.i,
    state: next.state,
    stability: next.stability,
    difficulty: next.difficulty,
    due: next.due,
    last_review: next.last_review,
    reps: next.reps,
    lapses: next.lapses,
  };
  states.set(card.i, persist);
  await db.putCard(persist);
  sessionSeen.add(card.i);
  if (wasNew) await bumpIntroduced();

  pos++;
  if (next.requeue) {
    queue.splice(Math.min(queue.length, pos + 2), 0, card);
  }

  if (pos >= queue.length) finishSession();
  else showCurrent();
}

function finishSession() {
  player.stop();
  const n = sessionSeen.size;
  $('done-sub').textContent = n ? `Повторено карточек: ${n}` : 'Новых и просроченных карточек нет.';
  show('done');
  renderHome(); // refresh stats behind the scenes
}

// ---------- offline download ----------
async function downloadAll() {
  const urls = [];
  for (const c of deck) {
    if (c.wa) urls.push('audio/' + encodeURIComponent(c.wa));
    if (c.sa) urls.push('audio/' + encodeURIComponent(c.sa));
  }
  const bar = $('download-bar');
  const fill = $('download-fill');
  bar.classList.remove('hidden');
  const btn = $('download-btn');
  btn.disabled = true;
  btn.textContent = 'Скачиваю…';

  let done = 0;
  const cache = await caches.open(AUDIO_CACHE);
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const u = urls[idx++];
      try {
        const match = await cache.match(u);
        if (!match) await cache.add(u);
      } catch {}
      done++;
      fill.style.width = `${Math.round((done / urls.length) * 100)}%`;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  btn.textContent = 'Скачано ✓';
  setTimeout(() => bar.classList.add('hidden'), 1200);
}

// ---------- settings ----------
function openSettings() {
  $('set-new').value = settings.newPerDay;
  $('set-ret').value = Math.round(settings.retention * 100);
  show('settings');
}
async function saveSettings() {
  const np = Math.max(0, Math.min(100, Number($('set-new').value) || 0));
  const ret = Math.max(70, Math.min(97, Number($('set-ret').value) || 90)) / 100;
  settings = { newPerDay: np, retention: ret };
  await db.setMeta('settings', settings);
  fsrs = createFSRS({ requestRetention: settings.retention });
}
async function resetProgress() {
  if (!confirm('Сбросить весь прогресс изучения? Это нельзя отменить.')) return;
  await db.clearAll();
  states = new Map();
  settings = { newPerDay: 15, retention: 0.9 };
  fsrs = createFSRS({ requestRetention: settings.retention });
  renderHome();
}

// ---------- events ----------
function wire() {
  $('start-btn').addEventListener('click', startSession);
  $('reveal-btn').addEventListener('click', reveal);
  $('study-back').addEventListener('click', () => { player.stop(); renderHome(); });
  $('done-home').addEventListener('click', renderHome);
  $('download-btn').addEventListener('click', downloadAll);
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', async () => { await saveSettings(); renderHome(); });
  $('reset-btn').addEventListener('click', resetProgress);
  $('replay-word').addEventListener('click', () => player.play(queue[pos]?.wa));
  $('replay-sentence').addEventListener('click', () => player.play(queue[pos]?.sa));
  document.querySelectorAll('.grade').forEach((btn) =>
    btn.addEventListener('click', () => grade(Number(btn.dataset.g)))
  );
  $('card').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!revealed) reveal();
  });
  document.addEventListener('keydown', (e) => {
    if ($('study').classList.contains('hidden')) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (revealed && ['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key));
  });
}

// ---------- boot ----------
async function boot() {
  wire();
  await load();
  await renderHome();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
}
boot();
