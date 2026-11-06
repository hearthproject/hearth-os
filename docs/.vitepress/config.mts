import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { enDeliveryStages, zhDeliveryStages } from './delivery-sidebar.mjs'

const zhNav = [
  { text: '设计说明', link: '/design/', activeMatch: '^/design/' },
  { text: '交付路线', link: '/delivery/', activeMatch: '^/delivery/' },
  { text: '开发日志', link: '/log/day-03', activeMatch: '^/log/' },
  { text: '附录', link: '/reference/', activeMatch: '^/reference/' }
]

const enNav = [
  { text: 'Design', link: '/en/design/', activeMatch: '^/en/design/' },
  { text: 'Delivery', link: '/en/delivery/', activeMatch: '^/en/delivery/' },
  { text: 'Dev Log', link: '/en/log/day-03', activeMatch: '^/en/log/' },
  { text: 'Appendix', link: '/en/reference/', activeMatch: '^/en/reference/' }
]

const zhDesignSidebar = [
  {
    text: '设计说明',
    items: [
      { text: '总体设计', link: '/design/' },
      { text: '入口与交互', link: '/design/experience' },
      { text: '任务与持久执行', link: '/design/tasks' },
      { text: '控制面与授权', link: '/design/control' },
      { text: '执行器与路由', link: '/design/executors' },
      { text: '原生 Agent Runtime', link: '/design/native-agent-runtime' },
      { text: '审批、接管与外部副作用', link: '/design/effects' },
      { text: '运行环境与安全', link: '/design/safety' },
      { text: '记忆与能力进化', link: '/design/memory' },
      { text: '评估与成本', link: '/design/evaluation' },
      { text: '多设备与长期运行', link: '/design/operations' },
      { text: 'Agent 参考模式', link: '/design/agent-reference-patterns' }
    ]
  }
]

const enDesignSidebar = [
  {
    text: 'Design',
    items: [
      { text: 'Overall Design', link: '/en/design/' },
      { text: 'Entrances and Experience', link: '/en/design/experience' },
      { text: 'Tasks and Durable Execution', link: '/en/design/tasks' },
      { text: 'Control and Authority', link: '/en/design/control' },
      { text: 'Executors and Routing', link: '/en/design/executors' },
      { text: 'Native Agent Runtime', link: '/en/design/native-agent-runtime' },
      { text: 'Approvals, Takeover, and External Effects', link: '/en/design/effects' },
      { text: 'Runtime and Safety', link: '/en/design/safety' },
      { text: 'Memory and Capability Evolution', link: '/en/design/memory' },
      { text: 'Evaluation and Cost', link: '/en/design/evaluation' },
      { text: 'Multi-device and Long-running Operation', link: '/en/design/operations' },
      { text: 'Agent Reference Patterns', link: '/en/design/agent-reference-patterns' }
    ]
  }
]

const zhSidebar = {
  '/design/': zhDesignSidebar,
  '/delivery/': [
    {
      text: '交付路线',
      items: [
        { text: '交付路线与实施计划', link: '/delivery/' },
        { text: '阶段二至六交付状态', link: '/delivery/status' }
      ]
    },
    ...zhDeliveryStages
  ],
  '/log/': [
    {
      text: '开发日志',
      items: [
        { text: 'Day01 · 双语文档站上线', link: '/log/day-01' },
        { text: 'Day02 · 站点结构精简', link: '/log/day-02' },
        { text: 'Day03 · 阶段一 MVP 跑通', link: '/log/day-03' }
      ]
    }
  ],
  '/reference/': [
    {
      text: '附录',
      items: [
        { text: '附录总览', link: '/reference/' },
        { text: '工程实施', link: '/reference/engineering' },
        { text: '风险与停止条件', link: '/reference/risks' },
        { text: '关键决策', link: '/reference/decisions' },
        { text: '自研与集成', link: '/reference/build-vs-integrate' },
        { text: '术语表', link: '/reference/glossary' },
        { text: '默认清单', link: '/reference/checklists' },
        { text: '常见问题', link: '/reference/faq' },
        { text: '参与贡献', link: '/reference/contributing' },
        { text: '文档地图', link: '/reference/source-map' }
      ]
    }
  ]
}

