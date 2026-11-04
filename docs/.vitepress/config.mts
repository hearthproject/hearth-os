import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const zhNav = [
  { text: '开始阅读', link: '/guide/', activeMatch: '^/guide/' },
  { text: '产品', link: '/product/', activeMatch: '^/product/' },
  { text: '系统设计', link: '/architecture/', activeMatch: '^/architecture/' },
  { text: '交付路线', link: '/delivery/', activeMatch: '^/delivery/' },
  { text: '参考', link: '/reference/', activeMatch: '^/reference/' }
]

const enNav = [
  { text: 'Start', link: '/en/guide/', activeMatch: '^/en/guide/' },
  { text: 'Product', link: '/en/product/', activeMatch: '^/en/product/' },
  { text: 'System Design', link: '/en/architecture/', activeMatch: '^/en/architecture/' },
  { text: 'Delivery', link: '/en/delivery/', activeMatch: '^/en/delivery/' },
  { text: 'Reference', link: '/en/reference/', activeMatch: '^/en/reference/' }
]

const zhSidebar = {
  '/guide/': [
    {
      text: '开始阅读',
      items: [
        { text: '文档首页', link: '/guide/' },
        { text: '认识 Hearth', link: '/guide/what-is-hearth' },
        { text: '阅读指南', link: '/guide/reading-guide' },
        { text: '项目状态', link: '/guide/project-status' }
      ]
    }
  ],
  '/product/': [
    {
      text: '产品',
      items: [
        { text: '产品总览', link: '/product/' },
        { text: '产品定义与边界', link: '/product/definition' },
        { text: '设计原则与架构不变量', link: '/product/design-principles' },
        { text: '任务覆盖与完成定义', link: '/product/task-coverage' }
      ]
    }
  ],
  '/architecture/': [
    {
      text: '架构基础',
      items: [
        { text: '系统设计总览', link: '/architecture/' },
        { text: '总体架构与数据流', link: '/architecture/overview' },
        { text: '领域模型与协议', link: '/architecture/domain-model' }
      ]
    },
    {
      text: '入口与控制',
      items: [
        { text: '个人网关与多入口', link: '/architecture/gateway' },
        { text: '控制面与自主性', link: '/architecture/control-plane' },
        { text: '持久执行与恢复', link: '/architecture/durable-execution' }
      ]
    },
    {
      text: '执行器体系',
      items: [
        { text: '执行器模型与路由', link: '/architecture/executor-model' },
        { text: '执行器目录', link: '/architecture/executor-catalog' },
        { text: '人工接管与审批', link: '/architecture/human-takeover' }
      ]
    },
    {
      text: '安全与智能',
      items: [
        { text: '执行安全与副作用', link: '/architecture/execution-safety' },
        { text: '记忆系统', link: '/architecture/memory' },
        { text: '技能进化', link: '/architecture/evolution' },
        { text: '安全与隐私', link: '/architecture/security-privacy' },
        { text: '评估体系', link: '/architecture/evaluation' }
      ]
    },
    {
      text: '经济与体验',
      items: [
        { text: 'Token 经济', link: '/architecture/token-economics' },
        { text: '前端与移动体验', link: '/architecture/frontend-experience' }
      ]
    }
  ],
  '/delivery/': [
    {
      text: '交付路线',
      items: [
        { text: '交付总览', link: '/delivery/' },
        { text: '产品路线图（总纲）', link: '/delivery/roadmap' }
      ]
    },
    {
      text: '从 0 到 100 开发计划',
      items: [
        { text: '计划总览', link: '/delivery/development-plan' },
        { text: 'S0 · 定义与原型', link: '/delivery/stage-0' },
        { text: 'S1 · 持久内核与 MVP', link: '/delivery/stage-1' },
        { text: 'S2 · Personal Operator', link: '/delivery/stage-2' },
        { text: 'S3 · Computer Operator', link: '/delivery/stage-3' },
        { text: 'S4 · 主动个人 Agent', link: '/delivery/stage-4' },
        { text: 'S5 · 记忆与进化', link: '/delivery/stage-5' },
        { text: 'S6 · 多设备与长期运行', link: '/delivery/stage-6' }
      ]
    },
    {
      text: '工程保障',
      items: [
        { text: '工程交付与仓库结构', link: '/delivery/engineering' },
        { text: '风险与 Kill Criteria', link: '/delivery/risks' },
        { text: 'ADR 与关键决策', link: '/delivery/decisions' }
      ]
    }
  ],
  '/reference/': [
    {
      text: '参考与附录',
      items: [
        { text: '参考总览', link: '/reference/' },
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
  '/en/guide/': [
    {
      text: 'Start Here',
      items: [
        { text: 'Documentation Home', link: '/en/guide/' },
        { text: 'What is Hearth?', link: '/en/guide/what-is-hearth' },
        { text: 'Reading Guide', link: '/en/guide/reading-guide' },
        { text: 'Project Status', link: '/en/guide/project-status' }
      ]
    }
  ],
  '/en/product/': [
    {
      text: 'Product',
      items: [
        { text: 'Product Overview', link: '/en/product/' },
        { text: 'Definition & Boundaries', link: '/en/product/definition' },
        { text: 'Design Principles', link: '/en/product/design-principles' },
        { text: 'Task Coverage & Done', link: '/en/product/task-coverage' }
      ]
    }
  ],
  '/en/architecture/': [
    {
      text: 'Foundations',
      items: [
        { text: 'System Design Overview', link: '/en/architecture/' },
        { text: 'Architecture & Data Flow', link: '/en/architecture/overview' },
        { text: 'Domain Model & Protocols', link: '/en/architecture/domain-model' }
      ]
    },
    {
      text: 'Entry & Control',
      items: [
        { text: 'Personal Gateway', link: '/en/architecture/gateway' },
        { text: 'Control Plane & Autonomy', link: '/en/architecture/control-plane' },
        { text: 'Durable Execution', link: '/en/architecture/durable-execution' }
      ]
    },
    {
      text: 'Executors',
      items: [
        { text: 'Executor Model & Routing', link: '/en/architecture/executor-model' },
        { text: 'Executor Catalog', link: '/en/architecture/executor-catalog' },
        { text: 'Human Takeover', link: '/en/architecture/human-takeover' }
      ]
    },
    {
      text: 'Safety & Intelligence',
      items: [
        { text: 'Execution Safety', link: '/en/architecture/execution-safety' },
        { text: 'Memory OS', link: '/en/architecture/memory' },
        { text: 'Evolution OS', link: '/en/architecture/evolution' },
        { text: 'Security & Privacy', link: '/en/architecture/security-privacy' },
        { text: 'Evaluation', link: '/en/architecture/evaluation' }
      ]
    },
    {
      text: 'Economics & Experience',
      items: [
        { text: 'Token Economics', link: '/en/architecture/token-economics' },
        { text: 'Frontend & Mobile', link: '/en/architecture/frontend-experience' }
      ]
    }
  ],
  '/en/delivery/': [
    {
      text: 'Delivery',
      items: [
        { text: 'Delivery Overview', link: '/en/delivery/' },
        { text: 'Product Roadmap (Master)', link: '/en/delivery/roadmap' }
      ]
    },
    {
      text: 'From 0 to 100',
      items: [
        { text: 'Plan Overview', link: '/en/delivery/development-plan' },
        { text: 'S0 · Definition & Prototype', link: '/en/delivery/stage-0' },
        { text: 'S1 · Durable Kernel & MVP', link: '/en/delivery/stage-1' },
        { text: 'S2 · Personal Operator', link: '/en/delivery/stage-2' },
        { text: 'S3 · Computer Operator', link: '/en/delivery/stage-3' },
        { text: 'S4 · Proactive Personal Agent', link: '/en/delivery/stage-4' },
        { text: 'S5 · Memory & Evolution', link: '/en/delivery/stage-5' },
        { text: 'S6 · Multi-device & Operations', link: '/en/delivery/stage-6' }
      ]
    },
    {
      text: 'Engineering Safeguards',
      items: [
        { text: 'Engineering & Repository', link: '/en/delivery/engineering' },
        { text: 'Risks & Kill Criteria', link: '/en/delivery/risks' },
        { text: 'ADRs & Decisions', link: '/en/delivery/decisions' }
      ]
    }
  ],
  '/en/reference/': [
    {
      text: 'Reference',
      items: [
        { text: 'Reference Overview', link: '/en/reference/' },
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
