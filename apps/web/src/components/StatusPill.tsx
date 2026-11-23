import { Check, CircleDashed, CircleSlash, TriangleAlert } from "lucide-react";
import type { EffectRecord } from "../lib/types.ts";
import { EFFECT_STATUS_LABELS } from "../lib/labels.ts";

type Tone = "neutral" | "active" | "risk" | "done";

const EFFECT_TONE: Record<EffectRecord["status"], Tone> = {
  pending: "neutral",
  prepared: "neutral",
  admitted: "active",
  executing: "active",
  committed: "done",
  succeeded: "done",
  failed: "risk",
  uncertain: "risk",
  reconciled_committed: "done",
  reconciled_absent: "neutral",
  abandoned: "neutral"
};

export function EffectStatusTag({ status }: { status: EffectRecord["status"] }) {
  const icon = status === "uncertain" ? TriangleAlert : status === "succeeded" ? Check : status === "failed" ? CircleSlash : CircleDashed;
  const Icon = icon;
  return (
    <span className={`status-pill tone-${EFFECT_TONE[status]}`}>
      <Icon size={13} />
      {status === "uncertain" && <Icon size={13} className="glyph-offset" />}
      {EFFECT_STATUS_LABELS[status]}
    </span>
  );
}
