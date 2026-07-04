'use strict'

// =======================================================================
// Tunables — the whole detection/timing loop is governed by these.
// =======================================================================
const ARRIVE_DEG = 30 // gravity-vector change from the previous position that counts as "moved"
const STABLE_DEG = 6 // max jitter (deg) across the sample window to count as "still"
const SETTLE_MS = 2000 // must stay in the new position, still, this long before a hold starts
const ARM_GRACE_MS = 3500 // ignore stillness for this long after the setup prompt (you're getting set)
const HOLD_LONG = 30 // therapeutic hold seconds
const HOLD_SETTLE = 20 // settle seconds after sitting up
const PULSE_MS = 4500 // gap between soft "still listening" pulses
const REPROMPT_MS = 24000 // re-play the instruction if still seeking this long
const HARD_ADVANCE_MS = 48000 // failsafe: never get stuck seeking forever
const NOSENSOR_ARM_MS = 6000 // timed-mode fallback: begin after this
const NOSENSOR_WAIT_MS = 10000 // timed-mode fallback: advance a move after this
const TICK_MS = 100

const PHASE = { IDLE: 'IDLE', ARMING: 'ARMING', SEEK: 'SEEK', HOLD: 'HOLD', ADVANCING: 'ADVANCING', DONE: 'DONE' }

// =======================================================================
// Step model (parameterized by affected ear)
// =======================================================================
function buildSteps(ear) {
  const A = cap(ear), O = cap(ear === 'left' ? 'right' : 'left')
  return [
    { id: 'setup', arming: true, posture: 'sitting', clip: `${ear}/setup`, title: 'Get ready',
      html: `Sit on the edge of the bed, phone at your <span class="dir">${A} ear</span>. Turn your head <span class="dir">45° toward your ${A} side</span> and hold still — I'll begin on my own.` },
    { id: 'lie-back', hold: HOLD_LONG, posture: 'lie-back', clip: `${ear}/lie_back`, title: 'Lie back',
      html: `Keeping your head turned <span class="dir">45° toward your ${A} side</span>, lie back quickly so it hangs slightly off the edge.` },
    { id: 'turn-head', hold: HOLD_LONG, posture: 'turn-head', clip: `${ear}/turn_head`, title: 'Turn your head',
      html: `Turn <span class="dir">just your head</span> about 90° toward your <span class="dir">${O} side</span> — body stays flat — looking part-way toward the floor.` },
    { id: 'roll', hold: HOLD_LONG, posture: 'roll', clip: `${ear}/roll`, title: 'Roll onto your side',
      html: `Roll your <span class="dir">whole body</span> onto your <span class="dir">${O} side</span>, until you're facing down toward the floor.` },
    { id: 'sit-up', hold: HOLD_SETTLE, settle: true, posture: 'sitting', clip: 'shared/sit_up', title: 'Sit up slowly',
      html: `Slowly sit up, back to the edge of the bed. Stay sitting and let it settle before you stand.` },
  ]
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

const MOVE_LABELS = {
  setup: { move: 'Get ready', count: '' }, 'lie-back': { move: 'Move 1 of 3', count: '1 / 3' },
  'turn-head': { move: 'Move 2 of 3', count: '2 / 3' }, roll: { move: 'Move 3 of 3', count: '3 / 3' },
  'sit-up': { move: 'Finish', count: '' },
}

const POSTURES = {
  sitting: `<path class="bed" d="M20 130 H120 V95" /><path class="body" d="M120 92 V55" /><circle class="head" cx="120" cy="42" r="14" />`,
  'lie-back': `<path class="bed" d="M60 96 H185 M60 96 V132" /><path class="body" d="M175 78 H78" /><circle class="head" cx="66" cy="82" r="14" /><path class="arrow" d="M120 52 q-40 -6 -58 22" /><path class="arrow" d="M62 66 l0 12 l11 -4" />`,
  'turn-head': `<path class="bed" d="M40 96 H185" /><path class="body" d="M175 82 H80" /><circle class="head" cx="70" cy="82" r="14" /><path class="arrow" d="M70 55 a20 20 0 0 1 20 20" /><path class="arrow" d="M92 70 l-2 8 l-8 -3" />`,
  roll: `<path class="bed" d="M40 100 H185" /><path class="body" d="M170 88 H82" /><circle class="head" cx="72" cy="90" r="14" /><path class="arrow" d="M120 62 a26 24 0 0 1 4 22" /><path class="arrow" d="M124 84 l3 -9 l7 5" />`,
}

// =======================================================================
// State
// =======================================================================
const state = {
  ear: null, steps: [], index: 0, phase: PHASE.IDLE,
  reference: null, // committed gravity vector for the current move's "start"
  phaseAt: 0, seekOkSince: 0, stillSince: 0, lastPulse: 0, reprompted: false,
  holdEndsAt: 0, holdTotal: 0, lastTickSec: 0,
  haveMotion: false, sensorMode: true,
}
const $ = (id) => document.getElementById(id)
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id)) }

