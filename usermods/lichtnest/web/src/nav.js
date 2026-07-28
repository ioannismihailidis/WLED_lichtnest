// Tiny cross-screen navigation intents (sidebar -> screens).
import { reactive } from 'vue'

export const uiNav = reactive({
  openEffect: null,     // set to an effect id -> the Effekte screen opens its editor
  currentEffect: null,  // which effect editor is open (highlighted in the sidebar)
  openPlaylist: null,   // set to a playlist id -> the Playlists screen opens its editor
  currentPlaylist: null, // which playlist editor is open (highlighted in the sidebar)
})
