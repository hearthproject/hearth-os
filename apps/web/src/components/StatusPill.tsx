import {
  Check,
  CircleDashed,
  CircleSlash,
  Diamond,
  Loader,
  Plug,
  RotateCcw,
  SquareDashed,
  TriangleAlert
} from "lucide-react";
import type { EffectRecord, RunRecord, SourceConnection, SourceItem, TaskStatus } from "../lib/types.ts";
import {
  EFFECT_STATUS_LABELS,
  RUN_STATUS_LABELS,
  SOURCE_ITEM_STATUS_LABELS,
  SOURCE_STATUS_LABELS,
  TASK_STATUS_LABELS
} from "../lib/labels.ts";

type Tone = "neutral" | "active" | "risk" | "done";

const TASK_SHAPE = {
  queued: CircleDashed,
  running: Loader,
  waiting_input: SquareDashed,
  waiting_approval: Diamond,
  completed: Check,
  failed: TriangleAlert,
  recoverable: RotateCcw,
  cancelled: CircleSlash
} satisfies Record<TaskStatus, typeof Check>;

const TASK_TONE: Record<TaskStatus, Tone> = {
  queued: "neutral",
  running: "active",
  waiting_input: "active",
  waiting_approval: "active",
  completed: "done",
  failed: "risk",
  recoverable: "risk",
  cancelled: "neutral"
};

const EFFECT_TONE: Record<EffectRecord["status"], Tone> = {
  pending: "neutral",
  executing: "active",
  succeeded: "done",
  failed: "risk",
  uncertain: "risk"
};

const RUN_TONE: Record<RunRecord["status"], Tone> = {
  queued: "neutral",
  running: "active",
  waiting_input: "active",
  waiting_approval: "active",
  completed: "done",
  failed: "risk",
  cancelled: "neutral"
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return <StateLabel tone={TASK_TONE[status]} icon={TASK_SHAPE[status]} spin={status === "running"} label={TASK_STATUS_LABELS[status]} />;
}

export function RunStatusTag({ status }: { status: RunRecord["status"] }) {
  return <StateLabel tone={RUN_TONE[status]} icon={TASK_SHAPE[status]} label={RUN_STATUS_LABELS[status]} />;
}

export function EffectStatusTag({ status }: { status: EffectRecord["status"] }) {
  const icon = status === "uncertain" ? TriangleAlert : status === "succeeded" ? Check : status === "failed" ? CircleSlash : CircleDashed;
  return <StateLabel tone={EFFECT_TONE[status]} icon={icon} double={status === "uncertain"} label={EFFECT_STATUS_LABELS[status]} />;
}

export function SourceStatusTag({ status }: { status: SourceConnection["status"] }) {
  const tone: Tone = status === "connected" ? "done" : status === "reading" || status === "needs_user" ? "active" : status === "error" ? "risk" : "neutral";
  const icon = status === "reading" ? Loader : status === "needs_user" ? Diamond : status === "error" ? TriangleAlert : status === "disconnected" ? CircleSlash : Plug;
  return <StateLabel tone={tone} icon={icon} spin={status === "reading"} label={SOURCE_STATUS_LABELS[status]} />;
}

export function SourceItemStatusTag({ status }: { status: SourceItem["status"] }) {
  const tone: Tone = status === "ready" ? "done" : status === "failed" ? "risk" : "neutral";
  return <StateLabel tone={tone} icon={status === "failed" ? CircleSlash : Check} label={SOURCE_ITEM_STATUS_LABELS[status]} />;
}

function StateLabel({
  tone,
  icon: Icon,
  label,
  spin = false,
  double = false
}: {
  tone: Tone;
  icon: typeof Check;
  label: string;
  spin?: boolean;
  double?: boolean;
}) {
  return (
    <span className={`status-pill tone-${tone}`}>
      <Icon size={13} className={spin ? "spin" : undefined} />
      {double && <Icon size={13} className="glyph-offset" />}
      {label}
    </span>
  );
}
