// Pure drafting has no external side effects. File/app actions still use the task route.
export function isSimpleDraft(message: string): boolean {
  return /(请假信|请假条|道歉信|感谢信|邀请函|祝福语|短信|邮件|email|letter|message)/i.test(message)
    && /(拟|起草|草稿|写|润色|改写|措辞|draft|compose|rewrite)/i.test(message)
    && !/(保存|写入|导出|文件|附件|发送|发给|发出去|outlook|gmail|打开|联网|搜索|查找|读取|定时|提醒|https?:|save|export|send|attach|search|schedule)/i.test(message);
}

export function isDraftRevision(message: string): boolean {
  return message.length <= 300 && /(我叫|名字|姓名|署名|改成|改为|换成|简短|短一点|正式|口语|英文|中文|补充|加上|删掉|重写)/.test(message)
    && !/(发送|发给|发出去|保存|文件|附件|打开|outlook|gmail|https?:)/i.test(message);
}

export const DRAFT_INSTRUCTION = "直接给出一份可用的简短草稿，默认只写一个版本。只使用用户给出的事实；无需来源索引、风险报告、自查清单、使用说明或无关占位符。用户补充姓名、时间或语气时，仅修订上一版草稿并返回完整修订稿，不重新调查。不要声称已发送。";

export function isEvaluationMemory(content: string): boolean {
  return /评测运行约束|[\\/]eval-artifacts[\\/]|EXP-\d{8}/i.test(content);
}

export function isTextDraftTask(task: { goal: string; inputs: Array<{ kind: string }>; expectedOutputs?: string[] }): boolean {
  const goal = task.goal;
  return (task.expectedOutputs ?? ["result.md"]).length === 1
    && (task.expectedOutputs ?? ["result.md"]).every((path) => /\.(md|txt)$/i.test(path))
    && task.inputs.every((input) => input.kind === "text")
    && /(请假信|请假条|道歉信|感谢信|邀请函|祝福语|短信|邮件|email|letter)/i.test(goal)
    && /(拟|起草|草稿|写|润色|改写|draft|compose|rewrite)/i.test(goal)
    && !/(附件|发送|发给|发出去|outlook|gmail|打开|联网|搜索|查找|读取|定时|提醒|https?:|send|attach|search|schedule)/i.test(goal);
}
