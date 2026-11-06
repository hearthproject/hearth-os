import {
  Check,
  CircleDashed,
  CircleSlash,
  Diamond,
  Hand,
  Laptop,
  Loader,
  Pause,
  Plug,
  RotateCcw,
  SquareDashed,
  TriangleAlert,
  Wifi,
  WifiOff
} from "lucide-react";
import type {
  DesktopCommandStatus,
  DesktopSessionStatus,
  DeviceCapabilityStatus,
  EffectRecord,
  OutboxDraftStatus,
  RunRecord,
  SourceConnection,
  SourceItem,
  TaskStatus
} from "../lib/types.ts";
import {
  DESKTOP_COMMAND_STATUS_LABELS,
  DESKTOP_SESSION_STATUS_LABELS,
  DEVICE_CAPABILITY_STATUS_LABELS,
  EFFECT_STATUS_LABELS,
  OUTBOX_STATUS_LABELS,
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

export function OutboxStatusTag({ status }: { status: OutboxDraftStatus }) {
  const tone: Tone = status === "stored" ? "done"
    : status === "pending_approval" ? "active"
      : status === "failed" || status === "uncertain" ? "risk"
        : "neutral";
  const icon = status === "pending_approval" ? Diamond
    : status === "stored" ? Check
      : status === "failed" ? CircleSlash
        : status === "uncertain" ? TriangleAlert
          : status === "discarded" ? CircleSlash
            : SquareDashed;
  return <StateLabel tone={tone} icon={icon} double={status === "uncertain"} label={OUTBOX_STATUS_LABELS[status]} />;
}

export function DeviceOnlineTag({ online, revoked }: { online: boolean; revoked: boolean }) {
  return <StateLabel tone={revoked || !online ? "neutral" : "done"} icon={revoked ? CircleSlash : online ? Wifi : WifiOff} label={revoked ? "已撤销" : online ? "在线" : "离线"} />;
}

export function DeviceCapabilityStatusTag({ status }: { status: DeviceCapabilityStatus }) {
  const tone: Tone = status === "approved" ? "done" : status === "pending" ? "active" : "neutral";
  return <StateLabel tone={tone} icon={status === "approved" ? Check : status === "pending" ? Diamond : CircleSlash} label={DEVICE_CAPABILITY_STATUS_LABELS[status]} />;
}

export function DesktopSessionStatusTag({ status }: { status: DesktopSessionStatus }) {
  const tone: Tone = status === "active" ? "active" : status === "paused" ? "active" : status === "taken_over" ? "done" : "neutral";
  const icon = status === "active" ? Laptop : status === "paused" ? Pause : status === "taken_over" ? Hand : CircleSlash;
  return <StateLabel tone={tone} icon={icon} label={DESKTOP_SESSION_STATUS_LABELS[status]} />;
}

export function DesktopCommandStatusTag({ status }: { status: DesktopCommandStatus }) {
  const tone: Tone = status === "succeeded" ? "done" : status === "failed" ? "risk" : status === "queued" || status === "claimed" ? "active" : "neutral";
  const icon = status === "succeeded" ? Check : status === "failed" ? TriangleAlert : status === "queued" || status === "claimed" ? Loader : CircleSlash;
  return <StateLabel tone={tone} icon={icon} spin={status === "claimed"} label={DESKTOP_COMMAND_STATUS_LABELS[status]} />;
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
