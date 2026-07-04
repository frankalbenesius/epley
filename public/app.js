'use strict'

// ---- tuning ------------------------------------------------------------
const ARRIVE_DEG = 28 // gravity-vector change from previous position that counts as "moved"
const STABLE_DEG = 4 // max jitter (deg) over the window to count as "held still"
const STABLE_MS = 1200 // how long it must stay stable before a hold starts
const HOLD_LONG = 30 // seconds for the therapeutic positions
const HOLD_SETTLE = 20 // seconds to settle after sitting up
const ARM_GRACE_MS = 3500 // don't auto-start until the setup instruction has been spoken
const WAIT_PULSE_MS = 3500 // gap between soft "listening" pulses
const NOSENSOR_ARM_MS = 6000 // timed fallback: begin after this if no sensors
const NOSENSOR_WAIT_MS = 9000 // timed fallback: advance a move after this if no sensors
const REPROMPT_MS = 26000 // re-speak the instruction if still waiting this long
const HARD_ADVANCE_MS = 42000 // never get stuck: advance anyway after this

// ---- step model (parameterized by affected ear) ------------------------
function buildSteps(affected) {
  const other = affected === 'left' ? 'right' : 'left'
  const A = cap(affected)
  const O = cap(other)
  return [
    {
      id: 'setup', arming: true, posture: 'sitting',
      title: 'Get ready',
      instructionHtml: `Sit on the edge of the bed, phone against your <span class="dir">${A} ear</span>. Turn your head <span class="dir">45° toward your ${A} side</span> and hold still — I'll begin on my own.`,
      speech: `Sit on the edge of the bed with the phone against your ${affected} ear. Turn your head 45 degrees toward your ${affected} side, and hold still. I will start on my own.`,
    },
    {
      id: 'lie-back', hold: HOLD_LONG, posture: 'lie-back',
      title: 'Lie back',
      instructionHtml: `Keeping your head turned <span class="dir">45° toward your ${A} side</span>, lie back quickly so your head hangs slightly off the edge. Then hold still — <b>30 seconds</b>.`,
      speech: `Lie back quickly now, keeping your head turned toward your ${affected} side, so your head hangs a little off the edge of the bed. Hold this for 30 seconds.`,
    },
    {
      id: 'turn-head', hold: HOLD_LONG, posture: 'turn-head',
      title: 'Turn your head',
      instructionHtml: `Turn <span class="dir">just your head</span> about 90° toward your <span class="dir">${O} side</span> — keep your body flat — until you're looking part-way toward the floor. Hold <b>30 seconds</b>.`,
      speech: `Now turn just your head, about 90 degrees toward your ${other} side. Keep your body flat on the bed, and turn until you are looking part way toward the floor. Hold for 30 seconds.`,
    },
    {
      id: 'roll', hold: HOLD_LONG, posture: 'roll',
      title: 'Roll onto your side',
      instructionHtml: `Now roll your <span class="dir">whole body</span> onto your <span class="dir">${O} side</span>, until you're facing down toward the floor. Hold <b>30 seconds</b>.`,
      speech: `Now roll your whole body onto your ${other} side, not just your head, so you end up facing down toward the floor. Hold for 30 seconds.`,
    },
    {
      id: 'sit-up', hold: HOLD_SETTLE, posture: 'sitting',
      title: 'Sit up slowly',
      instructionHtml: `Slowly sit up and return to the edge of the bed. Stay sitting and let it settle before you stand.`,
      speech: `Great. Now sit up slowly, back to the edge of the bed, and stay sitting while it settles.`,
    },
  ]
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

const MOVE_LABELS = {
  setup: { move: 'Get ready', count: '' },
  'lie-back': { move: 'Move 1 of 3', count: '1 / 3' },
  'turn-head': { move: 'Move 2 of 3', count: '2 / 3' },
  roll: { move: 'Move 3 of 3', count: '3 / 3' },
  'sit-up': { move: 'Finish', count: '' },
}

// ---- posture diagrams (placeholder — better art to come) ---------------
const POSTURES = {
  sitting: `<path class="bed" d="M20 130 H120 V95" /><path class="body" d="M120 92 V55" /><circle class="head" cx="120" cy="42" r="14" />`,
  'lie-back': `<path class="bed" d="M60 96 H185 M60 96 V132" /><path class="body" d="M175 78 H78" /><circle class="head" cx="66" cy="82" r="14" /><path class="arrow" d="M120 52 q-40 -6 -58 22" /><path class="arrow" d="M62 66 l0 12 l11 -4" />`,
  'turn-head': `<path class="bed" d="M40 96 H185" /><path class="body" d="M175 82 H80" /><circle class="head" cx="70" cy="82" r="14" /><path class="arrow" d="M70 55 a20 20 0 0 1 20 20" /><path class="arrow" d="M92 70 l-2 8 l-8 -3" />`,
  roll: `<path class="bed" d="M40 100 H185" /><path class="body" d="M170 88 H82" /><circle class="head" cx="72" cy="90" r="14" /><path class="arrow" d="M120 62 a26 24 0 0 1 4 22" /><path class="arrow" d="M124 84 l3 -9 l7 5" />`,
}

// ---- state -------------------------------------------------------------
const state = { affected: null, steps: [], index: 0, phase: 'idle', reference: null, haveMotion: false, sensorMode: true }
const $ = (id) => document.getElementById(id)
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id)) }

