// Background image of the setup: preview only, never sent to the LEDs. Settings live in the
// setup file under the TD keys (Bgactive, Bgfile, Bgopacity, Bgfit, Bgzoom, Bgoffsetx,
// Bgoffsety, Bgsetup, Bgshow, Bglayers); the image itself is a JPEG on the device FS.
import { reactive, watch } from 'vue'
import { setup, setupName } from './setup.js'
import { url, uploadFile } from './api.js'

const DEF = { Bgactive: false, Bgfile: '', Bgopacity: 0.6, Bgfit: 'fit', Bgzoom: 1, Bgoffsetx: 0, Bgoffsety: 0, Bgsetup: true, Bgshow: false, Bglayers: false }
export const bgGet = (k) => (setup.extra[k] === undefined ? DEF[k] : setup.extra[k])
export const bgSet = (k, v) => { setup.extra[k] = v }
// shown in: 'setup' | 'program' | 'layers'
export function bgShown (where) {
  if (!bgGet('Bgactive') || !bgImage.img) return false
  return where === 'setup' ? !!bgGet('Bgsetup') : where === 'program' ? !!bgGet('Bgshow') : !!bgGet('Bglayers')
}

// the loaded image for the current Bgfile (device FS path)
export const bgImage = reactive({ file: '', img: null, rev: 0 })
function load (file) {
  bgImage.file = file
  if (!file || !file.startsWith('/')) { bgImage.img = null; bgImage.rev++; return }   // TD paths (Assets/...) are not on the device
  const im = new Image()
  im.onload = () => { if (bgImage.file === file) { bgImage.img = im; bgImage.rev++ } }
  im.onerror = () => { if (bgImage.file === file) { bgImage.img = null; bgImage.rev++ } }
  im.src = url(file) + '?v=' + Date.now()
}
watch(() => setup.extra.Bgfile, (f) => load(f || ''), { immediate: true })

// image rect inside a canvas rect (cx, cy, cw, ch; screen coordinates, y down):
// stretch / fit / fill, then zoom about the centre, offset in canvas fractions (y up)
export function bgRect (cx, cy, cw, ch) {
  const im = bgImage.img
  if (!im) return null
  const iw = im.naturalWidth || 1, ih = im.naturalHeight || 1
  let w, h
  const fit = bgGet('Bgfit')
  if (fit === 'stretch') { w = cw; h = ch } else {
    const s = fit === 'fill' ? Math.max(cw / iw, ch / ih) : Math.min(cw / iw, ch / ih)
    w = iw * s; h = ih * s
  }
  const z = +bgGet('Bgzoom') || 1
  w *= z; h *= z
  const x = cx + (cw - w) / 2 + (+bgGet('Bgoffsetx') || 0) * cw
  const y = cy + (ch - h) / 2 - (+bgGet('Bgoffsety') || 0) * ch
  return { x, y, w, h }
}

// choose: scale down to at most 1600 px, JPEG, upload as /bg_<setup>.jpg
export async function chooseImage (file) {
  const src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file) })
  const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
  const s = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s)
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height)
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82))
  const path = `/bg_${setupName().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 20)}.jpg`
  const ok = await uploadFile(path, blob)
  if (!ok) return false
  bgSet('Bgfile', path); bgSet('Bgactive', true)
  load(path)
  return true
}
export async function clearImage () {
  const f = bgGet('Bgfile')
  bgSet('Bgfile', ''); bgSet('Bgactive', false)
  if (f && f.startsWith('/bg_')) { try { await fetch(url(`/edit?func=delete&path=${encodeURIComponent(f)}`)) } catch (e) { /* ignore */ } }
}
