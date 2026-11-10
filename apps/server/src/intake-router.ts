import { createHash, randomUUID } from "node:crypto";
import type { IntakeDecision, IntakeDecisionRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";

export interface IntakeInput {
  sourceRef: string;
  text: string;
  sender?: string | null;
  channel?: string | null;
}

export interface IntakeResult extends IntakeDecisionRecord {
  signals: string[];
}

const IGNORE_PATTERNS = [
  /^退订/, /unsubscribe/i, /自动回复/, /auto[- ]?reply/i, /do not reply/i, /no[- ]?reply/i,
  /newsletter/i, /^\s*$/, /^\s*[\p{Emoji}\s]+\s*$/u
];
const ATTENTION_PATTERNS: Array<[RegExp, string]> = [
  [/验证码|verification code|otp\b|2fa/i, "验证码/二次验证"],
  [/截止|deadline|最后期限|今晚|明天.*(前|之前)|asap|urgent|紧急/i, "时间敏感"],
  [/冲突|不一致|矛盾|conflict|mismatch/i, "信息冲突"],
  [/密码|password|凭证|credential|api[- ]?key|私钥/i, "凭证相关"],
  [/付款|发票|合同|律师|legal|invoice|payment/i, "金钱/法律风险"],
  [/审批|approval|approve|签字|sign[- ]?off/i, "需要审批"]
];
const TASK_PATTERNS: Array<[RegExp, string]> = [
  [/帮我|请你|麻烦你/, "明确请求"],
  [/生成|撰写|写一份|整理|汇总|调研|分析|修复|部署|重构|翻译|安排|对比|测试/, "动作动词"],
  [/\b(build|create|write|fix|deploy|refactor|research|analy[sz]e|summari[sz]e|translate|schedule|test)\b/i, "动作动词"]
];
const CHAT_PATTERNS: Array<[RegExp, string]> = [
  [/^(你好|hi|hello|在吗|谢谢|thanks|收到)/i, "寒暄"],
  [/[?？]\s*$/, "提问"]
];

export class IntakeRouter {
  constructor(private readonly service: HearthService, private readonly now: () => Date = () => new Date()) {}

  route(input: IntakeInput): IntakeResult {
    const sourceRef = input.sourceRef.trim();
    if (!sourceRef) throw new Error("来源引用不能为空");
    const text = input.text.trim();
    const signals: string[] = [];
    let decision: IntakeDecision = "chat";
    let confidence = 0.55;

    const ignored = IGNORE_PATTERNS.find((pattern) => pattern.test(text));
    if (!text || ignored) {
      decision = "ignore";
      confidence = 0.95;
      signals.push(!text ? "空内容" : `忽略模式：${ignored}`);
    } else {
      const attentionSignals = ATTENTION_PATTERNS.filter(([pattern]) => pattern.test(text));
      const taskSignals = TASK_PATTERNS.filter(([pattern]) => pattern.test(text));
      const chatSignals = CHAT_PATTERNS.filter(([pattern]) => pattern.test(text));
      signals.push(...attentionSignals.map(([, label]) => label));
      signals.push(...taskSignals.map(([, label]) => label));
      signals.push(...chatSignals.map(([, label]) => label));
      if (attentionSignals.length > 0) {
        decision = "attention";
        confidence = Math.min(0.95, 0.62 + attentionSignals.length * 0.1);
      } else if (taskSignals.length > 0 && text.length >= 8) {
        decision = "task";
        confidence = Math.min(0.92, 0.58 + taskSignals.length * 0.12);
      } else if (chatSignals.length > 0 || text.length < 8) {
        decision = "chat";
        confidence = 0.6;
      } else {
        decision = "chat";
        confidence = 0.5;
      }
      if (input.sender && /vip|老板|boss|客户/i.test(input.sender)) {
        signals.push("高优先级发件人");
        confidence = Math.min(0.95, confidence + 0.05);
      }
    }

    const record: IntakeDecisionRecord = {
      id: `intake:${randomUUID()}`,
      sourceRef,
      route: decision,
      reason: signals.length > 0 ? signals.join("；") : "未命中明确信号，默认进入聊天",
      confidence: Number(confidence.toFixed(2)),
      createdAt: this.now().toISOString()
    };
    const event = this.service.store.appendEvent({ type: "intake.recorded", payload: record });
    this.service.bus.publish(event);
    return { ...record, signals };
  }

  list(limit = 100): IntakeDecisionRecord[] {
    return this.service.store.listIntakeDecisions(limit);
  }

  fingerprint(input: IntakeInput): string {
    return createHash("sha256").update(`${input.sourceRef}\n${input.text.trim()}`).digest("hex");
  }
}