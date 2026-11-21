import type { TaskRecord } from "@hearth/core";

export type TaskProfileId = "coding" | "research" | "office" | "desktop" | "general";

export interface TaskProfile {
  id: TaskProfileId;
  label: string;
  toolTimeoutMs: number;
  maxParallelTools: number;
  keepRecentToolOutputs: number;
  maxGoalRounds: number;
  /** Expose the bounded read-only workflow tool. */
  workflow: boolean;
  hints: string[];
}

export const TASK_PROFILES: Record<TaskProfileId, TaskProfile> = {
  coding: {
    id: "coding",
    label: "代码与仓库",
    toolTimeoutMs: 10 * 60_000,
    maxParallelTools: 4,
    keepRecentToolOutputs: 3,
    maxGoalRounds: 256,
    workflow: true,
    hints: []
  },
  research: {
    id: "research",
    label: "研究与资料",
    toolTimeoutMs: 5 * 60_000,
    maxParallelTools: 4,
    keepRecentToolOutputs: 3,
    maxGoalRounds: 256,
    workflow: true,
    hints: [
      "先建立来源清单，再交叉验证关键事实；引用要保留 URL、标题和发布时间。",
      "抓取失败时先用缓存、站内检索或替代来源，不要反复请求同一地址。"
    ]
  },
  office: {
    id: "office",
    label: "文档、表格与演示",
    toolTimeoutMs: 5 * 60_000,
    maxParallelTools: 2,
    keepRecentToolOutputs: 3,
    maxGoalRounds: 256,
    workflow: true,
    hints: [
      "先确认输入资料和目标格式，再生成文件；不要用纯文本假装已经生成文档。",
      "交付前重新打开产物检查标题、表格、页数和关键数字。"
    ]
  },
  desktop: {
    id: "desktop",
    label: "桌面与浏览器",
    toolTimeoutMs: 10 * 60_000,
    maxParallelTools: 2,
    keepRecentToolOutputs: 3,
    maxGoalRounds: 256,
    workflow: false,
    hints: [
      "每一步操作后先观察屏幕或页面状态，再决定下一步；不要闭着眼睛连续点击。",
      "登录、验证码和支付需要用户接管时，立即调用 ask_user 说明原因。"
    ]
  },
  general: {
    id: "general",
    label: "通用任务",
    toolTimeoutMs: 2 * 60_000,
    maxParallelTools: 1,
    keepRecentToolOutputs: 3,
    maxGoalRounds: 256,
    workflow: false,
    hints: []
  }
};

export function resolveTaskProfile(input: {
  task: TaskRecord;
  coding: boolean;
  screenshot: boolean;
  research: boolean;
}): TaskProfile {
  if (input.coding) return TASK_PROFILES.coding;
  if (input.screenshot) return TASK_PROFILES.desktop;
  if (input.research) return TASK_PROFILES.research;
  const text = `${input.task.title}\n${input.task.goal}`;
  if (/文档|表格|演示|幻灯|PPT|Excel|Word|排版|报告|docx|xlsx|pptx/i.test(text)) return TASK_PROFILES.office;
  if (/浏览器|网页|点击|截图|桌面|browser|desktop|screenshot/i.test(text)) return TASK_PROFILES.desktop;
  return TASK_PROFILES.general;
}