// ---- sensors -----------------------------------------------------------
let gravity = null
let orient = { beta: 0, gamma: 0 }
const recent = []
function normalize(v) { const m = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / m, y: v.y / m, z: v.z / m } }
function angleBetween(a, b) { const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)); return (Math.acos(d) * 180) / Math.PI }
function onMotion(e) {
  const g = e.accelerationIncludingGravity
  if (!g || (g.x === null && g.y === null && g.z === null)) return
  state.haveMotion = true
  gravity = normalize({ x: g.x || 0, y: g.y || 0, z: g.z || 0 })
  recent.push(gravity); if (recent.length > 30) recent.shift()
}
function onOrientation(e) { orient.beta = e.beta || 0; orient.gamma = e.gamma || 0 }
function isStable() {
  if (recent.length < 12) return false
  let mx = 0, my = 0, mz = 0
  for (const v of recent) { mx += v.x; my += v.y; mz += v.z }
  const m = normalize({ x: mx, y: my, z: mz })
  let max = 0
  for (const v of recent) max = Math.max(max, angleBetween(v, m))
  return max < STABLE_DEG
}
function requestSensors() {
  const DME = window.DeviceMotionEvent, DOE = window.DeviceOrientationEvent
  const asks = []
  if (DME && typeof DME.requestPermission === 'function') asks.push(DME.requestPermission())
  if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission())
  if (asks.length === 0) { attachSensors(); return Promise.resolve(true) }
  return Promise.all(asks).then((r) => { if (r.every((x) => x === 'granted')) { attachSensors(); return true } return false }).catch(() => false)
}
function attachSensors() {
  window.addEventListener('devicemotion', onMotion, true)
  window.addEventListener('deviceorientation', onOrientation, true)
}

// ---- audio / speech / haptics ------------------------------------------
let audioCtx = null
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
  } catch (_) {}
}
function tone(freq, dur, gain, delay) {
  if (!audioCtx) return
  const t0 = audioCtx.currentTime + (delay || 0)
  const o = audioCtx.createOscillator(), g = audioCtx.createGain()
  o.type = 'sine'; o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain || 0.22, t0 + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / 1000)
  o.connect(g); g.connect(audioCtx.destination)
  o.start(t0); o.stop(t0 + dur / 1000 + 0.02)
}
const sndTest = () => tone(880, 220, 0.25)
const sndReached = () => { tone(587.33, 110, 0.2); tone(880, 150, 0.22, 0.11) } // arrived at a position
const sndTick = () => tone(392, 55, 0.09) // soft hold tick
const sndCountdown = () => tone(660, 90, 0.18) // last 3 seconds
const sndComplete = () => { tone(784, 130, 0.2); tone(988, 150, 0.22, 0.13); tone(1319, 240, 0.22, 0.28) }
const sndWaitPulse = () => tone(300, 45, 0.05) // gentle "still listening"
const sndDone = () => { tone(659, 140, 0.2); tone(784, 140, 0.2, 0.14); tone(988, 160, 0.22, 0.28); tone(1319, 320, 0.22, 0.44) }
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p) }
let _utterKeep = [] // hold references so utterances aren't garbage-collected mid-speech
function speakNow(text) {
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 0.98
  _utterKeep.push(u)
  u.onend = u.onerror = () => { _utterKeep = _utterKeep.filter((x) => x !== u) }
  speechSynthesis.speak(u)
}
// Mobile Chrome/Safari let the TTS engine sleep during silence (e.g. a 30s hold) and
// then silently drop the next speak(). Cancel + resume, speak after a beat, and retry
// once if nothing actually started.
function say(text) {
  if (!('speechSynthesis' in window)) return
  try {
    speechSynthesis.cancel()
    speechSynthesis.resume()
    setTimeout(() => { try { speakNow(text) } catch (_) {} }, 140)
    setTimeout(() => {
      try {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) {
          speechSynthesis.resume()
          speakNow(text)
        }
      } catch (_) {}
    }, 850)
  } catch (_) {}
}

