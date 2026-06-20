'use strict';

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'hiit_workouts';

function loadWorkouts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveWorkouts(workouts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workouts));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Audio Engine ─────────────────────────────────────────────────────────────

let audioCtx = null;
const scheduledOscs = [];

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
}

function playBeep(time, freq, dur, vol = 0.5) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, time);
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
  osc.start(time);
  osc.stop(time + dur + 0.05);
  scheduledOscs.push(osc);
  osc.onended = () => {
    const i = scheduledOscs.indexOf(osc);
    if (i >= 0) scheduledOscs.splice(i, 1);
  };
}

function cancelAllAudio() {
  const now = audioCtx ? audioCtx.currentTime : 0;
  scheduledOscs.splice(0).forEach(osc => { try { osc.stop(now); } catch {} });
}

function scheduleBeepCountdown(t) {
  playBeep(t, 880, 0.07, 0.45);
}

function scheduleBeepChange(t) {
  playBeep(t,        660,  0.12, 0.5);
  playBeep(t + 0.14, 1320, 0.22, 0.5);
}

function scheduleBeepComplete(t) {
  playBeep(t,        523, 0.12, 0.5);
  playBeep(t + 0.18, 659, 0.12, 0.5);
  playBeep(t + 0.36, 784, 0.40, 0.6);
}

// ─── Timer State ──────────────────────────────────────────────────────────────

const T = {
  active:        false,
  paused:        false,
  workout:       null,
  segments:      [],   // [{label, start, end}] — seconds from workout start
  audioEvents:   [],   // [{time, type}] — seconds from workout start
  startTime:     0,    // Date.now() offset — elapsed = (Date.now() - startTime) / 1000
  audioStart:    0,    // audioCtx.currentTime at elapsed=0
  pausedElapsed: 0,
  nextEvtIdx:    0,
  rafId:         null,
  schedTimeout:  null,
  wakeLock:      null,
};

const LOOKAHEAD_S  = 4.0;  // schedule this far ahead during active play
const SCHED_MS     = 250;  // scheduler tick interval

function buildSegments(workout) {
  const segs = [];
  let t = 0;
  const rounds = Math.max(1, workout.rounds || 1);

  if (workout.leadIn > 0) {
    segs.push({ label: 'Get Ready', start: 0, end: workout.leadIn });
    t = workout.leadIn;
  }

  const ivs = workout.intervals;

  if (rounds <= 1 || !ivs.some(iv => iv.loop !== false)) {
    for (const iv of ivs) {
      segs.push({ label: iv.label, start: t, end: t + iv.duration });
      t += iv.duration;
    }
    return segs;
  }

  // Determine the loop block: from first looped interval to last looped interval
  const firstLoop = ivs.findIndex(iv => iv.loop !== false);
  let lastLoop = firstLoop;
  for (let i = ivs.length - 1; i >= 0; i--) {
    if (ivs[i].loop !== false) { lastLoop = i; break; }
  }

  // Pre-loop: intervals before the loop block, run once
  for (let i = 0; i < firstLoop; i++) {
    segs.push({ label: ivs[i].label, start: t, end: t + ivs[i].duration });
    t += ivs[i].duration;
  }

  // Loop block × rounds (all intervals from firstLoop..lastLoop)
  const loopIvs = ivs.slice(firstLoop, lastLoop + 1);
  for (let r = 0; r < rounds; r++) {
    for (const iv of loopIvs) {
      segs.push({ label: iv.label, start: t, end: t + iv.duration, round: r + 1, totalRounds: rounds });
      t += iv.duration;
    }
  }

  // Post-loop: intervals after the loop block, run once
  for (let i = lastLoop + 1; i < ivs.length; i++) {
    segs.push({ label: ivs[i].label, start: t, end: t + ivs[i].duration });
    t += ivs[i].duration;
  }

  return segs;
}

