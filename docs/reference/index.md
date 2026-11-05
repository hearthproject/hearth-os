---
title: '附录'
description: 'Hearth 附录：工程实施、风险与决策、自研边界、术语、清单、FAQ、贡献和文档地图。'
outline: [2, 3]
---

<p class="eyebrow">APPENDIX</p>

# 附录

<p class="lead">主文档回答“做什么、为什么这样设计、按什么顺序交付”；附录保存实现与维护时需要反复查阅的工程边界、风险、决策、术语和清单。</p>

## 工程与决策

<DocCardGrid :columns="3" :items="[
  { no: '01', title: '工程实施与仓库结构', text: '技术栈、仓库布局、进程模型、测试、发布和迁移。', link: '/reference/engineering' },
  { no: '02', title: '风险与 Kill Criteria', text: '全局暂停条件、阶段 Kill Criteria 和不能裁掉的地基。', link: '/reference/risks' },
  { no: '03', title: 'ADR 与关键决策', text: '不可轻易反转的架构、权限、交付和产品判断。', link: '/reference/decisions' }
]" />

## 参考资料

<DocCardGrid :columns="2" :items="[
  { no: '04', title: '自研与集成边界', text: '哪些能力必须自研，哪些底层能力应该直接集成。', link: '/reference/build-vs-integrate' },
  { no: '05', title: '术语表', text: '统一 Task、Run、Mandate、Receipt、Memory、Skill 等术语。', link: '/reference/glossary' },
  { no: '06', title: '默认清单', text: '默认审批、默认完成和任务覆盖的最终定义。', link: '/reference/checklists' },
  { no: '07', title: '常见问题', text: '解释 Hearth 与 Coding Agent、Codex、第一阶段、多用户和进化的关系。', link: '/reference/faq' },
  { no: '08', title: '参与贡献与文档维护', text: '本地开发、写作约定、PR 检查和事实源规则。', link: '/reference/contributing' },
  { no: '09', title: '文档地图', text: '当前信息架构、目录结构、双语规则和更新流程。', link: '/reference/source-map' }
]" />

## 使用方式

- 产品范围和设计取舍，从[项目设计与取舍](/design/)开始；
- 当前阶段和小阶段顺序，从[交付路线](/delivery/)开始；
- 工程实现、风险和不可逆决策，以本附录为准；
- 讨论术语或清单时，优先使用附录中的统一定义。