// ---- hold timer --------------------------------------------------------
const C = 2 * Math.PI * 56
let holdInterval = null
function startHold(seconds, onDone) {
  const timer = $('run-timer'), prog = $('timer-prog'), count = $('timer-count')
  prog.style.strokeDasharray = C; prog.style.strokeDashoffset = C
  timer.classList.add('on')
  let remaining = seconds
  count.textContent = remaining
  requestAnimationFrame(() => { prog.style.strokeDashoffset = 0 })
  clearInterval(holdInterval)
  holdInterval = setInterval(() => {
    remaining -= 1
    count.textContent = Math.max(0, remaining)
    if (remaining <= 0) { stopHold(); onDone() }
    else if (remaining <= 3) sndCountdown()
    else if (remaining % 5 === 0) sndTick()
  }, 1000)
}
function stopHold() { clearInterval(holdInterval); holdInterval = null; $('run-timer').classList.remove('on') }

// ---- mini level (assistive, for anyone glancing) -----------------------
const levelCanvas = $('run-level'), lctx = levelCanvas.getContext('2d')
const ldpr = Math.min(window.devicePixelRatio || 1, 3)
levelCanvas.width = 56 * ldpr; levelCanvas.height = 56 * ldpr; lctx.setTransform(ldpr, 0, 0, ldpr, 0, 0)
function drawLevel() {
  const s = 56, c = s / 2, R = 24
  lctx.clearRect(0, 0, s, s)
  lctx.strokeStyle = '#d9e2e0'; lctx.lineWidth = 1.5
  lctx.beginPath(); lctx.arc(c, c, R, 0, Math.PI * 2); lctx.stroke()
  const gx = Math.max(-1, Math.min(1, orient.gamma / 90)), gy = Math.max(-1, Math.min(1, orient.beta / 90))
  lctx.beginPath(); lctx.arc(c + gx * (R - 6), c + gy * (R - 6), 6, 0, Math.PI * 2)
  lctx.fillStyle = state.phase === 'holding' ? '#2f9e6f' : '#0d8a80'; lctx.fill()
  requestAnimationFrame(drawLevel)
}
requestAnimationFrame(drawLevel)

// ---- engine ------------------------------------------------------------
let engineTick = null
let phaseStart = 0
let stableSince = 0
let lastPulse = 0
let reprompted = false

function setStatus(kind, text) {
  $('run-status').className = 'pill ' + (kind === 'hold' ? 'hold' : 'wait')
  $('run-status-text').textContent = text
}

function enterStep(i) {
  clearInterval(engineTick); engineTick = null
  stopHold()
  state.index = i
  const step = state.steps[i]
  const lbl = MOVE_LABELS[step.id] || { move: step.title, count: '' }
  $('run-move').textContent = lbl.move
  $('run-count').textContent = lbl.count
  $('run-title').textContent = step.title
  $('run-instruction').innerHTML = step.instructionHtml
  $('run-posture').innerHTML = POSTURES[step.posture] || POSTURES.sitting
  say(step.speech)

  phaseStart = Date.now(); stableSince = 0; lastPulse = Date.now(); reprompted = false

  if (step.arming) {
    state.phase = 'arming'
    setStatus('wait', 'Get set — I’ll begin when you hold still')
    engineTick = setInterval(watchArming, 200)
  } else {
    state.phase = 'waiting'
    setStatus('wait', 'Move into position…')
    engineTick = setInterval(watchWaiting, 200)
  }
}

