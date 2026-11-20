import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import type { MemorySnapshot } from "../lib/types.ts";

type MemorySettings = MemorySnapshot["settings"];

export function MemorySettingsForm({ settings }: { settings: MemorySettings }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (input: Partial<MemorySettings>) => api.updateMemorySettings(input),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "记忆设置已保存。" });
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      autoCapture: String(form.get("autoCapture")) as MemorySettings["autoCapture"],
      maxItems: Number(form.get("maxItems")),
      maxChars: Number(form.get("maxChars")),
      allowSensitive: form.get("allowSensitive") === "on"
    });
  }

  return (
    <form className="memory-settings-form" onSubmit={submit}>
      <div className="proactive-number-grid">
        <label>自动记录<select name="autoCapture" defaultValue={settings.autoCapture}><option value="experience">记录做过的事</option><option value="off">关闭</option></select></label>
        <label>最多参考几条<input name="maxItems" type="number" min="1" max="50" defaultValue={settings.maxItems} /></label>
        <label>最多参考多少字<input name="maxChars" type="number" min="200" max="100000" defaultValue={settings.maxChars} /></label>
      </div>
      <div className="proactive-form-foot">
        <label className="memory-check"><input name="allowSensitive" type="checkbox" defaultChecked={settings.allowSensitive} /> 允许参考敏感内容（机密始终排除）</label>
        <button className="button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
        </button>
      </div>
      {notice && (
        <p className={notice.tone === "error" ? "form-error" : "form-hint"}>
          {notice.tone === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {notice.text}
        </p>
      )}
      <p className="form-hint">这些设置只影响自动记录和参考范围，不会删除已经保存的内容。</p>
    </form>
  );
}
