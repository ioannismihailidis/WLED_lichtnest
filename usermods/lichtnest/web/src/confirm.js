// Promise-based confirm dialog shared across screens (replaces window.confirm).
// Usage:  if (await confirmDialog({ title, body, confirmLabel })) { ... }
import { reactive } from 'vue'

export const confirmState = reactive({
  open: false, title: '', body: '', confirmLabel: 'Löschen', danger: true, _resolve: null,
})

export function confirmDialog ({ title = 'Sicher?', body = '', confirmLabel = 'Löschen', danger = true } = {}) {
  return new Promise((resolve) => {
    confirmState.title = title
    confirmState.body = body
    confirmState.confirmLabel = confirmLabel
    confirmState.danger = danger
    confirmState.open = true
    confirmState._resolve = resolve
  })
}

function close (val) {
  confirmState.open = false
  const r = confirmState._resolve
  confirmState._resolve = null
  if (r) r(val)
}
export function confirmYes () { close(true) }
export function confirmNo () { close(false) }
