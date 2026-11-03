<script setup lang="ts">
import { withBase } from 'vitepress'

export interface DocCardItem {
  no?: string
  title: string
  text: string
  link: string
  meta?: string
}

defineProps<{
  items: DocCardItem[]
  columns?: 2 | 3
}>()
</script>

<template>
  <div class="doc-card-grid" :class="`doc-card-grid--${columns ?? 3}`">
    <a
      v-for="item in items"
      :key="item.link"
      class="doc-card"
      :href="withBase(item.link)"
    >
      <span v-if="item.no" class="doc-card__no">{{ item.no }}</span>
      <span v-if="item.meta" class="doc-card__meta">{{ item.meta }}</span>
      <strong class="doc-card__title">{{ item.title }}</strong>
      <span class="doc-card__text">{{ item.text }}</span>
      <span class="doc-card__arrow" aria-hidden="true">→</span>
    </a>
  </div>
</template>

<style scoped>
.doc-card-grid {
  display: grid;
  gap: 16px;
  margin: 28px 0 40px;
}

.doc-card-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.doc-card-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.doc-card {
  position: relative;
  display: flex;
  min-height: 172px;
  flex-direction: column;
  gap: 10px;
  padding: 22px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 18px;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--vp-c-bg-soft) 88%, transparent), transparent),
    var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.doc-card::after {
  position: absolute;
  right: -40px;
  bottom: -52px;
  width: 128px;
  height: 128px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--vp-c-brand-soft), transparent 68%);
  content: '';
  pointer-events: none;
}

.doc-card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-2);
  box-shadow: 0 18px 46px rgba(31, 22, 14, 0.1);
}

.doc-card__no {
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.12em;
}

.doc-card__meta {
  color: var(--vp-c-text-3);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.doc-card__title {
  max-width: 88%;
  font-size: 17px;
  line-height: 1.4;
}

.doc-card__text {
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.doc-card__arrow {
  margin-top: auto;
  color: var(--vp-c-brand-1);
  font-size: 18px;
  transition: transform 0.2s ease;
}

.doc-card:hover .doc-card__arrow {
  transform: translateX(4px);
}

@media (max-width: 960px) {
  .doc-card-grid--3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .doc-card-grid--2,
  .doc-card-grid--3 {
    grid-template-columns: 1fr;
  }
}
</style>
