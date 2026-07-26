import { createFSRS, AGAIN, HARD, GOOD, EASY } from './fsrs.js';
import { db } from './db.js';
import { createAudioPlayer } from './audio.js';
import { createSpeaker } from './speak.js';

const AUDIO_CACHE = 'span-audio-v1';
const SLOW = 0.6; // playback rate for the "slower" button

const $ = (id) => document.getElementById(id);
const player = createAudioPlayer('audio/');
const speaker = createSpeaker();

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

// ---------- audio: the deck is split evenly between the voices in rotation ----------
// The pool is the recorded clip plus every good es-ES synth voice on the device, so
// the ear hears variety while c/z stay Castilian [θ] everywhere. Each card is bound
// to one voice for good, and the voices get equal shares: we deal them round-robin
// over a deterministically shuffled card order, so the split stays even (±1 card)
// without voices alternating predictably by card number.
let currentAudio = { kind: 'record' }; // resolved per card in showCurrent()
let voiceSlots = new Map();            // card.i -> index in the pool
let slotsFor = 0;                      // pool size those slots were dealt for

function sentenceText(card) {
  return (card?.s || []).map((p) => p.t).join('').replace(/\s+/g, ' ').trim();
}
function audioPool() {
  // 'record' is index 0; then each Castilian voice safe to rotate.
  return ['record', ...(speaker.available ? speaker.mixVoices() : [])];
}
// Deterministic 0..1 hash: the same shuffle on every device and every reload.
function hash01(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function dealVoiceSlots(size) {
  voiceSlots = new Map();
  slotsFor = size;
  if (size < 2 || !deck.length) return;
  const order = deck.map((c) => c.i).sort((a, b) => hash01(a) - hash01(b));
  order.forEach((i, n) => voiceSlots.set(i, n % size));
}
function assignAudio(card) {
  const pool = audioPool();
  if (pool.length !== slotsFor) dealVoiceSlots(pool.length);
  const pick = pool[voiceSlots.get(card.i) ?? 0];
  currentAudio = !pick || pick === 'record' ? { kind: 'record' } : { kind: 'tts', voice: pick };
}
function voiceLabel() {
  if (currentAudio.kind === 'record') return 'запись';
  return currentAudio.voice?.name || 'синтез';
}
// Play word/sentence for the current card in its assigned voice; rate < 1 slows it.
// Falls back to the recording if synthesis can't speak this time.
async function playWord(rate = 1) {
  const card = queue[pos];
  if (!card) return;
  if (currentAudio.kind === 'tts') {
    player.stop();
    const ok = await speaker.speak(card.w, { rate, voice: currentAudio.voice });
    if (ok) return;
  }
  speaker.stop();
  player.play(card.wa, rate);
}
async function playSentence(rate = 1) {
  const card = queue[pos];
  if (!card) return;
  if (currentAudio.kind === 'tts') {
    player.stop();
    const ok = await speaker.speak(sentenceText(card), { rate, voice: currentAudio.voice });
    if (ok) return;
  }
  speaker.stop();
  player.play(card.sa, rate);
}
function updateVoiceTag() {
  const tag = $('voice-tag');
  if (!tag) return;
  // Only worth showing when voices actually vary.
  const show = speaker.available;
  tag.textContent = show ? voiceLabel() : '';
  tag.classList.toggle('hidden', !show);
}

// ---------- data load ----------
async function load() {
  deck = await fetch('deck.json').then((r) => r.json());
  byId = new Map(deck.map((c) => [c.i, c]));
  settings = await db.getMeta('settings', settings);
  delete settings.audioSource; // dropped: voices always rotate, no source switch
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
  speaker.warmup();
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
  $('card').classList.remove('swipeable');
  resetCard();
  updateProgress();
  assignAudio(card);
  updateVoiceTag();
  playWord(1);
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

  // interval hints on the buttons and on the swipe stamps
  const st = states.get(card.i) || null;
  const preview = fsrs.preview(st);
  document.querySelectorAll('.grade').forEach((btn) => {
    const g = Number(btn.dataset.g);
    btn.querySelector('.g-int').textContent = fmtInterval(preview[g]);
  });
  for (const g of [AGAIN, GOOD, EASY]) $(`stamp-i-${g}`).textContent = fmtInterval(preview[g]);

  $('answer').classList.remove('hidden');
  $('reveal-btn').classList.add('hidden');
  $('grades').classList.remove('hidden');
  $('card').classList.add('swipeable'); // only now does the card follow the finger
  playSentence(1);
}

// ---------- swipe: left = forgot, right = knew it, up = already know ----------
// The card follows the finger; passing the threshold flings it off and grades.
// Buttons stay for tapping, keyboard 1-4 still reaches Hard as well.
const COMMIT_X = 84;   // px of horizontal travel that commits the swipe
const COMMIT_Y = 96;   // px upward that commits "already know"
const UP_BIAS = 1.3;   // how much more vertical than horizontal an up-swipe must be
let drag = null;
let flinging = false;  // card is flying off; ignore input until the next card is up

function isUp(dx, dy) {
  return dy < -30 && Math.abs(dy) > Math.abs(dx) * UP_BIAS;
}
function paintDrag(dx, dy) {
  const el = $('card');
  const up = isUp(dx, dy);
  const x = up ? dx * 0.2 : dx;
  const y = up ? dy : dy * 0.25;
  el.style.transform = `translate(${x}px, ${y}px) rotate(${x / 24}deg)`;
  const stamp = (sel, v) => {
    document.querySelector(sel).style.opacity = String(Math.max(0, Math.min(1, v)));
  };
  stamp('.st-again', up ? 0 : -dx / COMMIT_X);
  stamp('.st-good', up ? 0 : dx / COMMIT_X);
  stamp('.st-easy', up ? -dy / COMMIT_Y : 0);
}
function resetCard() {
  const el = $('card');
  el.style.transform = '';
  el.style.opacity = '';
  for (const s of document.querySelectorAll('.stamp')) s.style.opacity = '0';
}
function flyOut(g, dx, dy) {
  const el = $('card');
  const up = g === EASY;
  flinging = true;
  const x = up ? 0 : Math.sign(dx || 1) * window.innerWidth * 1.15;
  const y = up ? -window.innerHeight : dy;
  el.classList.add('flying');
  el.style.transform = `translate(${x}px, ${y}px) rotate(${x / 24}deg)`;
  el.style.opacity = '0';
  setTimeout(async () => {
    // Freeze animation first: grade() renders the next card, and that must not be
    // seen sliding back from off-screen.
    el.classList.remove('flying');
    el.classList.add('no-anim');
    await grade(g);
    resetCard();
    el.style.transform = 'scale(0.97)';
    el.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.remove('no-anim');
      el.style.transform = '';
      el.style.opacity = '';
      flinging = false;
    }));
  }, 170);
}
function onPointerDown(e) {
  if (!revealed || drag || flinging) return;
  if (e.target.closest('button')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false };
  $('card').classList.add('dragging');
  try { $('card').setPointerCapture(e.pointerId); } catch {}
}
function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dx = e.clientX - drag.x0;
  drag.dy = e.clientY - drag.y0;
  if (Math.abs(drag.dx) > 5 || Math.abs(drag.dy) > 5) drag.moved = true;
  if (drag.moved) paintDrag(drag.dx, drag.dy);
}
function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { dx, dy, moved } = drag;
  drag = null;
  $('card').classList.remove('dragging');
  if (!moved) { resetCard(); return; }
  if (isUp(dx, dy) && -dy >= COMMIT_Y) flyOut(EASY, dx, dy);
  else if (!isUp(dx, dy) && Math.abs(dx) >= COMMIT_X) flyOut(dx > 0 ? GOOD : AGAIN, dx, dy);
  else resetCard(); // below the threshold: springs back, nothing graded
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
  speaker.stop();
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
  const info = $('voice-info');
  if (info) info.classList.toggle('hidden', !speaker.available);
  const vl = $('voice-list');
  if (vl) {
    const names = speaker.available ? speaker.mixVoices().map((v) => v.name) : [];
    vl.textContent = names.length
      ? `В ротации: запись из колоды, ${names.join(', ')} — поровну по карточкам.`
      : '';
  }
  show('settings');
}
async function saveSettings() {
  const np = Math.max(0, Math.min(100, Number($('set-new').value) || 0));
  const ret = Math.max(70, Math.min(97, Number($('set-ret').value) || 90)) / 100;
  settings = { ...settings, newPerDay: np, retention: ret };
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
  $('study-back').addEventListener('click', () => { player.stop(); speaker.stop(); renderHome(); });
  $('done-home').addEventListener('click', renderHome);
  $('download-btn').addEventListener('click', downloadAll);
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', async () => { await saveSettings(); renderHome(); });
  $('reset-btn').addEventListener('click', resetProgress);
  $('replay-word').addEventListener('click', () => playWord(1));
  $('slow-word').addEventListener('click', () => playWord(SLOW));
  $('replay-sentence').addEventListener('click', () => playSentence(1));
  $('slow-sentence').addEventListener('click', () => playSentence(SLOW));
  document.querySelectorAll('.grade').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (flinging) return;
      flyOut(Number(btn.dataset.g), btn.dataset.g === '1' ? -1 : 1, 0);
    })
  );
  const card = $('card');
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!revealed && !flinging) reveal();
  });
  card.addEventListener('pointerdown', onPointerDown);
  card.addEventListener('pointermove', onPointerMove);
  card.addEventListener('pointerup', onPointerUp);
  card.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', (e) => {
    if ($('study').classList.contains('hidden') || flinging) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (!revealed) return;
    else if (e.key === 'ArrowLeft') flyOut(AGAIN, -1, 0);
    else if (e.key === 'ArrowRight') flyOut(GOOD, 1, 0);
    else if (e.key === 'ArrowUp') flyOut(EASY, 0, -1);
    else if (['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key)); // 2 = Hard, keyboard only
  });
}

// ---------- boot ----------
async function boot() {
  wire();
  await load();
  dealVoiceSlots(audioPool().length);
  // The system voice list can arrive after boot; re-split the deck once it does.
  if (window.speechSynthesis && window.speechSynthesis.addEventListener) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      const size = audioPool().length;
      if (size !== slotsFor) dealVoiceSlots(size);
    });
  }
  await renderHome();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
}
boot();
