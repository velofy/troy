// Troy's trusted agent panel. Provider traffic, policy, tools and secrets stay
// in main; this renderer owns only input controls and text-only presentation.

const providerEl = document.getElementById('agentprovider')
const modelEl = document.getElementById('agentmodel')
const keyForm = document.getElementById('keyform')
const keyEl = document.getElementById('agentkey')
const keyStatusEl = document.getElementById('keystatus')
const clearKeyBtn = document.getElementById('clearkey')
const scopesEl = document.getElementById('agentscopes')
const statusEl = document.getElementById('agentstatus')
const conversationEl = document.getElementById('conversation')
const boundaryEl = document.getElementById('agentboundary')
const boundaryTextEl = document.getElementById('boundarytext')
const grantOriginBtn = document.getElementById('grantorigin')
const composer = document.getElementById('agentcomposer')
const inputEl = document.getElementById('agentinput')
const sendBtn = document.getElementById('agentsend')
const micBtn = document.getElementById('micbtn')
const stopBtn = document.getElementById('agentstop')
const clearBtn = document.getElementById('clearagent')
const readBtn = document.getElementById('readbtn')
const readPreview = document.getElementById('readpreview')
const readOutput = document.getElementById('readoutput')

let state = null
let streamMessage = null
let pendingOrigin = ''
let refreshing = false
let voiceCapture = null
let voiceHeld = false
let refreshTimer = 0
let observedActiveTabId = 0
let panelVisible = false

function message(role, text) {
  const entry = document.createElement('p')
  entry.className = `message ${role}`
  entry.textContent = text
  conversationEl.append(entry)
  conversationEl.scrollTop = conversationEl.scrollHeight
  return entry
}

function toolStep(text, blocked = false) {
  const entry = document.createElement('p')
  entry.className = `tool-step${blocked ? ' blocked' : ''}`
  entry.textContent = text
  conversationEl.append(entry)
  conversationEl.scrollTop = conversationEl.scrollHeight
}

function setRunning(running) {
  stopBtn.hidden = !running
  sendBtn.disabled = running
  providerEl.disabled = running
  modelEl.disabled = running
  clearBtn.disabled = running
}

function renderSession(session) {
  scopesEl.textContent = ''
  for (const origin of session.origins ?? []) {
    const chip = document.createElement('span')
    chip.className = 'scope-chip'
    chip.title = origin
    chip.textContent = origin
    scopesEl.append(chip)
  }
  if (scopesEl.children.length === 0) {
    const chip = document.createElement('span')
    chip.className = 'scope-chip'
    chip.textContent = 'scope begins with the active site'
    scopesEl.append(chip)
  }

  conversationEl.textContent = ''
  for (const entry of session.messages ?? []) message(entry.role, entry.text)
  streamMessage = null
  pendingOrigin = session.pendingBoundary ?? ''
  boundaryEl.hidden = !pendingOrigin
  boundaryTextEl.textContent = pendingOrigin ? `Troy stopped before leaving for ${pendingOrigin}.` : ''
  setRunning(Boolean(session.running))
}

function render(next) {
  state = next
  providerEl.value = next.provider
  if (document.activeElement !== modelEl) modelEl.value = next.model
  const hasKey = Boolean(next.keys?.providers?.[next.provider])
  const encryption = Boolean(next.keys?.encryptionAvailable)
  keyStatusEl.textContent = !encryption
    ? 'OS key encryption is unavailable; Troy will not store a plaintext key.'
    : hasKey
      ? `${next.provider} key stored with OS encryption.`
      : `No ${next.provider} key stored.`
  clearKeyBtn.disabled = !hasKey
  renderSession(next.session)
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    render(await window.troy.agentState())
  } finally {
    refreshing = false
  }
}

function scheduleRefresh() {
  if (document.getElementById('agentpanel').hidden) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void refresh(), 40)
}

function status(text) {
  statusEl.textContent = text
}

providerEl.addEventListener('change', async () => {
  const next = await window.troy.setAgentSettings({ provider: providerEl.value })
  if (next.error) status(next.error)
  else render(next)
})

