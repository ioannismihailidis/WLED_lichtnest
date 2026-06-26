<script setup>
import { confirmState, confirmYes, confirmNo } from '../confirm.js'
</script>

<template>
  <Transition name="cf">
    <div v-if="confirmState.open" class="ov" @click="confirmNo">
      <div class="card" @click.stop>
        <div class="ic" :class="{ danger: confirmState.danger }">
          <svg v-if="confirmState.danger" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12M10 11v5M14 11v5" /></svg>
          <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>
        </div>
        <div class="title">{{ confirmState.title }}</div>
        <div v-if="confirmState.body" class="body">{{ confirmState.body }}</div>
        <div class="row">
          <button class="cancel" @click="confirmNo">Abbrechen</button>
          <button class="confirm" :class="{ danger: confirmState.danger }" @click="confirmYes">{{ confirmState.confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ov { position: fixed; inset: 0; z-index: 60; background: rgba(6,7,9,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 28px; }
.card { width: 100%; max-width: 360px; background: #14161b; border: 1px solid rgba(255,255,255,.1); border-radius: 20px; padding: 24px; box-shadow: 0 30px 70px -15px rgba(0,0,0,.8); }
.ic { width: 46px; height: 46px; border-radius: 13px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px; background: rgba(240,162,60,.16); border: 1px solid rgba(240,162,60,.3); color: var(--accent); }
.ic.danger { background: rgba(217,130,111,.16); border-color: rgba(217,130,111,.3); color: #e8927f; }
.title { font-size: 18px; font-weight: 800; color: var(--text); letter-spacing: -.01em; }
.body { font-size: 14px; color: var(--muted2); line-height: 1.5; margin-top: 8px; }
.row { display: flex; gap: 10px; margin-top: 22px; }
.cancel { flex: 1; height: 46px; border-radius: 13px; background: #1f2228; border: 1px solid rgba(255,255,255,.1); color: #e8e9ec; font-weight: 700; font-size: 14px; cursor: pointer; }
.confirm { flex: 1; height: 46px; border-radius: 13px; border: none; font-weight: 800; font-size: 14px; cursor: pointer; background: var(--accent); color: #1a1206; }
.confirm.danger { background: #d9826f; color: #1a0d09; }

.cf-enter-active, .cf-leave-active { transition: opacity .15s ease; }
.cf-enter-from, .cf-leave-to { opacity: 0; }
.cf-enter-active .card { animation: cfpop .18s ease; }
@keyframes cfpop { from { transform: scale(.94); opacity: 0 } to { transform: scale(1); opacity: 1 } }
</style>