// =======================================================================
// Sensors
// =======================================================================
let gravity = null
let orient = { beta: 0, gamma: 0 }
const recent = []
function normalize(v) { const m = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / m, y: v.y / m, z: v.z / m } }
function angle(a, b) { if (!a || !b) return 0; const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)); return (Math.acos(d) * 180) / Math.PI }
function curVec() {
  if (recent.length < 3) return gravity
  let x = 0, y = 0, z = 0, n = Math.min(recent.length, 10)
  for (let i = recent.length - n; i < recent.length; i++) { x += recent[i].x; y += recent[i].y; z += recent[i].z }
  return normalize({ x, y, z })
}
function isStable() {
  if (recent.length < 12) return false
  const m = curVec()
  let max = 0
  for (const v of recent) max = Math.max(max, angle(v, m))
  return max < STABLE_DEG
}
function onMotion(e) {
  const g = e.accelerationIncludingGravity
  if (!g || (g.x === null && g.y === null && g.z === null)) return
  state.haveMotion = true
  gravity = normalize({ x: g.x || 0, y: g.y || 0, z: g.z || 0 })
  recent.push(gravity); if (recent.length > 30) recent.shift()
}
function onOrientation(e) { orient.beta = e.beta || 0; orient.gamma = e.gamma || 0 }
function requestSensors() {
  const DME = window.DeviceMotionEvent, DOE = window.DeviceOrientationEvent, asks = []
  if (DME && typeof DME.requestPermission === 'function') asks.push(DME.requestPermission())
  if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission())
  if (!asks.length) { attach(); return Promise.resolve(true) }
  return Promise.all(asks).then((r) => { if (r.every((x) => x === 'granted')) { attach(); return true } return false }).catch(() => false)
}
function attach() {
  window.addEventListener('devicemotion', onMotion, true)
  window.addEventListener('deviceorientation', onOrientation, true)
}

// =======================================================================
// Audio — pre-generated speech clips + a small, distinct cue vocabulary
// =======================================================================
const CLIP_NAMES = [
  'shared/audio_test', 'shared/starting', 'shared/hold30', 'shared/reminder', 'shared/sit_up', 'shared/settle', 'shared/done',
  'left/setup', 'left/lie_back', 'left/turn_head', 'left/roll',
  'right/setup', 'right/lie_back', 'right/turn_head', 'right/roll',
]
const CLIPS = {}
function preloadClips() { for (const n of CLIP_NAMES) { const a = new Audio(`audio/${n}.m4a`); a.preload = 'auto'; CLIPS[n] = a } }
let currentClip = null
function playClip(name) {
  return new Promise((res) => {
    const a = CLIPS[name]
    if (!a) return res()
    try { if (currentClip && currentClip !== a) { currentClip.pause(); currentClip.currentTime = 0 } } catch (_) {}
    currentClip = a
    try { a.currentTime = 0 } catch (_) {}
    a.onended = () => res()
    const p = a.play()
    if (p && p.catch) p.catch(() => res())
  })
}
function stopClip() { try { if (currentClip) { currentClip.pause(); currentClip.currentTime = 0 } } catch (_) {} }

