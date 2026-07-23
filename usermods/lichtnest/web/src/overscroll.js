// Disable mobile pull-to-refresh / overscroll bounce.
// Works in Firefox Android; Chrome Android often ignores page-level PTR locks.

const CUSHION = 1
const bound = new WeakSet()
const lastY = new WeakMap()

function canScrollY (el) {
  if (!(el instanceof Element)) return false
  if (el === document.body || el === document.documentElement) return false
  const oy = getComputedStyle(el).overflowY
  if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false
  return el.scrollHeight > el.clientHeight + 1
}

function scrollParent (el) {
  let n = el
  while (n && n !== document.body && n !== document.documentElement) {
    if (canScrollY(n)) return n
    n = n.parentElement
  }
  return null
}

function insideTouchNone (el) {
  let n = el
  while (n && n !== document.body && n !== document.documentElement) {
    if (n instanceof Element && getComputedStyle(n).touchAction === 'none') return true
    n = n.parentElement
  }
  return false
}

function touchY (e) {
  const t = e.touches && e.touches[0]
  return t ? t.clientY : 0
}

function applyCushion (el) {
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  if (max <= CUSHION * 2) return
  if (el.scrollTop < CUSHION) el.scrollTop = CUSHION
  if (el.scrollTop > max - CUSHION) el.scrollTop = max - CUSHION
}

function bindScroller (el) {
  if (!el || bound.has(el)) return
  bound.add(el)

  el.addEventListener('scroll', () => applyCushion(el), { passive: true })
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    applyCushion(el)
    lastY.set(el, touchY(e))
  }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return
    const y = touchY(e)
    const prev = lastY.has(el) ? lastY.get(el) : y
    lastY.set(el, y)
    const dy = y - prev
    if (dy === 0) return
    const atTop = el.scrollTop <= CUSHION
    const atBot = el.scrollTop >= el.scrollHeight - el.clientHeight - CUSHION
    if ((dy > 0 && atTop) || (dy < 0 && atBot)) {
      e.preventDefault()
      applyCushion(el)
    }
  }, { passive: false })
  applyCushion(el)
}

function onDocTouchStart (e) {
  if (e.touches.length !== 1) return
  const sc = scrollParent(e.target)
  if (sc) {
    bindScroller(sc)
    lastY.set(sc, touchY(e))
    applyCushion(sc)
  }
}

function onDocTouchMove (e) {
  if (e.touches.length !== 1) return
  if (insideTouchNone(e.target)) {
    e.preventDefault()
    return
  }
  const sc = scrollParent(e.target)
  if (!sc) {
    e.preventDefault()
    return
  }
  bindScroller(sc)
  const y = touchY(e)
  const prev = lastY.has(sc) ? lastY.get(sc) : y
  lastY.set(sc, y)
  const dy = y - prev
  if (dy === 0) return
  const atTop = sc.scrollTop <= CUSHION
  const atBot = sc.scrollTop >= sc.scrollHeight - sc.clientHeight - CUSHION
  if ((dy > 0 && atTop) || (dy < 0 && atBot)) {
    e.preventDefault()
    applyCushion(sc)
  }
}

export function guardScrollEl (el) {
  bindScroller(el)
}

export function installOverscrollGuard () {
  document.documentElement.style.overscrollBehaviorY = 'none'
  document.body.style.overscrollBehaviorY = 'none'
  document.addEventListener('touchstart', onDocTouchStart, { passive: true, capture: true })
  document.addEventListener('touchmove', onDocTouchMove, { passive: false, capture: true })
}
