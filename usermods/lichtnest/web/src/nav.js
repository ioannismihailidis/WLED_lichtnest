// Cross-screen navigation intents (deep-links between Effekte ↔ Tubes/Plan)
// and sidebar detail lists (quick switch while editing).
import { reactive } from 'vue'

export const uiNav = reactive({
  screen: null,       // 'tubes' | 'effects' | … — consumed by App.vue
  tubesView: null,    // 'list' | 'plan' — consumed by Tubes.vue
  planMode: null,     // 'arrange' | 'test' | 'marker' — consumed by Plan.vue
  placeMarker: false, // next tap on plan places a marker
})

/** Jump to Tubes → 2D-Plan, optionally entering marker-place mode. */
export function goPlan (opts = {}) {
  uiNav.screen = 'tubes'
  uiNav.tubesView = 'plan'
  uiNav.planMode = opts.mode || (opts.placeMarker ? 'marker' : 'arrange')
  uiNav.placeMarker = !!opts.placeMarker
}

export function consumeNav (key) {
  const v = uiNav[key]
  uiNav[key] = (key === 'placeMarker') ? false : null
  return v
}

/** Sidebar secondary list while a screen is in editor/detail view. */
export const sideNav = reactive({
  kind: null,        // 'effects' | 'palettes' | 'playlists'
  activeId: null,    // currently open item
  pickId: null,      // sidebar → screen: open this item
  requestList: false // sidebar → screen: leave editor, show list
})

export function publishSideNav (kind, activeId) {
  sideNav.kind = kind
  sideNav.activeId = activeId
  sideNav.requestList = false
}

export function clearSideNav (kind) {
  if (kind && sideNav.kind !== kind) return
  sideNav.kind = null
  sideNav.activeId = null
  sideNav.pickId = null
  sideNav.requestList = false
}

export function pickSideNav (id) {
  if (sideNav.activeId === id) return
  sideNav.pickId = id
}

export function consumeSidePick () {
  const id = sideNav.pickId
  sideNav.pickId = null
  return id
}

export function requestSideList () {
  if (!sideNav.kind) return
  sideNav.requestList = true
}

export function consumeSideList () {
  if (!sideNav.requestList) return false
  sideNav.requestList = false
  return true
}