function watchArming() {
  const elapsed = Date.now() - phaseStart
  if (state.sensorMode && state.haveMotion) {
    if (elapsed > ARM_GRACE_MS && isStable()) { arm(); return }
  } else if (elapsed > NOSENSOR_ARM_MS) { arm(); return }
  pulseWhileWaiting()
}
function arm() {
  clearInterval(engineTick); engineTick = null
  state.reference = gravity || { x: 0, y: 1, z: 0 }
  sndReached(); vibrate(40)
  setTimeout(() => enterStep(1), 900) // the chord signals start; move 1's instruction is spoken on enter
}

function watchWaiting() {
  const elapsed = Date.now() - phaseStart
  if (state.sensorMode && state.haveMotion && state.reference) {
    if (angleBetween(gravity, state.reference) > ARRIVE_DEG && isStable()) {
      if (!stableSince) stableSince = Date.now()
      else if (Date.now() - stableSince > STABLE_MS) return beginHold()
    } else stableSince = 0
    if (elapsed > HARD_ADVANCE_MS) return beginHold()
  } else if (elapsed > NOSENSOR_WAIT_MS) {
    return beginHold()
  }
  if (!reprompted && elapsed > REPROMPT_MS) { reprompted = true; say('When you’re in position, hold still.') }
  pulseWhileWaiting()
}

function pulseWhileWaiting() {
  if (Date.now() - lastPulse > WAIT_PULSE_MS) { lastPulse = Date.now(); sndWaitPulse() }
}

function beginHold() {
  if (state.phase === 'holding') return
  clearInterval(engineTick); engineTick = null
  state.phase = 'holding'
  const step = state.steps[state.index]
  sndReached(); vibrate(60)
  say(step.id === 'sit-up' ? 'Good. Stay sitting while it settles.' : `Good. Now hold this position for ${step.hold} seconds.`)
  setStatus('hold', 'Hold still…')
  startHold(step.hold, finishHold)
}

function finishHold() {
  if (state.phase === 'complete') return
  state.phase = 'complete'
  stopHold()
  sndComplete(); vibrate([80, 60, 80])
  if (gravity) state.reference = gravity
  const next = state.index + 1
  if (next >= state.steps.length) { setTimeout(finishRun, 700); return }
  // completion chord is the "done" cue; the next move is spoken clearly on enter
  setTimeout(() => enterStep(next), 1500)
}

function startRun() {
  state.index = 0; state.reference = null; state.phase = 'idle'
  show('s-run')
  // decide sensor vs timed mode shortly after start
  state.sensorMode = true
  setTimeout(() => {
    if (!state.haveMotion) { state.sensorMode = false; $('run-level-text').textContent = 'No sensor — timed guidance' }
  }, 2500)
  enterStep(0)
}
function runBack() {
  if (state.index <= 0) { clearInterval(engineTick); engineTick = null; stopHold(); show('s-place'); return }
  const prev = state.index - 1
  // going back to a move: wait for a fresh move from wherever they are now
  state.reference = state.steps[prev].arming ? null : gravity
  enterStep(prev)
}
function finishRun() { clearInterval(engineTick); engineTick = null; stopHold(); sndDone(); say('All done. Sit up slowly.'); show('s-done') }
function quitRun() { clearInterval(engineTick); engineTick = null; stopHold(); try { speechSynthesis.cancel() } catch (_) {}; show('s-welcome') }

// ---- wiring ------------------------------------------------------------
$('go-ear').onclick = () => show('s-ear')
$('back-welcome').onclick = () => show('s-welcome')
$('back-ear').onclick = () => show('s-ear')
$('back-overview').onclick = () => show('s-overview')
$('back-audio').onclick = () => show('s-audio')

document.querySelectorAll('.choice').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('.choice').forEach((x) => x.classList.remove('selected'))
    c.classList.add('selected')
    state.affected = c.dataset.ear
    state.steps = buildSteps(state.affected)
    $('go-overview').disabled = false
  }
})
$('go-overview').onclick = () => show('s-overview')
$('go-audio').onclick = () => show('s-audio')

$('test-sound').onclick = () => {
  unlockAudio()
  sndTest()
  setTimeout(() => say('Audio is working. You can close your eyes and follow along.'), 260)
  $('audio-status').className = 'pill hold'
  $('audio-text').textContent = 'Hear that? You’re set. Tap again to re-test.'
  $('go-place').disabled = false
}
$('go-place').onclick = () => {
  if (state.affected) $('perm-side').textContent = state.affected
  show('s-place')
}

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
