import { createApp } from 'vue'
import './styles.css'
import App from './App.vue'
import { init } from './wled.js'
import { installOverscrollGuard } from './overscroll.js'

installOverscrollGuard()
init()
createApp(App).mount('#app')
