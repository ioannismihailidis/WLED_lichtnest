import { createApp } from 'vue'
import '../src/styles.css'
import './master.css'
import App from './App.vue'
import { startPolling } from './api.js'
import { loadSetup } from './setup.js'
import { loadShow } from './show.js'

startPolling()
loadSetup()
loadShow()
createApp(App).mount('#app')
