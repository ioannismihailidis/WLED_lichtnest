<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { wled, playlists, playlistProgress, playback, prevStep, nextStep, setLoop, stepDurationMs } from '../wled.js'
import { effectById } from '../effects.js'

const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 500) })
onUnmounted(() => clearInterval(timer))
const prog = computed(() => playlistProgress(now.value))

// steps of the running playlist (for the per-step timeline markers)
const steps = computed(() => {
  const pl = playlists.list.find((p) => p.id === wled.pl.id)
  return pl ? (pl.items || []).filter((it) => it.fx != null) : []
})
const segs = computed(() => {
  const s = steps.value
  const dur = (it) => Math.max(0.2, stepDurationMs(it) / 1000)   // effective length (impulse/strobe auto-derive)
  const total = s.reduce((a, b) => a + dur(b), 0) || 1
  let acc = 0
  return s.map((it, i) => { const w = dur(it) / total * 100; const left = acc; acc += w; return { i, w, left, preview: effectById(it.fx).preview } })
})
// playhead position in duration-space (aligns with the duration-proportional segments)
const playhead = computed(() => {
  const p = prog.value, s = segs.value; if (!p) return 0
  const cur = s[p.idx]; if (!cur) return p.frac * 100
  return cur.left + cur.w * p.stepFrac
})
// step label: custom name if set, else the effect name
function stepName (i, fallbackFx) {
  const it = steps.value[i]
  if (it && it.name && it.name.trim()) return it.name
  return effectById(it ? it.fx : fallbackFx).name
}
</script>

<template>
  <div v-if="prog" class="nowbar">
    <div class="nowrow mono"><span>▶ Schritt {{ prog.step }}/{{ prog.total }} · {{ stepName(prog.idx, prog.fx) }}</span><span>noch {{ prog.remaining }}s</span></div>
    <div class="pltrack">
      <div class="plfill" :style="{ width: (segs.length ? playhead : prog.frac * 100) + '%' }" />
      <div v-for="s in segs.slice(1)" :key="s.i" class="tick" :style="{ left: s.left + '%' }" />
    </div>
    <div class="nowact">
      <button class="tctl" title="Vorheriger Schritt" @click.stop="prevStep()"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6z" /><path d="M20 5v14l-10-7z" /></svg></button>
      <button class="tctl" :class="{ on: playback.loop }" title="Nur diesen Schritt wiederholen" @click.stop="setLoop(!playback.loop)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
        <b class="loop1">1</b>
      </button>
      <button class="tctl" title="Nächster Schritt" @click.stop="nextStep()"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2z" /><path d="M4 5v14l10-7z" /></svg></button>
      <span class="mono nxt">{{ playback.loop ? 'Schritt-Loop an' : '→ ' + stepName((prog.idx + 1) % prog.total, prog.nextFx) }}</span>
    </div>
  </div>
</template>

<style scoped>
.nowbar { background: rgba(240,162,60,.1); border: 1px solid rgba(240,162,60,.35); border-radius: 14px; padding: 11px 13px; }
.nowrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; font-weight: 700; color: var(--text); }
.nowrow span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pltrack { position: relative; height: 7px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; margin: 8px 0; }
.plfill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .5s linear; }
.tick { position: absolute; top: 0; bottom: 0; width: 1.5px; background: rgba(255,255,255,.5); }
.nowact { display: flex; align-items: center; gap: 8px; }
.tctl { position: relative; flex: none; width: 34px; height: 30px; border-radius: 8px; background: rgba(255,255,255,.08); border: 1px solid var(--line); color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.tctl.on { background: var(--accent); color: #1a1206; border-color: transparent; box-shadow: 0 0 12px -3px var(--accent); }
.loop1 { position: absolute; font-size: 8px; font-weight: 800; bottom: 2px; right: 4px; line-height: 1; }
.nxt { font-size: 11px; color: var(--muted2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 4px; }
</style>
