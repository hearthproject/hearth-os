<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

defineProps<{ mobile?: boolean }>()

const { page } = useData()

const isEnglish = computed(() => page.value.relativePath.startsWith('en/'))

const target = computed(() => {
  const relative = page.value.relativePath.replace(/^en\//, '')
  const path = relative === 'index.md'
    ? ''
    : relative
        .replace(/index\.md$/, '')
        .replace(/\.md$/, '.html')

  if (isEnglish.value) {
    return withBase(path ? `/${path}` : '/')
  }

  return withBase(path ? `/en/${path}` : '/en/')
})

const label = computed(() => (isEnglish.value ? '中文' : 'EN'))
const description = computed(() =>
  isEnglish.value ? '切换到中文版' : 'Switch to English'
)
</script>

<template>
  <a
    class="lang-switch"
    :class="{ 'lang-switch--mobile': mobile }"
    :href="target"
    :title="description"
    :aria-label="description"
  >
    <span class="lang-switch__mark" aria-hidden="true">◎</span>
    <span>{{ label }}</span>
  </a>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin-left: 20px;
  padding: 0 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}

.lang-switch:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}

.lang-switch__mark {
  color: var(--vp-c-brand-1);
  font-size: 13px;
  line-height: 1;
}

.lang-switch--mobile {
  margin: 12px 0 0;
  width: fit-content;
}

@media (max-width: 767px) {
  .lang-switch:not(.lang-switch--mobile) {
    display: inline-flex;
    height: 28px;
    margin-left: 2px;
    padding: 0 8px;
    gap: 4px;
    font-size: 11px;
  }

  .lang-switch:not(.lang-switch--mobile) .lang-switch__mark {
    display: none;
  }
}
</style>