const enSidebar = {
  '/en/design/': enDesignSidebar,
  '/en/delivery/': [
    {
      text: 'Delivery',
      items: [
        { text: 'Delivery Route & Implementation Plan', link: '/en/delivery/' },
        { text: 'Phase 2–6 Delivery Status', link: '/en/delivery/status' }
      ]
    },
    ...enDeliveryStages
  ],
  '/en/log/': [
    {
      text: 'Development Log',
      items: [
        { text: 'Day01 · Bilingual documentation launch', link: '/en/log/day-01' },
        { text: 'Day02 · Documentation structure cleanup', link: '/en/log/day-02' },
        { text: 'Day03 · Stage-one MVP runs end to end', link: '/en/log/day-03' }
      ]
    }
  ],
  '/en/reference/': [
    {
      text: 'Appendix',
      items: [
        { text: 'Appendix Overview', link: '/en/reference/' },
        { text: 'Engineering', link: '/en/reference/engineering' },
        { text: 'Risks and Stop Conditions', link: '/en/reference/risks' },
        { text: 'Key Decisions', link: '/en/reference/decisions' },
        { text: 'Build vs. Integrate', link: '/en/reference/build-vs-integrate' },
        { text: 'Glossary', link: '/en/reference/glossary' },
        { text: 'Default Checklists', link: '/en/reference/checklists' },
        { text: 'FAQ', link: '/en/reference/faq' },
        { text: 'Contributing', link: '/en/reference/contributing' },
        { text: 'Documentation Map', link: '/en/reference/source-map' }
      ]
    }
  ]
}

const zhSearchTranslations = {
  button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
  modal: {
    noResultsText: '没有找到结果',
    resetButtonTitle: '清除查询',
    footer: {
      selectText: '选择',
      navigateText: '切换',
      closeText: '关闭'
    }
  }
}

const enSearchTranslations = {
  button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
  modal: {
    noResultsText: 'No results found',
    resetButtonTitle: 'Reset search',
    footer: {
      selectText: 'to select',
      navigateText: 'to navigate',
      closeText: 'to close'
    }
  }
}

const tokenize = (text: string) => {
  const normalized = text.toLowerCase()
  const tokens = normalized.match(/[a-z0-9_]+/g) ?? []
  const runs = normalized.match(/[\u3400-\u9fff]+/g) ?? []
  const cjk: string[] = []
  for (const run of runs) {
    for (let i = 0; i < run.length; i += 1) {
      cjk.push(run[i])
      if (i < run.length - 1) cjk.push(run.slice(i, i + 2))
    }
  }
  return [...tokens, ...cjk]
}

const searchOptions = (translations: typeof zhSearchTranslations) => ({
  provider: 'local' as const,
  options: {
    miniSearch: {
      options: { tokenize },
      searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 1 } }
    },
    translations
  }
})

export default withMermaid(
  defineConfig({
    lang: 'zh-CN',
    title: 'Hearth',
    titleTemplate: ':title · Hearth',
    description:
      'Hearth 是一个单用户、自托管、长期驻留的个人 Agent OS。用持久执行、明确审批和可验证回执，把意图变成可靠的任务。',
    base: '/hearth-os/',
    cleanUrls: false,
    lastUpdated: true,
    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/hearth-os/logo.svg' }],
      ['meta', { name: 'theme-color', content: '#2f7fa8' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: 'Hearth — Personal Agent OS' }],
      [
        'meta',
        {
          property: 'og:description',
          content:
            'A self-hosted personal Agent OS for durable, auditable, and recoverable digital work.'
        }
      ],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }]
    ],
    sitemap: {
      hostname: 'https://hearthproject.github.io/hearth-os/'
    },
    themeConfig: {
      logo: { src: '/logo.svg', width: 28, height: 28 },
      siteTitle: 'Hearth',
      nav: zhNav,
      sidebar: zhSidebar,
      socialLinks: [
        { icon: 'github', link: 'https://github.com/hearthproject/hearth-os' }
      ],
      search: searchOptions(zhSearchTranslations),
      outline: { level: [2, 3], label: '本页目录' },
      docFooter: { prev: '上一篇', next: '下一篇' },
      lastUpdated: {
        text: '最后更新',
        formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
      },
      editLink: {
        pattern: 'https://github.com/hearthproject/hearth-os/edit/main/docs/:path',
        text: '在 GitHub 上编辑此页'
      },
      footer: {
        message: '为长期运行的个人 Agent 而设计。',
        copyright: 'Apache-2.0 · Hearth Project'
      }
    },
    locales: {
      root: {
        label: '简体中文',
        lang: 'zh-CN',
        title: 'Hearth',
        description:
          'Hearth 是一个单用户、自托管、长期驻留的个人 Agent OS。用持久执行、明确审批和可验证回执，把意图变成可靠的任务。'
      },
      en: {
        label: 'English',
        lang: 'en-US',
        link: '/en/',
        title: 'Hearth',
        description:
          'Hearth is a single-user, self-hosted personal Agent OS for durable, auditable, and recoverable digital work.',
        themeConfig: {
          nav: enNav,
          sidebar: enSidebar,
          search: searchOptions(enSearchTranslations),
          outline: { level: [2, 3], label: 'On this page' },
          docFooter: { prev: 'Previous', next: 'Next' },
          lastUpdated: {
            text: 'Last updated',
            formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
          },
          editLink: {
            pattern:
              'https://github.com/hearthproject/hearth-os/edit/main/docs/:path',
            text: 'Edit this page on GitHub'
          },
          footer: {
            message: 'Designed for a personal agent that runs for the long term.',
            copyright: 'Apache-2.0 · Hearth Project'
          }
        }
      }
    }
  })
)