let audioCtx = null
function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume() } catch (_) {} }
function tone(freq, dur, gain, delay) {
  if (!audioCtx) return
  const t = audioCtx.currentTime + (delay || 0)
  const o = audioCtx.createOscillator(), g = audioCtx.createGain()
  o.type = 'sine'; o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain || 0.22, t + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur / 1000)
  o.connect(g); g.connect(audioCtx.destination)
  o.start(t); o.stop(t + dur / 1000 + 0.02)
}
// distinct vocabulary — each event sounds unmistakably like itself:
const cueAttention = () => { tone(523, 110, 0.16); tone(659, 150, 0.18, 0.12) } // new instruction: two quick rising notes
const cueLock = () => tone(784, 200, 0.22) // position captured / hold starting: one clear note
const cueTick = () => tone(392, 55, 0.08) // quiet mid-hold tick
const cueCountdown = () => tone(660, 90, 0.16) // final 3 seconds
const cueComplete = () => { tone(523, 380, 0.16); tone(659, 380, 0.16); tone(784, 420, 0.18) } // hold done: a resolved chord (played together)
const cuePulse = () => tone(300, 45, 0.045) // gentle "still listening"
const cueDone = () => { tone(659, 150, 0.18); tone(784, 150, 0.18, 0.15); tone(988, 160, 0.2, 0.3); tone(1319, 340, 0.2, 0.46) }
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p) }

// =======================================================================
// Wake lock — keep the screen (and audio) alive during the maneuver
// =======================================================================
let wakeLock = null
async function acquireWake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen') } catch (_) {} }
function releaseWake() { try { if (wakeLock) wakeLock.release() } catch (_) {} wakeLock = null }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running() && !wakeLock) acquireWake()
})
function running() { return state.phase !== PHASE.IDLE && state.phase !== PHASE.DONE }

// =======================================================================
// The loop — one clock, one switch
// =======================================================================
let loop = null
function startLoop() { clearInterval(loop); loop = setInterval(tick, TICK_MS) }
function stopLoop() { clearInterval(loop); loop = null }

function enterStep(i) {
  state.index = i
  const step = state.steps[i]
  const lbl = MOVE_LABELS[step.id] || { move: step.title, count: '' }
  $('run-move').textContent = lbl.move
  $('run-count').textContent = lbl.count
  $('run-title').textContent = step.title
  $('run-instruction').innerHTML = step.html
  $('run-posture').innerHTML = POSTURES[step.posture] || POSTURES.sitting
  hideTimer()
  state.phaseAt = Date.now(); state.seekOkSince = 0; state.reprompted = false; state.lastPulse = Date.now()

  if (step.arming) {
    state.phase = PHASE.ARMING
    setStatus('wait', 'Get set — I’ll begin when you hold still')
    playClip(step.clip)
  } else {
    state.phase = PHASE.SEEK
    setStatus('wait', 'Move into position…')
    cueAttention(); setTimeout(() => { if (state.index === i) playClip(step.clip) }, 380)
  }
}

function arm() {
  state.phase = PHASE.ADVANCING
  state.reference = curVec() || { x: 0, y: 1, z: 0 }
  cueLock(); vibrate(40)
  playClip('shared/starting').then(() => { if (state.phase === PHASE.ADVANCING) enterStep(1) })
}

function lock() {
  const step = state.steps[state.index]
  state.phase = PHASE.HOLD
  cueLock(); vibrate(60)
  state.holdTotal = step.hold
  state.holdEndsAt = Date.now() + step.hold * 1000
  state.lastTickSec = step.hold + 1
  showTimer()
  setStatus('hold', 'Hold still…')
  playClip(step.settle ? 'shared/settle' : 'shared/hold30')
}

function confirm() {
  state.phase = PHASE.ADVANCING
  hideTimer()
  cueComplete(); vibrate([80, 60, 80])
  state.reference = curVec()
  const next = state.index + 1
  if (next >= state.steps.length) { setTimeout(finishRun, 900); return }
  setTimeout(() => { if (state.phase === PHASE.ADVANCING) enterStep(next) }, 1300) // let the chord ring, then announce next
}

function pulse() { if (Date.now() - state.lastPulse > PULSE_MS) { state.lastPulse = Date.now(); cuePulse() } }

