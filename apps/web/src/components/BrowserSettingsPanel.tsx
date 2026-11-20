import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, MonitorPlay, Save, ShieldAlert } from "lucide-react";
import { api } from "../lib/api.ts";
import type { BrowserSettingsView } from "../lib/types.ts";

export function BrowserSettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["browser-settings"], queryFn: () => api.browserSettings(), retry: false });
  const [draft, setDraft] = useState<BrowserSettingsView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (settings: BrowserSettingsView) => api.updateBrowserSettings(settings),
    onSuccess: (data) => {
      setDraft(data.settings);
      setNotice("浏览器设置已保存。新任务立即生效。");
      void queryClient.invalidateQueries({ queryKey: ["browser-settings"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "保存失败")
  });

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data.settings);
  }, [query.data, draft]);

  if (query.isLoading || !draft) {
    return <section className="panel settings-section"><Loader2 className="spin" size={16} /> 正在读取浏览器设置</section>;
  }

  const update = (patch: Partial<BrowserSettingsView>) => setDraft({ ...draft, ...patch });

  return (
    <section className="settings-tab-panel">
      <section className="panel settings-section">
        <div className="panel-head">
          <div className="section-heading">
            <h2><MonitorPlay size={17} /> 浏览器自动化</h2>
            <p>Agent 使用独立的 Chrome 配置，不读取你日常浏览器的 Cookie。页面变化会留下截图证据。</p>
          </div>
          <button className="primary-button" disabled={save.isPending} onClick={() => draft && save.mutate(draft)}>
            {save.isPending ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存
          </button>
        </div>

        <label className="field checkbox-field">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          <span>启用浏览器工具</span>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>允许的域名</span>
            <textarea
              rows={4}
              value={draft.allowedDomains.join("\n")}
              onChange={(event) => update({ allowedDomains: lines(event.target.value) })}
              placeholder={"example.com\n*.trusted.dev"}
            />
            <small>留空表示每个新域名都需要在审批卡片里确认。支持子域，例如 *.example.com。</small>
          </label>
          <label className="field">
            <span>只读域名</span>
            <textarea
              rows={4}
              value={draft.readOnlyDomains.join("\n")}
              onChange={(event) => update({ readOnlyDomains: lines(event.target.value) })}
              placeholder={"docs.example.com"}
            />
            <small>这些站点只允许打开和读取，不能点击、输入、上传或提交。</small>
          </label>
        </div>

        <label className="field">
          <span><ShieldAlert size={13} /> 高风险站点</span>
          <textarea
            rows={3}
            value={draft.highRiskDomains.join("\n")}
            onChange={(event) => update({ highRiskDomains: lines(event.target.value) })}
            placeholder={"*.bank\nmail.example.com"}
          />
          <small>这些站点只允许读取；写入、提交和上传必须逐次审批，不能设置为始终允许。</small>
        </label>

        <label className="field field-narrow">
          <span>同时打开的浏览器任务</span>
          <input
            type="number"
            min={1}
            max={8}
            value={draft.maxSessions}
            onChange={(event) => update({ maxSessions: Number(event.target.value) || 4 })}
          />
          <small>默认 4。超出的任务会排队，空闲 10 分钟后自动关闭。</small>
        </label>

        {notice && (
          <p className={save.isError ? "form-error" : "settings-notice"}>
            {save.isError ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} {notice}
          </p>
        )}
      </section>

      <section className="panel settings-section">
        <div className="section-heading">
          <h3>接管与安全边界</h3>
          <p>遇到登录、验证码、支付确认时，点任务页的“接管”，直接在真实浏览器窗口操作，完成后点“继续”。</p>
        </div>
        <ul className="settings-list">
          <li>Agent 永远看不到 Cookie、密码和浏览器保存的登录凭据。</li>
          <li>密码框不能由 Agent 填写；需要登录时由你接管。</li>
          <li>提交、支付、发送、上传每次都要审批，并保存动作前后截图。</li>
          <li>每个任务只操作自己的标签页，最多 4 个任务同时打开浏览器。</li>
        </ul>
      </section>
    </section>
  );
}

function lines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}