function buildAudioEvents(segments) {
  const events = [];
  segments.forEach((seg, idx) => {
    const { start, end } = seg;
    // Countdown beeps: 3, 2, 1 seconds before segment ends
    for (let i = 3; i >= 1; i--) {
      if (end - i > start) events.push({ time: end - i, type: 'countdown' });
    }
    events.push({ time: end, type: idx < segments.length - 1 ? 'change' : 'complete' });
  });
  return events.sort((a, b) => a.time - b.time);
}

function fireAudioEvent(type, t) {
  if (type === 'countdown') scheduleBeepCountdown(t);
  else if (type === 'change')   scheduleBeepChange(t);
  else if (type === 'complete') scheduleBeepComplete(t);
}

// Lookahead scheduler — called every SCHED_MS while active and not paused
function runScheduler() {
  clearTimeout(T.schedTimeout);
  if (!T.active || T.paused || !audioCtx) return;

  const until = audioCtx.currentTime + LOOKAHEAD_S;
  while (T.nextEvtIdx < T.audioEvents.length) {
    const ev  = T.audioEvents[T.nextEvtIdx];
    const evT = T.audioStart + ev.time;
    if (evT > until) break;
    // Allow a small grace window for events we just barely missed
    if (evT >= audioCtx.currentTime - 0.05) {
      fireAudioEvent(ev.type, Math.max(evT, audioCtx.currentTime + 0.01));
    }
    T.nextEvtIdx++;
  }

  if (T.nextEvtIdx < T.audioEvents.length) {
    T.schedTimeout = setTimeout(runScheduler, SCHED_MS);
  }
}

// When going to background, schedule all remaining events immediately so they
// fire even if JS is throttled/suspended by the OS
function scheduleAllRemaining() {
  if (!T.active || !audioCtx) return;
  while (T.nextEvtIdx < T.audioEvents.length) {
    const ev  = T.audioEvents[T.nextEvtIdx];
    const evT = T.audioStart + ev.time;
    if (evT >= audioCtx.currentTime - 0.05) {
      fireAudioEvent(ev.type, Math.max(evT, audioCtx.currentTime + 0.01));
    }
    T.nextEvtIdx++;
  }
}

// ─── Timer Display ────────────────────────────────────────────────────────────

function getElapsed() {
  return T.paused
    ? T.pausedElapsed
    : (Date.now() - T.startTime) / 1000;
}

function currentSegment(elapsed) {
  for (const seg of T.segments) {
    if (elapsed >= seg.start && elapsed < seg.end) return seg;
  }
  return T.segments[T.segments.length - 1] || null;
}

function nextSegment(seg) {
  const i = T.segments.indexOf(seg);
  return i >= 0 && i < T.segments.length - 1 ? T.segments[i + 1] : null;
}

