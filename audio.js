// Reliable audio playback: never truncates (waits for `ended`), unlocks iOS autoplay,
// preloads upcoming clips. Clips live under `audio/<filename>`.

export function createAudioPlayer(basePath = 'audio/') {
  const el = new Audio();
  el.preload = 'auto';
  el.autoplay = false;

  const preloaded = new Map(); // filename -> Audio kept warm
  let seqToken = 0; // bumps whenever a new sequence/stop supersedes the current one
  let killCurrent = null; // resolves the in-flight single-clip promise early
  let unlocked = false;

  const url = (name) => basePath + encodeURIComponent(name);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Must run inside a user gesture once, to satisfy iOS autoplay policy.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    el.muted = true;
    const p = el.play();
    const restore = () => { try { el.pause(); } catch {} el.currentTime = 0; el.muted = false; };
    if (p && p.then) p.then(restore).catch(() => { el.muted = false; });
    else restore();
  }

  function preload(name) {
    if (!name || preloaded.has(name)) return;
    const a = new Audio();
    a.preload = 'auto';
    a.src = url(name);
    a.load();
    preloaded.set(name, a);
    if (preloaded.size > 8) preloaded.delete(preloaded.keys().next().value);
  }

  // Play one clip fully. Resolves on `ended`, on error, or when superseded.
  function playOnce(name) {
    if (killCurrent) killCurrent(); // cleanly end whatever was playing
    return new Promise((resolve) => {
      const finish = () => {
        el.removeEventListener('ended', finish);
        el.removeEventListener('error', finish);
        if (killCurrent === finish) killCurrent = null;
        resolve();
      };
      killCurrent = finish;
      el.addEventListener('ended', finish);
      el.addEventListener('error', finish);
      try { el.pause(); } catch {}
      el.src = url(name);
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => finish()); // autoplay blocked -> continue flow
    });
  }

  // Single clip; cancels any running sequence.
  function play(name) {
    seqToken++;
    return name ? playOnce(name) : Promise.resolve();
  }

  // Clips back to back, each fully, with an optional gap between them.
  async function playSequence(names, gapMs = 250) {
    const my = ++seqToken;
    const list = names.filter(Boolean);
    for (let idx = 0; idx < list.length; idx++) {
      if (my !== seqToken) return;
      await playOnce(list[idx]);
      if (my !== seqToken) return;
      if (idx < list.length - 1 && gapMs) await sleep(gapMs);
    }
  }

  function stop() {
    seqToken++;
    if (killCurrent) killCurrent();
    try { el.pause(); } catch {}
  }

  return { unlock, preload, play, playSequence, stop };
}