async function saveModel() {
  const next = await window.troy.setAgentSettings({ provider: providerEl.value, model: modelEl.value })
  if (next.error) status(next.error)
  else render(next)
}
modelEl.addEventListener('change', () => void saveModel())
modelEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    modelEl.blur()
    void saveModel()
  }
})

keyForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const key = keyEl.value
  keyEl.value = ''
  const result = await window.troy.setAgentKey(providerEl.value, key)
  if (result.error) status(result.error)
  await refresh()
})

clearKeyBtn.addEventListener('click', async () => {
  await window.troy.clearAgentKey(providerEl.value)
  keyEl.value = ''
  await refresh()
})

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = inputEl.value.trim()
  if (!text) return
  const result = await window.troy.submitAgent(text)
  if (result.error) {
    status(result.error)
    return
  }
  inputEl.value = ''
})

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    composer.requestSubmit()
  }
})

stopBtn.addEventListener('click', () => void window.troy.stopAgent())
clearBtn.addEventListener('click', async () => {
  const result = await window.troy.clearAgent()
  if (result.error) status(result.error)
  await refresh()
})

grantOriginBtn.addEventListener('click', async () => {
  if (!pendingOrigin) return
  const result = await window.troy.grantAgentOrigin(pendingOrigin)
  if (result.error) status(result.error)
  else status(`${pendingOrigin} is allowed; Troy resumed the run.`)
  await refresh()
})

async function readCurrentPage() {
  readPreview.hidden = false
  readPreview.open = true
  readOutput.textContent = 'reading the live tab…'
  const result = await window.troy.read()
  if (result.error) {
    readOutput.textContent = result.error
    return
  }
  readOutput.textContent = [
    result.url,
    result.title,
    `${result.blockCount} blocks (${result.domBlockCount} DOM, ${result.ocrBlockCount} OCR), ${result.regionCount} visual regions`,
    `${result.characterCount} characters in ${result.elapsedMs}ms`,
    '',
    result.markdown,
  ].join('\n')
}
readBtn.addEventListener('click', () => void readCurrentPage())
window.troy.onReadRequested(() => void readCurrentPage())

function encodeVoiceWav(chunks) {
  const outputLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const source = new Float32Array(outputLength)
  let offset = 0
  for (const chunk of chunks) {
    source.set(chunk, offset)
    offset += chunk.length
  }
  const wav = new ArrayBuffer(44 + outputLength * 2)
  const view = new DataView(wav)
  const write = (at, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(at + index, text.charCodeAt(index))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + outputLength * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, outputLength * 2, true)

  for (let index = 0; index < outputLength; index += 1) {
    const sample = Math.max(-1, Math.min(1, source[index] ?? 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }
  return wav
}

async function startVoice() {
  if (voiceCapture) return
  const permission = await window.troy.beginVoiceCapture()
  if (permission.error) {
    status(permission.error)
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    const context = new AudioContext()
    await context.audioWorklet.addModule('ptt-worklet.js')
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'troy-push-to-talk')
    const silent = context.createGain()
    silent.gain.value = 0
    const chunks = []
    node.port.onmessage = (event) => chunks.push(new Float32Array(event.data))
    source.connect(node).connect(silent).connect(context.destination)
    const timer = setTimeout(() => {
      voiceHeld = false
      void stopVoice(false)
    }, 60_000)
    voiceCapture = { stream, context, source, node, silent, chunks, timer }
    micBtn.setAttribute('aria-pressed', 'true')
    micBtn.textContent = 'listening…'
    status('listening locally; release to transcribe')
    if (!voiceHeld) void stopVoice(false)
  } catch (error) {
    await window.troy.endVoiceCapture()
    status(`microphone unavailable: ${String(error?.message ?? error)}`)
  }
}

async function stopVoice(cancelled) {
  const capture = voiceCapture
  if (!capture) return
  voiceCapture = null
  clearTimeout(capture.timer)
  capture.node.port.postMessage('flush')
  await new Promise((resolve) => setTimeout(resolve, 30))
  capture.node.disconnect()
  capture.source.disconnect()
  capture.silent.disconnect()
  for (const track of capture.stream.getTracks()) track.stop()
  await capture.context.close().catch(() => undefined)
  await window.troy.endVoiceCapture()
  micBtn.setAttribute('aria-pressed', 'false')
  micBtn.textContent = 'hold to talk'
  if (cancelled || capture.chunks.length === 0) {
    status(cancelled ? 'voice capture cancelled' : 'no audio captured')
    return
  }

  status('transcribing on this machine…')
  const wav = encodeVoiceWav(capture.chunks)
  const result = await window.troy.transcribeVoice(wav)
  if (result.error) {
    status(result.error)
    return
  }
  const text = String(result.text ?? '').trim()
  if (!text) {
    status('no speech recognized')
    return
  }
  inputEl.value = text
  const submitted = await window.troy.submitAgent(text)
  if (submitted.error) status(submitted.error)
  else {
    inputEl.value = ''
    status('voice instruction submitted')
  }
}

micBtn.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  voiceHeld = true
  micBtn.setPointerCapture(event.pointerId)
  void startVoice()
})
micBtn.addEventListener('pointerup', (event) => {
  event.preventDefault()
  voiceHeld = false
  if (micBtn.hasPointerCapture(event.pointerId)) micBtn.releasePointerCapture(event.pointerId)
  void stopVoice(false)
})
micBtn.addEventListener('pointercancel', () => {
  voiceHeld = false
  void stopVoice(true)
})
window.troy.onVoicePress(() => {
  voiceHeld = true
  void startVoice()
})
window.troy.onVoiceRelease(() => {
  voiceHeld = false
  void stopVoice(false)
})
window.troy.onVoiceCancel(() => {
  voiceHeld = false
  void stopVoice(true)
})