function applyDisplay(seg, remaining, done = false) {
  const labelEl    = el('timer-segment-label');
  const roundEl    = el('timer-round');
  const countEl    = el('timer-countdown');
  const nextEl     = el('timer-next');
  const progressEl = el('timer-progress-bar');

  if (done) {
    labelEl.textContent    = 'Done!';
    roundEl.textContent    = '';
    countEl.textContent    = '0:00';
    nextEl.textContent     = '';
    progressEl.style.width = '100%';
    return;
  }

  if (!seg) return;
  labelEl.textContent = seg.label;
  roundEl.textContent = seg.totalRounds > 1 ? `Round ${seg.round} / ${seg.totalRounds}` : '';
  countEl.textContent = formatTime(remaining);

  const ns = nextSegment(seg);
  nextEl.textContent = ns ? `Next: ${ns.label}` : 'Last interval';

  const duration = seg.end - seg.start;
  const pct = duration > 0 ? ((duration - remaining) / duration) * 100 : 100;
  progressEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function timerLoop() {
  if (!T.active || T.paused) return;

  const elapsed = getElapsed();
  const total   = T.segments.length ? T.segments[T.segments.length - 1].end : 0;

  if (elapsed >= total) {
    applyDisplay(null, 0, true);
    el('btn-pause-resume').disabled = true;
    setTimeout(() => stopTimer(true), 2500);
    return;
  }

  const seg = currentSegment(elapsed);
  applyDisplay(seg, seg.end - elapsed);
  T.rafId = requestAnimationFrame(timerLoop);
}

// ─── Timer Lifecycle ──────────────────────────────────────────────────────────

async function startTimer(workout) {
  await ensureAudio();

  T.workout       = workout;
  T.segments      = buildSegments(workout);
  T.audioEvents   = buildAudioEvents(T.segments);
  T.startTime     = Date.now();
  T.audioStart    = audioCtx.currentTime;
  T.pausedElapsed = 0;
  T.nextEvtIdx    = 0;
  T.active        = true;
  T.paused        = false;

  showView('timer');
  el('timer-workout-name').textContent  = workout.name;
  el('btn-pause-resume').textContent    = 'Pause';
  el('btn-pause-resume').className      = 'btn-large';
  el('btn-pause-resume').disabled       = false;

  runScheduler();
  T.rafId = requestAnimationFrame(timerLoop);
  requestWakeLock();
}

function pauseTimer() {
  if (!T.active || T.paused) return;
  T.pausedElapsed = (Date.now() - T.startTime) / 1000; // compute BEFORE setting paused
  T.paused        = true;
  cancelAllAudio();
  clearTimeout(T.schedTimeout);
  cancelAnimationFrame(T.rafId);
  el('btn-pause-resume').textContent = 'Resume';
  el('btn-pause-resume').className   = 'btn-large resuming';
}

async function resumeTimer() {
  if (!T.active || !T.paused) return;
  await ensureAudio();
  const elapsed   = T.pausedElapsed;
  T.startTime     = Date.now() - elapsed * 1000;
  T.audioStart    = audioCtx.currentTime - elapsed;
  T.paused        = false;
  // Rewind the event index to the first event still in the future
  T.nextEvtIdx    = T.audioEvents.findIndex(e => e.time > elapsed);
  if (T.nextEvtIdx === -1) T.nextEvtIdx = T.audioEvents.length;

  el('btn-pause-resume').textContent = 'Pause';
  el('btn-pause-resume').className   = 'btn-large';

  runScheduler();
  T.rafId = requestAnimationFrame(timerLoop);
}

function stopTimer(completed = false) {
  T.active = false;
  T.paused = false;
  cancelAllAudio();
  clearTimeout(T.schedTimeout);
  cancelAnimationFrame(T.rafId);
  releaseWakeLock();
  if (!completed) showView('list');
  else setTimeout(() => showView('list'), 300);
}

// ─── Wake Lock ────────────────────────────────────────────────────────────────

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { T.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function releaseWakeLock() {
  T.wakeLock?.release().catch(() => {});
  T.wakeLock = null;
}

// Visibility change: going to background — schedule everything now.
// Coming to foreground — re-acquire wake lock and restart RAF.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (T.active && !T.paused) {
      clearTimeout(T.schedTimeout);
      scheduleAllRemaining();
    }
  } else {
    if (T.active && !T.paused) {
      requestWakeLock();
      cancelAnimationFrame(T.rafId);
      T.rafId = requestAnimationFrame(timerLoop);
      const resume = audioCtx?.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
      resume.catch(() => {}).then(() => {
        if (!T.active || T.paused || !audioCtx) return;
        const elapsed = getElapsed();
        T.audioStart   = audioCtx.currentTime - elapsed;
        T.nextEvtIdx   = T.audioEvents.findIndex(e => e.time > elapsed);
        if (T.nextEvtIdx === -1) T.nextEvtIdx = T.audioEvents.length;
        runScheduler();
      });
    }
  }
});

// ─── Confirmation Modal ───────────────────────────────────────────────────────

let confirmCallback = null;

function showConfirm(message, onConfirm) {
  el('confirm-message').textContent = message;
  el('confirm-overlay').classList.remove('hidden');
  confirmCallback = onConfirm;
}

