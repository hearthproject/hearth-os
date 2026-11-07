import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const zhNav = [
  { text: '开始使用', link: '/guide/', activeMatch: '^/guide/' },
  { text: '产品设计', link: '/design/', activeMatch: '^/design/' },
  { text: '交付路线', link: '/delivery/', activeMatch: '^/delivery/' },
  { text: '开发日志', link: '/log/', activeMatch: '^/log/' },
  { text: '参考', link: '/reference/', activeMatch: '^/reference/' }
]

const enNav = [
  { text: 'Get started', link: '/en/guide/', activeMatch: '^/en/guide/' },
  { text: 'Design', link: '/en/design/', activeMatch: '^/en/design/' },
  { text: 'Delivery', link: '/en/delivery/', activeMatch: '^/en/delivery/' },
  { text: 'Dev log', link: '/en/log/', activeMatch: '^/en/log/' },
  { text: 'Reference', link: '/en/reference/', activeMatch: '^/en/reference/' }
]

const zhGuideSidebar = [
  {
    text: '开始使用',
    items: [
      { text: '快速开始', link: '/guide/' },
      { text: '接入模型', link: '/guide/models' },
      { text: '数据、备份与恢复', link: '/guide/data' },
      { text: '开发与测试', link: '/guide/development' }
    ]
  }
]

const enGuideSidebar = [
  {
    text: 'Get started',
    items: [
      { text: 'Quick start', link: '/en/guide/' },
      { text: 'Connect a model', link: '/en/guide/models' },
      { text: 'Data, backup, and restore', link: '/en/guide/data' },
      { text: 'Development and tests', link: '/en/guide/development' }
    ]
  }
]

const zhDesignSidebar = [
  {
    text: '产品设计',
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
    text: 'Product design',
    items: [
      { text: 'Overall design', link: '/en/design/' },
      { text: 'Entrances and experience', link: '/en/design/experience' },
      { text: 'Tasks and durable execution', link: '/en/design/tasks' },
      { text: 'Control and authority', link: '/en/design/control' },
      { text: 'Executors and routing', link: '/en/design/executors' },
      { text: 'Native agent runtime', link: '/en/design/native-agent-runtime' },
      { text: 'Approvals, takeover, and external effects', link: '/en/design/effects' },
      { text: 'Runtime and safety', link: '/en/design/safety' },
      { text: 'Memory and capability evolution', link: '/en/design/memory' },
      { text: 'Evaluation and cost', link: '/en/design/evaluation' },
      { text: 'Multi-device and long-running operation', link: '/en/design/operations' },
      { text: 'Agent reference patterns', link: '/en/design/agent-reference-patterns' }
    ]
  }
]

const zhDeliverySidebar = [
  {
    text: '交付与进度',
    items: [
      { text: '交付总览', link: '/delivery/' },
      { text: '第一阶段 MVP 验收', link: '/delivery/mvp' },
      { text: '阶段二至六能力', link: '/delivery/capabilities' },
      { text: '剩余路线', link: '/delivery/roadmap' },
      { text: '验收与证据', link: '/delivery/acceptance' }
    ]
  }
]

const enDeliverySidebar = [
  {
    text: 'Delivery and progress',
    items: [
      { text: 'Delivery overview', link: '/en/delivery/' },
      { text: 'Phase-one MVP acceptance', link: '/en/delivery/mvp' },
      { text: 'Phase 2–6 capabilities', link: '/en/delivery/capabilities' },
      { text: 'Remaining roadmap', link: '/en/delivery/roadmap' },
      { text: 'Acceptance and evidence', link: '/en/delivery/acceptance' }
    ]
  }
]

const zhLogSidebar = [
  {
    text: '开发日志',
    items: [
      { text: '日志索引', link: '/log/' },
      { text: 'Day04 · 运行时就位', link: '/log/day-04' },
      { text: 'Day03 · 阶段一 MVP 跑通', link: '/log/day-03' },
      { text: 'Day02 · 文档站结构精简', link: '/log/day-02' },
      { text: 'Day01 · 双语文档站上线', link: '/log/day-01' }
    ]
  }
]

