'use strict'

// ---- tuning ------------------------------------------------------------
const ARRIVE_DEG = 28 // gravity-vector change from previous position that counts as "moved"
const STABLE_DEG = 4 // max jitter (deg) over the window to count as "held still"
const STABLE_MS = 1200 // how long it must stay stable before the hold starts
const HOLD_LONG = 30 // seconds for the therapeutic positions
const HOLD_SETTLE = 20 // seconds to settle after sitting up

// ---- step model (parameterized by affected ear) ------------------------
// affected = ear with the most vertigo; other = ear with the least.
function buildSteps(affected) {
  const other = affected === 'left' ? 'right' : 'left'
  const A = cap(affected)
  const O = cap(other)
  return [
    {
      id: 'setup',
      phase: 'Position',
      title: 'Get ready',
      instructionHtml: `Sit on the edge of the bed. Turn your head <span class="dir">45° toward your ${A} side</span> — the ear with the most vertigo. Hold the phone flat against your <span class="dir">${A} ear</span>, screen facing out.`,
      speech: `Sit on the edge of the bed. Turn your head 45 degrees toward your ${affected} side. Hold the phone flat against your ${affected} ear, on the side of your head. Tap when you are ready.`,
      manual: true,
      posture: 'sitting',
    },
    {
      id: 'lie-back',
      phase: 'Lie back',
      title: 'Lie back',
      instructionHtml: `Keeping your head turned <span class="dir">45° toward your ${A} side</span>, lie back quickly so your head hangs slightly off the edge. Then hold still.`,
      speech: `Now lie back quickly, keeping your head turned toward your ${affected} side, so your head hangs slightly off the edge.`,
      hold: HOLD_LONG,
      posture: 'lie-back',
    },
    {
      id: 'turn-head',
      phase: 'Turn your head',
      title: 'Turn your head',
      instructionHtml: `Slowly turn your head <span class="dir">toward your ${O} side</span>, about 90°, until you're looking part-way toward the floor. Keep it there.`,
      speech: `Slowly turn your head about 90 degrees toward your ${other} side, until you are looking part way toward the floor. Hold it there.`,
      hold: HOLD_LONG,
      posture: 'turn-head',
    },
    {
      id: 'roll',
      phase: 'Roll to your side',
      title: 'Roll onto your side',
      instructionHtml: `Roll onto your <span class="dir">${O} side</span> and turn to look down at the floor. Keep still.`,
      speech: `Roll onto your ${other} side and turn to look down at the floor. Keep still.`,
      hold: HOLD_LONG,
      posture: 'roll',
    },
    {
      id: 'sit-up',
      phase: 'Sit up',
      title: 'Sit up slowly',
      instructionHtml: `Slowly return to sitting on the edge of the bed. Stay sitting and let it settle before you stand.`,
      speech: `Slowly sit up and return to the edge of the bed. Stay sitting while it settles.`,
      hold: HOLD_SETTLE,
      posture: 'sitting',
    },
  ]
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

// ---- posture diagrams --------------------------------------------------
const POSTURES = {
  sitting: `
    <path class="bed" d="M20 130 H120 V95" />
    <path class="body" d="M120 92 V55" />
    <circle class="head" cx="120" cy="42" r="14" />`,
  'lie-back': `
    <path class="bed" d="M60 96 H185 M60 96 V132" />
    <path class="body" d="M175 78 H78" />
    <circle class="head" cx="66" cy="82" r="14" />
    <path class="arrow" d="M120 52 q-40 -6 -58 22" />
    <path class="arrow" d="M62 66 l0 12 l11 -4" />`,
  'turn-head': `
    <path class="bed" d="M40 96 H185" />
    <path class="body" d="M175 82 H80" />
    <circle class="head" cx="70" cy="82" r="14" />
    <path class="arrow" d="M70 55 a20 20 0 0 1 20 20" />
    <path class="arrow" d="M92 70 l-2 8 l-8 -3" />`,
  roll: `
    <path class="bed" d="M40 100 H185" />
    <path class="body" d="M170 88 H82" />
    <circle class="head" cx="72" cy="90" r="14" />
    <path class="arrow" d="M120 62 a26 24 0 0 1 4 22" />
    <path class="arrow" d="M124 84 l3 -9 l7 5" />`,
}

// ---- app state ---------------------------------------------------------
const state = {
  affected: null,
  steps: [],
  index: 0,
  runPhase: 'idle', // idle | waiting | holding | complete
  reference: null, // last committed gravity vector
  haveMotion: false,
}

const $ = (id) => document.getElementById(id)

function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === screenId))
}

// ---- sensors -----------------------------------------------------------
let gravity = null // {x,y,z} normalized
let orient = { beta: 0, gamma: 0 }
const recent = []