el('confirm-cancel').addEventListener('click', () => {
  el('confirm-overlay').classList.add('hidden');
  confirmCallback = null;
});

el('confirm-ok').addEventListener('click', () => {
  el('confirm-overlay').classList.add('hidden');
  const cb = confirmCallback;
  confirmCallback = null;
  cb?.();
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function totalSeconds(workout) {
  const rounds = Math.max(1, workout.rounds || 1);
  const leadIn = workout.leadIn || 0;
  const ivs = workout.intervals;
  if (rounds <= 1 || !ivs.some(iv => iv.loop !== false)) {
    return leadIn + ivs.reduce((a, iv) => a + iv.duration, 0);
  }
  const firstLoop = ivs.findIndex(iv => iv.loop !== false);
  let lastLoop = firstLoop;
  for (let i = ivs.length - 1; i >= 0; i--) {
    if (ivs[i].loop !== false) { lastLoop = i; break; }
  }
  const preLoop  = ivs.slice(0, firstLoop).reduce((a, iv) => a + iv.duration, 0);
  const loopBody = ivs.slice(firstLoop, lastLoop + 1).reduce((a, iv) => a + iv.duration, 0);
  const postLoop = ivs.slice(lastLoop + 1).reduce((a, iv) => a + iv.duration, 0);
  return leadIn + preLoop + loopBody * rounds + postLoop;
}

function fmtDuration(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Views ────────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el(`view-${name}`).classList.add('active');
}

// ─── Workout List ─────────────────────────────────────────────────────────────

function renderList() {
  const workouts = loadWorkouts();
  const listEl   = el('workout-list');
  const emptyEl  = el('empty-state');
  listEl.innerHTML = '';

  if (workouts.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  for (const w of workouts) {
    const li = document.createElement('li');
    li.className = 'workout-card';
    li.innerHTML = `
      <div class="workout-card-info">
        <div class="workout-card-name">${escHtml(w.name)}</div>
        <div class="workout-card-meta">${w.intervals.length} interval${w.intervals.length !== 1 ? 's' : ''}${w.rounds > 1 ? ` × ${w.rounds}` : ''} · ${fmtDuration(totalSeconds(w))}</div>
      </div>
      <div class="workout-card-actions">
        <button class="btn-card-action" data-action="edit"   data-id="${w.id}" title="Edit">✎</button>
        <button class="btn-card-action btn-card-delete" data-action="delete" data-id="${w.id}" title="Delete">✕</button>
        <button class="btn-play"        data-action="play"   data-id="${w.id}" title="Start">▶</button>
      </div>`;
    listEl.appendChild(li);
  }
}

// ─── Edit View ────────────────────────────────────────────────────────────────

let editingId = null;

function openEdit(workout = null) {
  editingId = workout?.id ?? null;
  el('edit-heading').textContent  = workout ? 'Edit Workout' : 'New Workout';
  el('field-name').value          = workout?.name    ?? '';
  el('field-leadin').value        = workout?.leadIn  ?? 0;
  el('field-rounds').value        = workout?.rounds  ?? 1;
  renderIntervalEditor(workout?.intervals ?? [{ label: 'Work', duration: 20, loop: true }, { label: 'Rest', duration: 10, loop: true }]);
  showView('edit');
}

function renderIntervalEditor(intervals) {
  const listEl = el('interval-list');
  listEl.innerHTML = '';
  intervals.forEach(iv => appendIntervalRow(iv.label, iv.duration, iv.loop !== false));
}

function appendIntervalRow(label = '', duration = 20, loop = true) {
  const listEl = el('interval-list');
  const li = document.createElement('li');
  li.className = 'interval-row';
  li.innerHTML = `
    <input class="inp-label"    type="text"   value="${escHtml(label)}" placeholder="Label">
    <input class="inp-duration" type="number" min="1" max="3600" value="${duration}">
    <button class="btn-loop-toggle${loop ? ' in-loop' : ''}" title="Include in loop">↻</button>
    <button class="btn-row-del" title="Remove">✕</button>`;
  listEl.appendChild(li);
}

function collectEditForm() {
  const name   = el('field-name').value.trim();
  const leadIn = Math.max(0, parseInt(el('field-leadin').value, 10) || 0);
  const rounds = Math.max(1, parseInt(el('field-rounds').value, 10) || 1);
  const rows   = el('interval-list').querySelectorAll('.interval-row');
  const intervals = Array.from(rows).map(row => ({
    label:    row.querySelector('.inp-label').value.trim() || 'Interval',
    duration: Math.max(1, parseInt(row.querySelector('.inp-duration').value, 10) || 1),
    loop:     row.querySelector('.btn-loop-toggle').classList.contains('in-loop'),
  }));
  return { name, leadIn, rounds, intervals };
}

function saveEdit() {
  const data = collectEditForm();
  if (!data.name)                  { alert('Please enter a workout name.'); return; }
  if (data.intervals.length === 0) { alert('Add at least one interval.');   return; }

  const workouts = loadWorkouts();
  if (editingId) {
    const i = workouts.findIndex(w => w.id === editingId);
    if (i >= 0) workouts[i] = { ...workouts[i], ...data };
  } else {
    workouts.push({ id: uid(), ...data });
  }
  saveWorkouts(workouts);
  renderList();
  showView('list');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

el('btn-new').addEventListener('click', () => openEdit());
el('btn-new-empty').addEventListener('click', () => openEdit());

el('btn-edit-cancel').addEventListener('click', () => { renderList(); showView('list'); });
el('btn-edit-save').addEventListener('click', saveEdit);

el('btn-add-interval').addEventListener('click', () => appendIntervalRow());

el('interval-list').addEventListener('click', e => {
  const delBtn = e.target.closest('.btn-row-del');
  if (delBtn) { delBtn.closest('.interval-row').remove(); return; }
  const loopBtn = e.target.closest('.btn-loop-toggle');
  if (loopBtn) loopBtn.classList.toggle('in-loop');
});

// ─── Start Screen ─────────────────────────────────────────────────────────────

let pendingWorkout = null;

function openStartScreen(workout) {
  pendingWorkout = workout;
  el('start-workout-name').textContent = workout.name;

  const rounds = Math.max(1, workout.rounds || 1);
  const ivCount = workout.intervals.length;
  const total = totalSeconds(workout);

  el('start-stats').innerHTML = `
    <div class="start-stat">
      <span class="start-stat-label">Duration</span>
      <span class="start-stat-value">${fmtDuration(total)}</span>
    </div>
    <div class="start-stat">
      <span class="start-stat-label">Intervals</span>
      <span class="start-stat-value">${ivCount}</span>
    </div>
    ${rounds > 1 ? `<div class="start-stat">
      <span class="start-stat-label">Rounds</span>
      <span class="start-stat-value">${rounds}</span>
    </div>` : ''}
    ${workout.leadIn > 0 ? `<div class="start-stat">
      <span class="start-stat-label">Lead-in</span>
      <span class="start-stat-value">${workout.leadIn}s</span>
    </div>` : ''}
  `;

  showView('start');
}

el('btn-start-back').addEventListener('click', () => {
  pendingWorkout = null;
  showView('list');
});

el('btn-go').addEventListener('click', () => {
  if (pendingWorkout) startTimer(pendingWorkout);
});

el('workout-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  const workouts = loadWorkouts();
  const w = workouts.find(w => w.id === id);

  if (action === 'play'   && w) openStartScreen(w);
  if (action === 'edit'   && w) openEdit(w);
  if (action === 'delete' && w) {
    showConfirm(`Delete "${w.name}"?`, () => {
      saveWorkouts(workouts.filter(x => x.id !== id));
      renderList();
    });
  }
});

el('btn-timer-stop').addEventListener('click', () => {
  showConfirm('Stop this workout?', () => stopTimer(false));
});

el('btn-pause-resume').addEventListener('click', () => {
  if (T.paused) resumeTimer(); else pauseTimer();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderList();