async function initialiseVoice() {
  const voice = await window.troy.voiceState()
  micBtn.disabled = !voice.available
  micBtn.title = voice.available
    ? `Offline push-to-talk with ${voice.engine} (Cmd/Ctrl+Shift+Space)`
    : voice.reason
  if (!voice.available && !statusEl.textContent) status(voice.reason)
}

window.troy.onAgentEvent((event) => {
  if (event.type === 'session-changed') {
    // The visible panel already received the run's ordered events. Rebuilding
    // it here would erase streamed text and tool rows; tab changes and direct
    // clear/grant actions refresh explicitly when they need stored state.
    if (!state || event.tabId !== state.session.tabId) scheduleRefresh()
    return
  }
  if (!state || event.tabId !== state.session.tabId) return
  if (event.type === 'run-started') {
    streamMessage = null
    setRunning(true)
    status('agent running on this tab')
  } else if (event.type === 'user-message') {
    message('user', String(event.text ?? ''))
  } else if (event.type === 'assistant-delta') {
    if (!streamMessage) streamMessage = message('assistant', '')
    streamMessage.textContent += String(event.delta ?? '')
    conversationEl.scrollTop = conversationEl.scrollHeight
  } else if (event.type === 'tool-started') {
    toolStep(`running ${event.name}…`)
  } else if (event.type === 'tool-finished') {
    toolStep(`${event.name}: ${event.summary}`, Boolean(event.blocked))
  } else if (event.type === 'retrying') {
    status(`provider retry ${event.attempt}: ${event.reason}`)
  } else if (event.type === 'boundary') {
    pendingOrigin = String(event.origin ?? '')
    boundaryEl.hidden = !pendingOrigin
    boundaryTextEl.textContent = pendingOrigin ? `Troy stopped before leaving for ${pendingOrigin}.` : String(event.reason ?? '')
    status('origin boundary reached')
    setRunning(false)
  } else if (event.type === 'blocked') {
    toolStep(String(event.reason ?? 'the browser blocked that action'), true)
    status('action blocked by Troy policy')
    setRunning(false)
  } else if (event.type === 'cancelled') {
    status(String(event.reason ?? 'agent stopped'))
    setRunning(false)
  } else if (event.type === 'error') {
    status(String(event.error ?? 'agent error'))
    setRunning(false)
  } else if (event.type === 'completed') {
    status('agent finished')
    setRunning(false)
  }
})

window.troy.onTabs((tabs) => {
  const active = tabs.tabs.find((tab) => tab.active)
  if (voiceCapture && state && active?.id !== state.session.tabId) {
    voiceHeld = false
    void stopVoice(true)
  }
  scheduleRefresh()
})
void initialiseVoice()
