<script setup>
// Canvas preview of the setup: the colour field over the whole canvas (dimmed) with the
// real LEDs drawn bright on top; LEDs that are off stay faintly visible.
//   mode 'program'  what the device plays (all layers, synced to /json/state)
//   mode 'layer'    one layer of the program on its own (layer monitor)
//   mode 'clip'     one clip with its own clock (inspector live preview)
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { setup } from './setup.js'
import { dev } from './api.js'
import { cellOfTag, effectByKey } from './show.js'
import { buildScene, buildField, programLayers, prepDeck, evaluator, draw } from './scene.js'
import { newDeckState } from './mfx.js'

const props = defineProps({
  mode: { type: String, default: 'program' },
  layer: { type: Number, default: 0 },
  clip: { type: Object, default: null },        // { effect, params }
  field: { type: Boolean, default: true },
  fps: { type: Number, default: 25 },
  cells: { type: Number, default: 96 },
  restartKey: { type: Number, default: 0 },
})
const canvas = ref(null)
let scene = null, fieldGrid = null
function rebuild () { scene = buildScene(); fieldGrid = props.field ? buildField(scene, props.cells) : null }
let rebuildT = null
watch(() => [setup.canvasW, setup.canvasH, setup.tubes, setup.types], () => { clearTimeout(rebuildT); rebuildT = setTimeout(rebuild, 200) }, { deep: true })

// clip mode: a free-running deck with its own state
let clipStart = performance.now(), clipState = newDeckState(), clipDeck = null
watch(() => [props.restartKey, props.clip?.effect], () => { clipStart = performance.now(); clipState = newDeckState() })

let raf = 0, last = 0
function frame (t) {
  raf = requestAnimationFrame(frame)
  if (t - last < 1000 / props.fps) return
  last = t
  const c = canvas.value
  if (!c || !scene) return
  let layers = []
  if (props.mode === 'clip') {
    const e = props.clip && effectByKey(props.clip.effect)
    if (e) {
      clipDeck = clipDeck && clipDeck.fx === e.id ? clipDeck : { fx: e.id }
      clipDeck.params = props.clip.params; clipDeck.el = 0; clipDeck.at = clipStart
      prepDeck(clipDeck, clipState, scene, t)
      layers = [{ blend: 0, op: 256, from: null, to: clipDeck, e: 1 }]
    }
  } else {
    const all = programLayers(dev.layers, dev.polledAt || t, cellOfTag, scene, t)
    if (props.mode === 'layer') {
      const l = all.find((x) => x.index === props.layer)
      layers = l ? [{ ...l, blend: 0, op: 256 }] : []
    } else layers = all
  }
  draw(c, scene, fieldGrid, evaluator(layers, scene), { field: props.field, pad: props.mode === 'layer' ? 3 : 8 })
}
onMounted(() => { rebuild(); raf = requestAnimationFrame(frame) })
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <canvas ref="canvas" class="pv" />
</template>

<style scoped>
.pv { display: block; width: 100%; height: 100%; background: #050608; border-radius: 12px; }
</style>
