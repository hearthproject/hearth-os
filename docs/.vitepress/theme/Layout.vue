<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import LangSwitch from './components/LangSwitch.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <LangSwitch />
    </template>
    <template #nav-screen-content-after>
      <LangSwitch mobile />
    </template>
  </Layout>
</template>
