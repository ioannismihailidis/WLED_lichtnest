// Shared mic signal for effect previews (MiniPlan / TexturePreview / impulse).
// Mode: 'live' follows lichtnest.audio; 'demo' uses a synthetic waveform.
import { reactive } from 'vue'
import { lichtnest, wled, audioReactive } from './wled.js'

const STORE_KEY = 'ln_preview_audio'

function loadMode () {
  try {
    const v = localStorage.getItem(STORE_KEY)
    if (v === 'live' || v === 'demo') return v
  } catch (e) { /* private mode */ }
  return 'live'
}

export const previewAudio = reactive({ mode: loadMode() })

export function setPreviewAudioMode (mode) {
  previewAudio.mode = mode === 'demo' ? 'demo' : 'live'
  try { localStorage.setItem(STORE_KEY, previewAudio.mode) } catch (e) { /* quota */ }
}

export function canPreviewLiveMic () {
  return !wled.offline && (lichtnest.audio.ok || audioReactive.on)
}

function useLiveMic () {
  return previewAudio.mode === 'live' && canPreviewLiveMic()
}

function fakeSrc (asrc) {
  const t = performance.now() / 1000
  if (asrc === 5) return (Math.sin(t * 6.2) > 0.82) ? 1 : 0
  if (asrc === 2) return 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.1))
  if (asrc === 3) return 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 4.7))
  if (asrc === 4) return 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 9.3))
  return 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3.2))
}

/** 0..1 signal for asrc (1 vol · 2 bass · 3 mid · 4 treble · 5 beat). */
export function previewAudioSrc (asrc) {
  if (!asrc) return 0
  if (useLiveMic()) {
    // lichtnest.audio.lvl is already display-smoothed in wled.js (~20 Hz + EMA).
    const lvl = Math.max(0, Math.min(1, (lichtnest.audio.lvl || 0) / 255))
    if (asrc === 5) return lichtnest.audio.peak ? 1 : Math.min(1, lvl * 1.1)
    // Device JSON only exposes overall level (+ peak); map all continuous sources to it.
    return lvl
  }
  return fakeSrc(asrc)
}

/** Fake / live GEQ band 0..15 for Spektrum preview. */
export function previewFftBand (band) {
  if (useLiveMic()) {
    const lvl = Math.max(0, Math.min(1, (lichtnest.audio.lvl || 0) / 255))
    // Slight per-band shaping so the bar graph isn't flat while still tracking pegel.
    const b = band % 16
    const shape = 0.55 + 0.45 * Math.sin(b * 0.7 + 0.4)
    return Math.min(1, lvl * shape * (lichtnest.audio.peak ? 1.15 : 1))
  }
  const t = performance.now() / 1000
  const b = band % 16
  return 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(t * (2.2 + b * 0.55) + b))
}