function normalize(v) {
  const m = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / m, y: v.y / m, z: v.z / m }
}
function angleBetween(a, b) {
  const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))
  return (Math.acos(d) * 180) / Math.PI
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity
  if (!g || (g.x === null && g.y === null && g.z === null)) return
  state.haveMotion = true
  gravity = normalize({ x: g.x || 0, y: g.y || 0, z: g.z || 0 })
  recent.push(gravity)
  if (recent.length > 30) recent.shift()
}
function onOrientation(e) {
  orient.beta = e.beta || 0
  orient.gamma = e.gamma || 0
}

function isStable() {
  if (recent.length < 12) return false
  const mean = recent.reduce((a, v) => ({ x: a.x + v.x, y: a.y + v.y, z: a.z + v.z }), { x: 0, y: 0, z: 0 })
  mean.x /= recent.length; mean.y /= recent.length; mean.z /= recent.length
  const m = normalize(mean)
  let max = 0
  for (const v of recent) max = Math.max(max, angleBetween(v, m))
  return max < STABLE_DEG
}

function requestSensors() {
  const DME = window.DeviceMotionEvent
  const DOE = window.DeviceOrientationEvent
  const needMotion = DME && typeof DME.requestPermission === 'function'
  const needOrient = DOE && typeof DOE.requestPermission === 'function'
  const asks = []
  if (needMotion) asks.push(DME.requestPermission())
  if (needOrient) asks.push(DOE.requestPermission())

  if (asks.length === 0) { attachSensors(); return Promise.resolve(true) }
  return Promise.all(asks)
    .then((res) => {
      if (res.every((r) => r === 'granted')) { attachSensors(); return true }
      return false
    })
    .catch(() => false)
}
function attachSensors() {
  window.addEventListener('devicemotion', onMotion, true)
  window.addEventListener('deviceorientation', onOrientation, true)
}

// ---- audio / haptics ---------------------------------------------------
let audioCtx = null
function beep(freq, ms) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.type = 'sine'; o.frequency.value = freq
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000)
    o.connect(g); g.connect(audioCtx.destination)
    o.start(); o.stop(audioCtx.currentTime + ms / 1000)
  } catch (_) {}
}
function vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern) }
function say(text) {
  try {
    if (!('speechSynthesis' in window)) return
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 0.98; u.pitch = 1
    speechSynthesis.speak(u)
  } catch (_) {}
}

// ---- hold timer --------------------------------------------------------
const C = 2 * Math.PI * 56
let holdInterval = null
function startHold(seconds, onDone) {
  const timer = $('run-timer')
  const prog = $('timer-prog')
  const count = $('timer-count')
  prog.style.strokeDasharray = C
  prog.style.strokeDashoffset = C
  timer.classList.add('on')
  let remaining = seconds
  count.textContent = remaining
  // kick the ring to full then drain
  requestAnimationFrame(() => { prog.style.strokeDashoffset = 0 })
  clearInterval(holdInterval)
  holdInterval = setInterval(() => {
    remaining -= 1
    count.textContent = Math.max(0, remaining)
    if (remaining <= 0) { stopHold(); onDone() }
    else if (remaining <= 3) beep(660, 90)
  }, 1000)
}
function stopHold() {
  clearInterval(holdInterval); holdInterval = null
  $('run-timer').classList.remove('on')
}

// ---- mini level --------------------------------------------------------
const levelCanvas = $('run-level')
const lctx = levelCanvas.getContext('2d')
const ldpr = Math.min(window.devicePixelRatio || 1, 3)
levelCanvas.width = 56 * ldpr; levelCanvas.height = 56 * ldpr
lctx.setTransform(ldpr, 0, 0, ldpr, 0, 0)
function drawLevel() {
  const s = 56, c = s / 2, R = 24
  lctx.clearRect(0, 0, s, s)
  lctx.strokeStyle = '#d9e2e0'; lctx.lineWidth = 1.5
  lctx.beginPath(); lctx.arc(c, c, R, 0, Math.PI * 2); lctx.stroke()
  const gx = Math.max(-1, Math.min(1, orient.gamma / 90))
  const gy = Math.max(-1, Math.min(1, orient.beta / 90))
  const bx = c + gx * (R - 6), by = c + gy * (R - 6)
  lctx.beginPath(); lctx.arc(bx, by, 6, 0, Math.PI * 2)
  lctx.fillStyle = state.runPhase === 'holding' ? '#2f9e6f' : '#0d8a80'
  lctx.fill()
  requestAnimationFrame(drawLevel)
}
requestAnimationFrame(drawLevel)

// ---- step engine -------------------------------------------------------
let engineTick = null
let stableSince = 0