function tick() {
  const now = Date.now()
  // keep a running "how long have we been still" clock
  if (isStable()) { if (!state.stillSince) state.stillSince = now } else state.stillSince = 0
  updateDebug()

  if (state.phase === PHASE.ARMING) {
    const el = now - state.phaseAt
    if (state.sensorMode && state.haveMotion) {
      if (el > ARM_GRACE_MS && state.stillSince && now - state.stillSince >= SETTLE_MS) return arm()
    } else if (el > NOSENSOR_ARM_MS) return arm()
    pulse()
  } else if (state.phase === PHASE.SEEK) {
    const el = now - state.phaseAt
    if (state.sensorMode && state.haveMotion && state.reference) {
      const moved = angle(curVec(), state.reference) > ARRIVE_DEG
      if (moved && isStable()) {
        if (!state.seekOkSince) state.seekOkSince = now
        else if (now - state.seekOkSince >= SETTLE_MS) return lock()
      } else state.seekOkSince = 0
      if (el > HARD_ADVANCE_MS) return lock()
    } else if (el > NOSENSOR_WAIT_MS) return lock()
    if (!state.reprompted && el > REPROMPT_MS) { state.reprompted = true; playClip('shared/reminder') }
    pulse()
  } else if (state.phase === PHASE.HOLD) {
    const remMs = state.holdEndsAt - now
    const rem = Math.ceil(remMs / 1000)
    updateRing(Math.max(0, remMs) / (state.holdTotal * 1000))
    $('timer-count').textContent = Math.max(0, rem)
    if (rem < state.lastTickSec) {
      state.lastTickSec = rem
      if (rem > 0 && rem <= 3) cueCountdown()
      else if (rem > 0 && rem % 5 === 0) cueTick()
    }
    if (remMs <= 0) return confirm()
  }
}

// =======================================================================
// Timer ring + mini level
// =======================================================================
const C = 2 * Math.PI * 56
$('timer-prog').style.transition = 'none'
function showTimer() { $('run-timer').classList.add('on') }
function hideTimer() { $('run-timer').classList.remove('on') }
function updateRing(frac) { $('timer-prog').style.strokeDasharray = C; $('timer-prog').style.strokeDashoffset = C * (1 - frac) }

const lc = $('run-level').getContext('2d')
const ldpr = Math.min(window.devicePixelRatio || 1, 3)
$('run-level').width = 56 * ldpr; $('run-level').height = 56 * ldpr; lc.setTransform(ldpr, 0, 0, ldpr, 0, 0)
function drawLevel() {
  const s = 56, c = s / 2, R = 24
  lc.clearRect(0, 0, s, s)
  lc.strokeStyle = '#d9e2e0'; lc.lineWidth = 1.5; lc.beginPath(); lc.arc(c, c, R, 0, Math.PI * 2); lc.stroke()
  const gx = Math.max(-1, Math.min(1, orient.gamma / 90)), gy = Math.max(-1, Math.min(1, orient.beta / 90))
  lc.beginPath(); lc.arc(c + gx * (R - 6), c + gy * (R - 6), 6, 0, Math.PI * 2)
  lc.fillStyle = state.phase === PHASE.HOLD ? '#2f9e6f' : '#0d8a80'; lc.fill()
  requestAnimationFrame(drawLevel)
}
requestAnimationFrame(drawLevel)

function setStatus(kind, text) { $('run-status').className = 'pill ' + (kind === 'hold' ? 'hold' : 'wait'); $('run-status-text').textContent = text }

// =======================================================================
// Run lifecycle
// =======================================================================
function startRun() {
  show('s-run')
  state.phase = PHASE.IDLE; state.reference = null; state.stillSince = 0
  state.sensorMode = true
  setTimeout(() => { if (!state.haveMotion) { state.sensorMode = false; $('run-level-text').textContent = 'No sensor — timed guidance' } }, 2500)
  acquireWake()
  startLoop()
  enterStep(0)
}
function finishRun() { stopLoop(); hideTimer(); state.phase = PHASE.DONE; releaseWake(); cueDone(); playClip('shared/done'); show('s-done') }
function quitRun() { stopLoop(); hideTimer(); stopClip(); releaseWake(); state.phase = PHASE.IDLE; show('s-welcome') }
function runBack() {
  if (state.index <= 0) { stopLoop(); hideTimer(); releaseWake(); state.phase = PHASE.IDLE; show('s-place'); return }
  const prev = state.index - 1
  state.reference = state.steps[prev].arming ? null : curVec()
  enterStep(prev)
}