const enLogSidebar = [
  {
    text: 'Development log',
    items: [
      { text: 'Log index', link: '/en/log/' },
      { text: 'Day04 · The runtime takes shape', link: '/en/log/day-04' },
      { text: 'Day03 · Stage-one MVP runs end to end', link: '/en/log/day-03' },
      { text: 'Day02 · Documentation structure cleanup', link: '/en/log/day-02' },
      { text: 'Day01 · Bilingual documentation launch', link: '/en/log/day-01' }
    ]
  }
]

const zhReferenceSidebar = [
  {
    text: '参考',
    items: [
      { text: '参考总览', link: '/reference/' },
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

const enReferenceSidebar = [
  {
    text: 'Reference',
    items: [
      { text: 'Reference overview', link: '/en/reference/' },
      { text: 'Engineering', link: '/en/reference/engineering' },
      { text: 'Risks and stop conditions', link: '/en/reference/risks' },
      { text: 'Key decisions', link: '/en/reference/decisions' },
      { text: 'Build vs. integrate', link: '/en/reference/build-vs-integrate' },
      { text: 'Glossary', link: '/en/reference/glossary' },
      { text: 'Default checklists', link: '/en/reference/checklists' },
      { text: 'FAQ', link: '/en/reference/faq' },
      { text: 'Contributing', link: '/en/reference/contributing' },
      { text: 'Documentation map', link: '/en/reference/source-map' }
    ]
  }
]

const zhSearchTranslations = {
  button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
  modal: {
    noResultsText: '没有找到结果',
    resetButtonTitle: '清除查询',
    footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
  }
}

const enSearchTranslations = {
  button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
  modal: {
    noResultsText: 'No results found',
    resetButtonTitle: 'Reset search',
    footer: { selectText: 'to select', navigateText: 'to navigate', closeText: 'to close' }
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
      'Hearth 是一个单用户、自托管、长期驻留的个人 Agent OS。用持久执行、真实工具、明确审批和可验证回执，把意图变成可靠的任务。',
    base: '/hearth-os/',
    srcExclude: ['brand/**'],
    cleanUrls: false,
    lastUpdated: true,
    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/hearth-os/logo.svg' }],
      ['meta', { name: 'theme-color', content: '#b8471d' }],
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
      ['meta', { property: 'og:image', content: 'https://hearthproject.github.io/hearth-os/brand/hearth-os-logo.png' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }]
    ],
    sitemap: { hostname: 'https://hearthproject.github.io/hearth-os/' },
    themeConfig: {
      logo: { src: '/logo.svg', width: 28, height: 28 },
      siteTitle: 'Hearth',
      nav: zhNav,
      sidebar: {
        '/guide/': zhGuideSidebar,
        '/design/': zhDesignSidebar,
        '/delivery/': zhDeliverySidebar,
        '/log/': zhLogSidebar,
        '/reference/': zhReferenceSidebar
      },
      socialLinks: [{ icon: 'github', link: 'https://github.com/hearthproject/hearth-os' }],
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
          'Hearth 是一个单用户、自托管、长期驻留的个人 Agent OS。用持久执行、真实工具、明确审批和可验证回执，把意图变成可靠的任务。'
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
          sidebar: {
            '/en/guide/': enGuideSidebar,
            '/en/design/': enDesignSidebar,
            '/en/delivery/': enDeliverySidebar,
            '/en/log/': enLogSidebar,
            '/en/reference/': enReferenceSidebar
          },
          search: searchOptions(enSearchTranslations),
          outline: { level: [2, 3], label: 'On this page' },
          docFooter: { prev: 'Previous', next: 'Next' },
          lastUpdated: {
            text: 'Last updated',
            formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
          },
          editLink: {
            pattern: 'https://github.com/hearthproject/hearth-os/edit/main/docs/:path',
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