function enterStep(i) {
  clearInterval(engineTick); engineTick = null
  stopHold()
  state.index = i
  const step = state.steps[i]

  $('run-phase').textContent = step.phase
  $('run-count').textContent = `${i + 1} / ${state.steps.length}`
  $('run-title').textContent = step.title
  $('run-instruction').innerHTML = step.instructionHtml
  $('run-posture').innerHTML = POSTURES[step.posture] || POSTURES.sitting

  say(step.speech)

  if (step.manual) {
    state.runPhase = 'setup'
    setStatus('wait', 'Tap when you’re in position')
    setPrimary('I’m in position', () => commitSetup())
    return
  }

  // sensor-gated step
  state.runPhase = 'waiting'
  setStatus('wait', 'Move into position…')
  setPrimary('Start the hold now', () => beginHold())
  stableSince = 0
  engineTick = setInterval(watchForArrival, 200)
}

function watchForArrival() {
  if (!gravity || !state.reference) return
  const moved = angleBetween(gravity, state.reference) > ARRIVE_DEG
  if (moved && isStable()) {
    if (!stableSince) stableSince = Date.now()
    else if (Date.now() - stableSince > STABLE_MS) beginHold()
  } else {
    stableSince = 0
  }
}

function beginHold() {
  if (state.runPhase === 'holding') return
  clearInterval(engineTick); engineTick = null
  state.runPhase = 'holding'
  const step = state.steps[state.index]
  beep(880, 140); vibrate(60)
  say(`Good. Hold still for ${step.hold} seconds.`)
  setStatus('hold', 'Hold still…')
  setPrimary('Skip the hold', () => finishHold())
  startHold(step.hold, finishHold)
}

function finishHold() {
  if (state.runPhase === 'complete') return
  state.runPhase = 'complete'
  stopHold()
  beep(988, 180); setTimeout(() => beep(1319, 220), 190); vibrate([80, 60, 80])
  // commit current orientation as the reference for the next move
  if (gravity) state.reference = gravity
  const next = state.index + 1
  if (next >= state.steps.length) { say('All done.'); return finishRun() }
  say('Done. On to the next position.')
  setTimeout(() => enterStep(next), 900)
}

function commitSetup() {
  if (!gravity && state.haveMotion === false) {
    // no sensors — proceed manually, detection will fall back to manual buttons
  }
  state.reference = gravity || { x: 0, y: 1, z: 0 }
  enterStep(1)
}

// ---- ui helpers --------------------------------------------------------
function setStatus(kind, text) {
  const el = $('run-status')
  el.className = 'pill ' + (kind === 'hold' ? 'hold' : 'wait')
  $('run-status-text').textContent = text
}
let primaryHandler = null
function setPrimary(label, handler) {
  const btn = $('run-next')
  btn.textContent = label
  primaryHandler = handler
}

function startRun() {
  state.index = 0
  state.reference = null
  state.runPhase = 'idle'
  show('s-run')
  enterStep(0)
  if (!state.haveMotion) {
    setTimeout(() => {
      if (!state.haveMotion) $('run-level-text').textContent = 'No sensor — use the buttons'
    }, 2500)
  }
}
function finishRun() {
  clearInterval(engineTick); engineTick = null
  stopHold()
  show('s-done')
}
function quitRun() {
  clearInterval(engineTick); engineTick = null
  stopHold(); speechSynthesis && speechSynthesis.cancel()
  show('s-welcome')
}

// ---- wiring ------------------------------------------------------------
$('go-ear').onclick = () => show('s-ear')
$('back-welcome').onclick = () => show('s-welcome')
$('back-ear').onclick = () => show('s-ear')

document.querySelectorAll('.choice').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('.choice').forEach((x) => x.classList.remove('selected'))
    c.classList.add('selected')
    state.affected = c.dataset.ear
    state.steps = buildSteps(state.affected)
    $('go-permission').disabled = false
  }
})
$('go-permission').onclick = () => {
  if (state.affected) $('perm-side').textContent = state.affected
  show('s-permission')
}

$('go-run').onclick = () => {
  const status = $('perm-status'); const text = $('perm-text')
  text.textContent = 'Requesting permission…'
  requestSensors().then((ok) => {
    if (ok) {
      status.className = 'pill hold'; text.textContent = 'Sensors on'
      startRun()
    } else {
      status.className = 'pill'; text.textContent = 'Motion denied — you can still tap through each step manually.'
      startRun()
    }
  })
}

$('run-next').onclick = () => { if (primaryHandler) primaryHandler() }
$('run-back').onclick = () => { if (state.index > 0) enterStep(state.index - 1); else show('s-permission') }
$('run-quit').onclick = quitRun
$('done-restart').onclick = () => startRun()
$('done-home').onclick = () => show('s-welcome')
