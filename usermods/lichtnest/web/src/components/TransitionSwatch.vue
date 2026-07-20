<script setup>
// Tiny animated CSS preview for playlist transition types (add-sheet + editor chips).
defineProps({ type: { type: String, default: 'fade' } })
</script>

<template>
  <span class="sw" :class="'t-' + type" aria-hidden="true">
    <span class="a" /><span class="b" /><span class="m" />
  </span>
</template>

<style scoped>
.sw {
  position: relative; display: block; width: 100%; height: 32px; border-radius: 7px;
  overflow: hidden; background: #0d0f13; flex: none;
}
.a, .b, .m { position: absolute; inset: 0; }
.a { background: #f0a23c; }
.b { background: #27c5ff; }

/* Crossfade — orange ↔ cyan blend */
.t-fade .a { animation: xf 1.6s ease-in-out infinite alternate; }
.t-fade .b { opacity: 0; animation: xf 1.6s ease-in-out infinite alternate-reverse; }
@keyframes xf { from { opacity: 1 } to { opacity: 0 } }

/* Through black */
.t-black .a { animation: blk 1.8s ease-in-out infinite; }
.t-black .b { background: #0d0f13; animation: blk2 1.8s ease-in-out infinite; }
@keyframes blk { 0%, 40% { opacity: 1 } 50%, 55% { opacity: 0 } 100% { opacity: 0 } }
@keyframes blk2 { 0%, 50% { opacity: 0 } 60%, 100% { opacity: 1 } }

/* Wipe L→R */
.t-wipe .b { clip-path: inset(0 100% 0 0); animation: wipe 1.5s linear infinite; }
@keyframes wipe { to { clip-path: inset(0 0 0 0) } }

/* Woosh — fast soft wipe */
.t-woosh .b { clip-path: inset(0 100% 0 0); animation: wipe 0.7s cubic-bezier(.2,.8,.2,1) infinite; }
.t-woosh .m {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
  width: 30%; inset: 0 auto 0 0; animation: woosh 0.7s cubic-bezier(.2,.8,.2,1) infinite;
}
@keyframes woosh { from { left: -30% } to { left: 100% } }

/* Digital — random blocks reveal */
.t-digital {
  background:
    repeating-linear-gradient(90deg, #f0a23c 0 12%, #0d0f13 12% 18%, #27c5ff 18% 30%, #0d0f13 30% 38%),
    #0d0f13;
  background-size: 200% 100%;
  animation: dig 1.4s steps(8) infinite;
}
.t-digital .a, .t-digital .b { display: none; }
@keyframes dig { to { background-position: -100% 0 } }

/* Cascade — horizontal bands */
.t-cascade .b {
  background: repeating-linear-gradient(180deg, #27c5ff 0 20%, transparent 20% 40%);
  mix-blend-mode: normal; opacity: 0; animation: casc 1.6s linear infinite;
}
.t-cascade .a { background: repeating-linear-gradient(180deg, #f0a23c 0 20%, #c47a20 20% 40%); }
@keyframes casc { 0% { opacity: 0; clip-path: inset(0 0 100% 0) } 100% { opacity: 1; clip-path: inset(0 0 0 0) } }

/* Iris — circle expand */
.t-iris .b { clip-path: circle(0% at 50% 50%); animation: iris 1.5s ease-out infinite; }
@keyframes iris { to { clip-path: circle(75% at 50% 50%) } }

/* Border — ring wipe */
.t-border .b {
  background: conic-gradient(#27c5ff 0deg, #27c5ff var(--p, 0deg), transparent var(--p, 0deg));
  animation: bord 1.5s linear infinite;
  -webkit-mask: radial-gradient(farthest-side, transparent 55%, #000 56%);
  mask: radial-gradient(farthest-side, transparent 55%, #000 56%);
}
.t-border .a { background: #f0a23c; opacity: .55; }
@keyframes bord {
  0% { background: conic-gradient(#27c5ff 0deg, transparent 0deg); }
  100% { background: conic-gradient(#27c5ff 360deg, transparent 360deg); }
}

/* Sparkle */
.t-sparkle .a { background: #f0a23c; }
.t-sparkle .b {
  background:
    radial-gradient(circle at 20% 40%, #fff 0 1.5px, transparent 2px),
    radial-gradient(circle at 70% 30%, #fff 0 1.5px, transparent 2px),
    radial-gradient(circle at 45% 70%, #27c5ff 0 2px, transparent 2.5px),
    radial-gradient(circle at 85% 65%, #fff 0 1px, transparent 1.5px),
    #27c5ff;
  opacity: 0; animation: spk 1.2s ease-in-out infinite;
}
@keyframes spk { 0%, 100% { opacity: 0 } 40%, 70% { opacity: 1 } }

/* Strobe */
.t-strobe .a { background: #f0a23c; animation: str 0.5s steps(1) infinite; }
.t-strobe .b { background: #fff; animation: str2 0.5s steps(1) infinite; }
@keyframes str { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes str2 { 0%, 49% { opacity: 0 } 50%, 100% { opacity: 1 } }
</style>
