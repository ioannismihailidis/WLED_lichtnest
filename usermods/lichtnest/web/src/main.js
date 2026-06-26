import { createApp } from 'vue'
import './styles.css'
import App from './App.vue'
import { init } from './wled.js'

init()
createApp(App).mount('#app')
