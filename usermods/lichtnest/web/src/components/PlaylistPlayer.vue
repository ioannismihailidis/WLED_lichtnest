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
  return pl ? (pl.items || []).filter((it) => it.fx != null || it.kind) : []
})
const segs = computed(() => {
  const s = steps.value
  const dur = (it) => Math.max(0.2, stepDurationMs(it) / 1000)   // effective length (impulse/strobe auto-derive)
  return s.map((it, i) => ({ i, w: dur(it), kind: it.kind || null }))
})
// fill of one segment chip: past = 100 %, current = step progress, future = 0
function fillOf (s) {
  const p = prog.value
  if (!p) return 0
  if (s.i < p.idx) return 100
  if (s.i > p.idx) return 0
  return Math.min(100, Math.max(0, p.stepFrac * 100))
}
// step label: custom name if set, else the effect name
const KIND_NAMES = { pause: 'Pause', black: 'Schwarzblende', fade: 'Fade' }
function stepName (i, fallbackFx) {
  const it = steps.value[i]
  if (it && it.kind) return KIND_NAMES[it.kind] || it.kind
  if (it && it.name && it.name.trim()) return it.name
  return effectById(it ? it.fx : fallbackFx).name
}
</script>

<template>
  <div v-if="prog" class="nowbar">
    <div class="nowrow mono"><span>▶ Schritt {{ prog.step }}/{{ prog.total }} · {{ stepName(prog.idx, prog.fx) }}</span><span>noch {{ prog.remaining }}s</span></div>
    <!-- one rounded chip per step, width ∝ duration; the current chip fills, past chips are full -->
    <div v-if="segs.length" class="pltrack2">
      <div v-for="s in segs" :key="s.i" class="pseg" :class="{ cur: s.i === prog.idx, el: !!s.kind }" :style="{ flexGrow: s.w }">
        <div class="psegfill" :key="'f' + s.i + '-' + (s.i === prog.idx ? prog.step : 0)" :style="{ width: fillOf(s) + '%' }" :class="{ anim: s.i === prog.idx }" />
      </div>
    </div>
    <div v-else class="pltrack">
      <div class="plfill" :style="{ width: prog.frac * 100 + '%' }" />
    </div>
    <div class="nowact">
      <button class="tctl" title="Vorheriger Schritt" @click.stop="prevStep()"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6z" /><path d="M20 5v14l-10-7z" /></svg></button>
      <button class="tctl" :class="{ on: playback.loop }" title="Aktuellen Schritt wiederholen" @click.stop="setLoop(!playback.loop)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg></button>
      <button class="tctl" title="Nächster Schritt" @click.stop="nextStep()"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2z" /><path d="M4 5v14l10-7z" /></svg></button>
      <span class="mono nxt">{{ playback.loop ? 'Schritt wiederholt' : '→ ' + stepName((prog.idx + 1) % prog.total, prog.nextFx) }}</span>
    </div>
  </div>
</template>

<style scoped>
.nowbar { background: rgba(240,162,60,.1); border: 1px solid rgba(240,162,60,.35); border-radius: 14px; padding: 11px 13px; }
.nowrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; font-weight: 700; color: var(--text); }
.nowrow span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pltrack { position: relative; height: 7px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; margin: 8px 0; }
.plfill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .5s linear; }
.pltrack2 { display: flex; gap: 3px; height: 8px; margin: 9px 0; }
.pseg { position: relative; flex-basis: 0; min-width: 8px; background: rgba(255,255,255,.09); border-radius: 5px; overflow: hidden; }
.pseg.cur { background: rgba(240,162,60,.16); box-shadow: inset 0 0 0 1px rgba(240,162,60,.28); }
.pseg.el { background: rgba(165,139,255,.16); }
.pseg.el .psegfill { background: linear-gradient(90deg, #7b3cff, #a58bff); }
.psegfill { height: 100%; border-radius: 5px; background: linear-gradient(90deg, var(--accent), var(--accent2)); }
.psegfill.anim { transition: width .5s linear; }
.nowact { display: flex; align-items: center; gap: 8px; }
.tctl { flex: none; width: 34px; height: 30px; border-radius: 8px; background: rgba(255,255,255,.08); border: 1px solid var(--line); color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.tctl.on { background: var(--accent); color: #1a1206; border-color: transparent; box-shadow: 0 0 12px -3px var(--accent); }
.nxt { font-size: 11px; color: var(--muted2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 4px; }
</style>