// =======================================================================
// Debug mode (?debug) — drive the whole loop from a desktop browser
// =======================================================================
function initDebug() {
  if (!/[?&]debug/.test(location.search)) return
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;background:#0e1f1d;color:#cfe;font:12px/1.4 monospace;padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center'
  bar.innerHTML = `<span id="dbg-read" style="flex:1;min-width:100%">debug</span>
    <button data-act="lock">force lock/arm</button>
    <button data-act="done">force hold done</button>
    <button data-act="prev">◀ prev</button>
    <button data-act="next">next ▶</button>
    <label><input type="checkbox" id="dbg-nosensor"> no-sensor</label>`
  document.body.appendChild(bar)
  bar.querySelectorAll('button').forEach((b) => b.style.cssText = 'font:11px monospace;padding:5px 8px;background:#0d8a80;color:#fff;border:none;border-radius:5px')
  bar.onclick = (e) => {
    const act = e.target.dataset && e.target.dataset.act
    if (act === 'lock') { if (state.phase === PHASE.ARMING) arm(); else if (state.phase === PHASE.SEEK) lock() }
    else if (act === 'done') { if (state.phase === PHASE.HOLD) confirm() }
    else if (act === 'next') { if (state.index < state.steps.length - 1) { state.reference = curVec(); enterStep(state.index + 1) } }
    else if (act === 'prev') runBack()
  }
  $('dbg-nosensor').onchange = (e) => { state.sensorMode = !e.target.checked }
}
function updateDebug() {
  const r = $('dbg-read')
  if (!r) return
  const ang = state.reference ? angle(curVec(), state.reference).toFixed(0) : '–'
  const rem = state.phase === PHASE.HOLD ? Math.ceil((state.holdEndsAt - Date.now()) / 1000) : '–'
  const still = state.stillSince ? ((Date.now() - state.stillSince) / 1000).toFixed(1) : '0'
  r.textContent = `phase=${state.phase} step=${state.steps[state.index] ? state.steps[state.index].id : '-'} Δref=${ang}° stable=${isStable()} still=${still}s hold=${rem} sensor=${state.sensorMode}/${state.haveMotion}`
}

// =======================================================================
// Wiring
// =======================================================================
$('go-ear').onclick = () => show('s-ear')
$('back-welcome').onclick = () => show('s-welcome')
$('back-ear').onclick = () => show('s-ear')
$('back-overview').onclick = () => show('s-overview')
$('back-audio').onclick = () => show('s-audio')

document.querySelectorAll('.choice').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('.choice').forEach((x) => x.classList.remove('selected'))
    c.classList.add('selected')
    state.ear = c.dataset.ear
    state.steps = buildSteps(state.ear)
    $('go-overview').disabled = false
  }
})
$('go-overview').onclick = () => show('s-overview')
$('go-audio').onclick = () => show('s-audio')

$('test-sound').onclick = () => {
  unlockAudio(); cueLock()
  playClip('shared/audio_test')
  $('audio-status').className = 'pill hold'
  $('audio-text').textContent = 'Hear that? You’re set. Tap again to re-test.'
  $('go-place').disabled = false
}
$('go-place').onclick = () => { if (state.ear) $('perm-side').textContent = state.ear; show('s-place') }

$('go-run').onclick = () => {
  unlockAudio()
  const status = $('perm-status'), text = $('perm-text')
  text.textContent = 'Requesting motion access…'
  requestSensors().then((ok) => {
    if (ok) { status.className = 'pill hold'; text.textContent = 'Sensors on' }
    else { status.className = 'pill'; text.textContent = 'No motion access — I’ll guide you on a timer instead.' }
    startRun()
  })
}

$('run-back').onclick = runBack
$('run-restart').onclick = () => startRun()
$('run-quit').onclick = quitRun
$('done-restart').onclick = () => startRun()
$('done-home').onclick = () => show('s-welcome')

preloadClips()
initDebug()
