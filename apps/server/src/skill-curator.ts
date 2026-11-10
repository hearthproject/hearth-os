import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillCuratorAction, SkillCuratorRun, SkillRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";
import type { SkillPackageService } from "./skills.ts";

export const SKILL_CURATOR_CADENCE_MS = 7 * 24 * 60 * 60 * 1000;
export const SKILL_CURATOR_IDLE_MS = 2 * 60 * 60 * 1000;
export const SKILL_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
export const SKILL_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface SkillCuratorPlan {
  due: boolean;
  seeded: boolean;
  actions: SkillCuratorAction[];
  report: string;
}

export interface SkillCuratorOptions {
  service: HearthService;
  skills: SkillPackageService;
  clock?: () => Date;
  staleAfterMs?: number;
  archiveAfterMs?: number;
  cadenceMs?: number;
  idleMs?: number;
}

interface CuratorBackup {
  runId: string;
  createdAt: string;
  records: SkillRecord[];
}

export class SkillCuratorService {
  private readonly service: HearthService;
  private readonly skills: SkillPackageService;
  private readonly clock: () => Date;
  private readonly staleAfterMs: number;
  private readonly archiveAfterMs: number;
  private readonly cadenceMs: number;
  private readonly idleMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SkillCuratorOptions) {
    this.service = options.service;
    this.skills = options.skills;
    this.clock = options.clock ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? SKILL_STALE_AFTER_MS;
    this.archiveAfterMs = options.archiveAfterMs ?? SKILL_ARCHIVE_AFTER_MS;
    this.cadenceMs = options.cadenceMs ?? SKILL_CURATOR_CADENCE_MS;
    this.idleMs = options.idleMs ?? SKILL_CURATOR_IDLE_MS;
  }

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch {
        // Curator failures must never block the task loop or scheduler.
      }
    }, Math.max(60_000, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  plan(now = this.clock()): SkillCuratorPlan {
    const runs = this.service.store.listSkillCuratorRuns(1);
    const last = runs[0];
    if (last && now.getTime() - Date.parse(last.startedAt) < this.cadenceMs) {
      return {
        due: false,
        seeded: false,
        actions: [],
        report: `距离上次整理不足 ${Math.round(this.cadenceMs / 86_400_000)} 天`
      };
    }
    if (!last) {
      return {
        due: true,
        seeded: true,
        actions: [],
        report: "首次运行只播种：记录 Curator 基线，不立即改变技能状态"
      };
    }
    if (!this.isIdle(now)) {
      return { due: false, seeded: false, actions: [], report: "系统最近仍有活动，Curator 等待空闲窗口" };
    }
    const actions: SkillCuratorAction[] = [];
    const skills = this.service.store.listSkills()
      .filter((skill) => skill.origin === "agent")
      .filter((skill) => !skill.pinned)
      .filter((skill) => skill.status === "adopted" || skill.status === "stale")
      .filter((skill) => !this.isReferenced(skill));
    for (const skill of skills) {
      const age = now.getTime() - lastActivityAt(skill);
      if (skill.status === "adopted" && age >= this.archiveAfterMs) {
        actions.push(action(skill, "archived", "超过 30 天未使用，自动归档但保留恢复入口"));
      } else if (skill.status === "adopted" && age >= this.staleAfterMs) {
        actions.push(action(skill, "stale", "超过 14 天未使用，标记为 stale 并退出日常索引"));
      } else if (skill.status === "stale" && age >= this.archiveAfterMs) {
        actions.push(action(skill, "archived", "stale 超过 30 天，自动归档但保留恢复入口"));
      }
    }
    return {
      due: true,
      seeded: false,
      actions,
      report: actions.length
        ? actions.map((item) => `${item.name}：${item.from} -> ${item.to}（${item.reason}）`).join("；")
        : "没有需要整理且未被引用的技能"
    };
  }

  run(input: { dryRun?: boolean; now?: Date } = {}): SkillCuratorRun {
    const now = input.now ?? this.clock();
    const dryRun = input.dryRun === true;
    const plan = this.plan(now);
    const runId = `SCUR-${randomUUID()}`;
    const startedAt = now.toISOString();
    if (!plan.due) {
      const run: SkillCuratorRun = {
        id: runId,
        status: dryRun ? "planned" : "applied",
        dryRun,
        startedAt,
        endedAt: startedAt,
        actions: [],
        backupPath: null,
        report: plan.report,
        rolledBackAt: null
      };
      return this.persist(run);
    }
    const preimages = plan.actions
      .map((item) => this.service.store.getSkill(item.skillId))
      .filter((skill): skill is SkillRecord => Boolean(skill));
    const backupPath = dryRun || plan.actions.length === 0 ? null : this.writeBackup(runId, startedAt, preimages);
    const applied: SkillCuratorAction[] = [];
    try {
      for (const item of plan.actions) {
        if (dryRun) {
          applied.push(item);
          continue;
        }
        const updated = this.skills.transition(item.skillId, item.to, "Curator：" + item.reason);
        applied.push({ ...item, from: item.from, to: updated.status });
      }
      const run: SkillCuratorRun = {
        id: runId,
        status: dryRun ? "planned" : "applied",
        dryRun,
        startedAt,
        endedAt: this.clock().toISOString(),
        actions: applied,
        backupPath,
        report: plan.report,
        rolledBackAt: null
      };
      return this.persist(run);
    } catch (error) {
      const run: SkillCuratorRun = {
        id: runId,
        status: "failed",
        dryRun,
        startedAt,
        endedAt: this.clock().toISOString(),
        actions: applied,
        backupPath,
        report: `${plan.report}；失败：${error instanceof Error ? error.message : String(error)}`,
        rolledBackAt: null
      };
      return this.persist(run);
    }
  }

  rollback(runId: string): SkillCuratorRun {
    const run = this.service.store.getSkillCuratorRun(runId);
    if (!run) throw new Error("Curator 运行记录不存在");
    if (run.dryRun || run.status !== "applied") throw new Error("只有已应用的 Curator 运行可以回滚");
    if (!run.backupPath || !existsSync(run.backupPath)) throw new Error("Curator 备份不存在，拒绝回滚");
    const backup = JSON.parse(readFileSync(run.backupPath, "utf8")) as CuratorBackup;
    for (const snapshot of backup.records) {
      this.skills.applySnapshot(snapshot, `Curator 回滚 ${runId}：恢复 ${snapshot.status}`);
    }
    const rolledBack: SkillCuratorRun = {
      ...run,
      status: "rolled_back",
      rolledBackAt: this.clock().toISOString(),
      report: run.report + "；已回滚到运行前状态"
    };
    return this.persist(rolledBack);
  }

  snapshot(): { runs: SkillCuratorRun[]; nextRunAt: string | null } {
    const runs = this.service.store.listSkillCuratorRuns();
    const last = runs[0];
    return {
      runs,
      nextRunAt: last ? new Date(Date.parse(last.startedAt) + this.cadenceMs).toISOString() : null
    };
  }

  private persist(run: SkillCuratorRun): SkillCuratorRun {
    const event = this.service.store.appendEvent({ type: "skill.curator.updated", payload: run });
    this.service.bus.publish(event);
    return run;
  }

  private writeBackup(runId: string, createdAt: string, records: SkillRecord[]): string {
    const root = resolve(this.skills.root, ".curator");
    mkdirSync(root, { recursive: true });
    const path = join(root, runId + ".json");
    const backup: CuratorBackup = { runId, createdAt, records };
    writeFileSync(path, JSON.stringify(backup, null, 2) + "\n", "utf8");
    return path;
  }

  private isIdle(now: Date): boolean {
    const latest = this.service.store.latestEventCreatedAt();
    return !latest || now.getTime() - Date.parse(latest) >= this.idleMs;
  }

  private isReferenced(skill: SkillRecord): boolean {
    const needles = [skill.id.toLowerCase(), skill.name.toLowerCase(), `skill:${skill.id}`.toLowerCase()];
    return this.service.store.listSchedules().some((schedule) => {
      if (!schedule.enabled) return false;
      const prompt = schedule.prompt.toLowerCase();
      return needles.some((needle) => prompt.includes(needle));
    });
  }
}

function action(skill: SkillRecord, to: SkillCuratorAction["to"], reason: string): SkillCuratorAction {
  return { skillId: skill.id, name: skill.name, from: skill.status, to, reason };
}

function lastActivityAt(skill: SkillRecord): number {
  const values = [skill.lastUsedAt, skill.adoptedAt, skill.createdAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return Math.max(0, ...values);
}
