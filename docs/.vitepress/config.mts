import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { enDeliveryStages, zhDeliveryStages } from './delivery-sidebar.mjs'

const zhNav = [
  { text: '设计说明', link: '/design/', activeMatch: '^/(design|architecture)/' },
  { text: '交付路线', link: '/delivery/', activeMatch: '^/delivery/' },
  { text: '开发日志', link: '/log/day-02', activeMatch: '^/log/' },
  { text: '附录', link: '/reference/', activeMatch: '^/reference/' }
]

const enNav = [
  { text: 'Design', link: '/en/design/', activeMatch: '^/en/(design|architecture)/' },
  { text: 'Delivery', link: '/en/delivery/', activeMatch: '^/en/delivery/' },
  { text: 'Dev Log', link: '/en/log/day-02', activeMatch: '^/en/log/' },
  { text: 'Appendix', link: '/en/reference/', activeMatch: '^/en/reference/' }
]

const zhArchitectureItems = [
  { text: '总体架构与数据流', link: '/architecture/overview' },
  { text: '领域模型与协议', link: '/architecture/domain-model' },
  { text: '个人网关与多入口', link: '/architecture/gateway' },
  { text: '控制面与自主性', link: '/architecture/control-plane' },
  { text: '持久执行与恢复', link: '/architecture/durable-execution' },
  { text: '执行器模型与路由', link: '/architecture/executor-model' },
  { text: '执行器目录', link: '/architecture/executor-catalog' },
  { text: '人工接管与审批', link: '/architecture/human-takeover' },
  { text: '执行安全与副作用', link: '/architecture/execution-safety' },
  { text: '记忆系统', link: '/architecture/memory' },
  { text: '技能进化', link: '/architecture/evolution' },
  { text: '安全与隐私', link: '/architecture/security-privacy' },
  { text: '评估体系', link: '/architecture/evaluation' },
  { text: 'Token 经济', link: '/architecture/token-economics' },
  { text: '前端与移动体验', link: '/architecture/frontend-experience' }
]

const enArchitectureItems = [
  { text: 'Architecture & Data Flow', link: '/en/architecture/overview' },
  { text: 'Domain Model & Protocols', link: '/en/architecture/domain-model' },
  { text: 'Personal Gateway', link: '/en/architecture/gateway' },
  { text: 'Control Plane & Autonomy', link: '/en/architecture/control-plane' },
  { text: 'Durable Execution', link: '/en/architecture/durable-execution' },
  { text: 'Executor Model & Routing', link: '/en/architecture/executor-model' },
  { text: 'Executor Catalog', link: '/en/architecture/executor-catalog' },
  { text: 'Human Takeover', link: '/en/architecture/human-takeover' },
  { text: 'Execution Safety', link: '/en/architecture/execution-safety' },
  { text: 'Memory OS', link: '/en/architecture/memory' },
  { text: 'Evolution OS', link: '/en/architecture/evolution' },
  { text: 'Security & Privacy', link: '/en/architecture/security-privacy' },
  { text: 'Evaluation', link: '/en/architecture/evaluation' },
  { text: 'Token Economics', link: '/en/architecture/token-economics' },
  { text: 'Frontend & Mobile', link: '/en/architecture/frontend-experience' }
]

const zhDesignSidebar = [
  {
    text: '设计说明',
    items: [
      { text: '项目设计与取舍', link: '/design/' },
      { text: '技术选型与最终决策', link: '/design/technology-selection' }
    ]
  },
  {
    text: '架构细节',
    collapsed: false,
    items: zhArchitectureItems
  }
]

const enDesignSidebar = [
  {
    text: 'Design',
    items: [
      { text: 'Design & Tradeoffs', link: '/en/design/' },
      { text: 'Technology Choices & Decisions', link: '/en/design/technology-selection' }
    ]
  },
  {
    text: 'Architecture Details',
    collapsed: false,
    items: enArchitectureItems
  }
]

const zhSidebar = {
  '/design/': zhDesignSidebar,
  '/architecture/': zhDesignSidebar,
  '/delivery/': [
    {
      text: '交付路线',
      items: [{ text: '交付路线与实施计划', link: '/delivery/' }]
    },
    ...zhDeliveryStages
  ],
  '/log/': [
    {
      text: '开发日志',
      items: [
        { text: 'Day01 · 双语文档站上线', link: '/log/day-01' },
        { text: 'Day02 · 站点结构精简', link: '/log/day-02' }
      ]
    }
  ],
  '/reference/': [
    {
      text: '附录',
      items: [{ text: '附录总览', link: '/reference/' }]
    },
    {
      text: '工程与决策',
      items: [
        { text: '工程实施与仓库结构', link: '/reference/engineering' },
        { text: '风险与 Kill Criteria', link: '/reference/risks' },
        { text: 'ADR 与关键决策', link: '/reference/decisions' }
      ]
    },
    {
      text: '参考资料',
      collapsed: false,
      items: [
        { text: '自研与集成边界', link: '/reference/build-vs-integrate' },
        { text: '术语表', link: '/reference/glossary' },
        { text: '默认清单', link: '/reference/checklists' },
        { text: '常见问题', link: '/reference/faq' },
        { text: '参与贡献与文档维护', link: '/reference/contributing' },
        { text: '文档来源与覆盖', link: '/reference/source-map' },
        { text: '完整路线图（归档）', link: '/reference/full-roadmap' }
      ]
    }
  ]
}

const enSidebar = {
  '/en/design/': enDesignSidebar,
  '/en/architecture/': enDesignSidebar,
  '/en/delivery/': [
    {
      text: 'Delivery',
      items: [
        { text: 'Delivery Route & Implementation Plan', link: '/en/delivery/' }
      ]
    },
    ...enDeliveryStages
  ],
  '/en/log/': [
    {
      text: 'Development Log',
      items: [
        { text: 'Day01 · Bilingual documentation launch', link: '/en/log/day-01' },
        { text: 'Day02 · Documentation structure cleanup', link: '/en/log/day-02' }
      ]
    }
  ],
  '/en/reference/': [
    {
      text: 'Appendix',
      items: [{ text: 'Appendix Overview', link: '/en/reference/' }]
    },
    {
      text: 'Engineering & Decisions',
      items: [
        { text: 'Engineering & Repository', link: '/en/reference/engineering' },
        { text: 'Risks & Kill Criteria', link: '/en/reference/risks' },
        { text: 'ADRs & Decisions', link: '/en/reference/decisions' }
      ]
    },
    {
      text: 'Reference Material',
      collapsed: false,
      items: [
        { text: 'Build vs. Integrate', link: '/en/reference/build-vs-integrate' },
        { text: 'Glossary', link: '/en/reference/glossary' },
        { text: 'Default Checklists', link: '/en/reference/checklists' },
        { text: 'FAQ', link: '/en/reference/faq' },
        { text: 'Contributing & Docs', link: '/en/reference/contributing' },
        { text: 'Sources & Coverage', link: '/en/reference/source-map' },
        { text: 'Full Roadmap (Archive)', link: '/en/reference/full-roadmap' }
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
