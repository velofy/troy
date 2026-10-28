class TroyPushToTalkProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = []
    this.length = 0
    this.position = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush()
    }
  }

  flush() {
    if (this.length === 0) return
    const combined = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.pending) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    this.pending = []
    this.length = 0
    this.port.postMessage(combined.buffer, [combined.buffer])
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel?.length) {
      const ratio = sampleRate / 16000
      const capacity = Math.max(1, Math.ceil((channel.length - this.position) / ratio))
      const resampled = new Float32Array(capacity)
      let count = 0
      let position = this.position
      while (position < channel.length) {
        const left = Math.floor(position)
        const fraction = position - left
        const a = channel[Math.min(left, channel.length - 1)] ?? 0
        const b = channel[Math.min(left + 1, channel.length - 1)] ?? a
        resampled[count] = a + (b - a) * fraction
        count += 1
        position += ratio
      }
      this.position = position - channel.length
      const chunk = count === resampled.length ? resampled : resampled.slice(0, count)
      if (chunk.length) {
        this.pending.push(chunk)
        this.length += chunk.length
        if (this.length >= 4096) this.flush()
      }
    }
    return true
  }
}

registerProcessor('troy-push-to-talk', TroyPushToTalkProcessor)
