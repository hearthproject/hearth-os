import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import DocCardGrid from './components/DocCardGrid.vue'
import HomeDashboard from './components/HomeDashboard.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('DocCardGrid', DocCardGrid)
    app.component('HomeDashboard', HomeDashboard)
  }
} satisfies Theme
