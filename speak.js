// Alternative pronunciation via the system's speech synthesizer.
// We deliberately keep only Castilian (es-ES) quality voices: that's the accent
// where z and c-before-e/i are pronounced [θ] — the English "th" in "think" —
// the distinción the recorded deck uses. Latin-American voices (es-MX, es-419…)
// use seseo and would say those letters as [s], so they are excluded on purpose.
//
// The system exposes many es-ES "novelty" voices (Eddy, Flo, Grandma, Rocko…)
// that sound robotic/joke-like, so we whitelist the good ones by name instead of
// taking every es-ES voice.

const GOOD_CASTILIAN = [/marisol/i, /m[oó]nica/i]; // Premium / Enhanced quality
const PREFERENCE = [/marisol/i, /m[oó]nica/i];     // order when we need just one
// Mónica clicks/pops at the end of an utterance in the browser's live synthesis
// (the recorded voice itself is clean — verified on rendered samples). Keep her
// out of the mix when a cleaner voice exists; use her only as a last resort.
const NOISY = [/m[oó]nica/i];

export function createSpeaker() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const supported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

  let list = []; // deduped, quality-ordered es-ES voices

  function refresh() {
    if (!supported) return;
    const all = synth.getVoices() || [];
    const es = all.filter((v) => /es[-_]es/i.test(v.lang || ''));
    const good = es.filter((v) => GOOD_CASTILIAN.some((re) => re.test(v.name || '')));
    // dedupe by name, keep first occurrence
    const seen = new Set();
    const uniq = [];
    for (const v of good) {
      if (!seen.has(v.name)) { seen.add(v.name); uniq.push(v); }
    }
    uniq.sort((a, b) => rank(a) - rank(b));
    list = uniq;
  }
  function rank(v) {
    const i = PREFERENCE.findIndex((re) => re.test(v.name || ''));
    return i === -1 ? 99 : i;
  }

  if (supported) {
    refresh();
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refresh);
    else synth.onvoiceschanged = refresh;
  }

  // Must run inside a user gesture once, so iOS lets us speak later.
  function warmup() {
    if (!supported) return;
    if (!list.length) refresh();
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      if (list[0]) u.voice = list[0];
      synth.speak(u);
    } catch {}
  }

  // Speak with a specific voice (defaults to the best available). Resolves true
  // if it actually spoke, false if unavailable/failed (caller falls back).
  function speak(text, { rate = 1, voice = null } = {}) {
    return new Promise((resolve) => {
      if (!supported || !text) { resolve(false); return; }
      if (!list.length) refresh();
      const v = voice || list[0];
      if (!v) { resolve(false); return; }
      try { synth.cancel(); } catch {}
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v;
      u.lang = v.lang || 'es-ES';
      u.rate = rate;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      synth.speak(u);
    });
  }

  function stop() {
    if (supported) { try { synth.cancel(); } catch {} }
  }

  // Voices to actually rotate through in the mix: drop the noisy ones unless
  // they're all we have.
  function mixVoices() {
    const clean = list.filter((v) => !NOISY.some((re) => re.test(v.name || '')));
    return clean.length ? clean : list.slice();
  }

  return {
    get available() { return supported && list.length > 0; },
    voices() { return list.slice(); },     // all Castilian quality voices, best first
    mixVoices,                             // voices safe to rotate in the mix
    best() { return list[0] || null; },
    warmup,
    speak,
    stop,
    refresh,
  };
}
