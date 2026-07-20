// Shared preview elapsed (seconds) — MiniPlan / TexturePreview write, FxTimeline reads.
import { ref } from 'vue'

export const previewElapsed = ref(0)

export function setPreviewElapsed (t) {
  previewElapsed.value = t > 0 ? t : 0
}
