import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, PlugZap, RefreshCw, Save, X } from "lucide-react";
import { api } from "../lib/api.ts";
import type { FeishuConnectionState, FeishuDomain, FeishuIntegrationResponse } from "../lib/types.ts";

const STATE_LABELS: Record<FeishuConnectionState, string> = {
  disabled: "未启用",
  starting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  error: "连接异常"
};

export function FeishuSettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["feishu"], queryFn: api.feishu, refetchInterval: 15_000 });
  const [enabled, setEnabled] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowedText, setAllowedText] = useState("");
  const [domain, setDomain] = useState<FeishuDomain>("feishu");
  const [busy, setBusy] = useState<"save" | "test" | "reconnect" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized || !query.data) return;
    applySnapshot(query.data);
    setInitialized(true);
  }, [initialized, query.data]);

  function applySnapshot(snapshot: FeishuIntegrationResponse) {
    setEnabled(snapshot.settings.enabled);
    setAppId(snapshot.settings.appId);
    setAllowedText(snapshot.settings.allowedOpenIds.join("\n"));
    setDomain(snapshot.settings.domain);
    setAppSecret("");
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["feishu"] });
  }

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      const result = await api.saveFeishu({
        enabled,
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        allowedOpenIds: allowedText.split(/[\n,，]/).map((value) => value.trim()).filter(Boolean),
        domain
      });
      applySnapshot(result);
      await refresh();
      setNotice({
        tone: result.status.state === "error" ? "error" : "ok",
        text: result.status.state === "error"
          ? `设置已保存，但长连接失败：${result.status.lastError ?? "未知错误"}`
          : result.settings.enabled ? "飞书设置已保存，长连接正在建立。" : "飞书入口已关闭。"
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存飞书设置失败" });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testFeishu({
        ...(appId.trim() ? { appId: appId.trim() } : {}),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        domain
      });
      setNotice(result.ok
        ? { tone: "ok", text: `凭据验证成功${result.elapsedMs ? `，${result.elapsedMs} ms` : ""}。` }
        : { tone: "error", text: result.error ?? "凭据验证失败" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试连接失败" });
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setBusy("reconnect");
    setNotice(null);
    try {
      const result = await api.reconnectFeishu();
      applySnapshot(result);
      await refresh();
      setNotice({ tone: result.status.state === "error" ? "error" : "ok", text: result.status.state === "error" ? result.status.lastError ?? "重连失败" : "已重新发起连接。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "重连失败" });
    } finally {
      setBusy(null);
    }
  }

  const status = query.data?.status;
  const state = status?.state ?? "disabled";

  return (
    <section className="panel settings-section">
      <div className="settings-body">
        <div className="section-heading">
          <div>
            <h3>飞书消息入口</h3>
            <p>通过企业自建应用的长连接，在手机上给 Hearth 发消息、接收任务进度和确认外部动作。不需要公网回调地址。</p>
          </div>
          <span className={`status-chip ${state === "connected" ? "ok" : state === "error" ? "warn" : ""}`}>
            <span className={`status-dot ${state === "connected" ? "online" : state === "disabled" ? "idle" : "offline"}`} />
            {STATE_LABELS[state]}
          </span>
        </div>

        {query.isLoading && <p className="inline-loading"><Loader2 size={15} className="spin" /> 正在读取飞书设置</p>}
        {query.isError && <p className="form-error">{query.error.message}</p>}

        <div className="form-grid">
          <label className="checkbox-field span-2">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>启用飞书入口（保存后建立长连接）</span>
          </label>
          <label>
            <span>App ID</span>
            <input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_..." spellCheck={false} />
          </label>
          <label>
            <span>App Secret</span>
            <input
              type="password"
              value={appSecret}
              onChange={(event) => setAppSecret(event.target.value)}
              placeholder={query.data?.settings.hasAppSecret ? "已保存，留空保留" : "填写 App Secret"}
              autoComplete="off"
            />
          </label>
          <label>
            <span>飞书域名</span>
            <select value={domain} onChange={(event) => setDomain(event.target.value as FeishuDomain)}>
              <option value="feishu">飞书（open.feishu.cn）</option>
              <option value="lark">Lark（open.larksuite.com）</option>
            </select>
          </label>
          <label className="span-2">
            <span>允许的用户 open_id（每行一个）</span>
            <textarea
              value={allowedText}
              onChange={(event) => setAllowedText(event.target.value)}
              placeholder="ou_xxxxxxxxxxxxxxxx"
              rows={3}
              spellCheck={false}
            />
          </label>
        </div>

        <div className="settings-actions">
          <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存并连接
          </button>
          <button className="ghost-button" onClick={() => void test()} disabled={busy !== null}>
            {busy === "test" ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />} 测试凭据
          </button>
          <button className="ghost-button" onClick={() => void reconnect()} disabled={busy !== null || !query.data?.settings.enabled}>
            {busy === "reconnect" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 重新连接
          </button>
        </div>

        {notice && (
          <div className={`settings-notice ${notice.tone}`}>
            {notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <X size={15} /> : <Link2 size={15} />}
            <span>{notice.text}</span>
          </div>
        )}
        {status?.lastError && <p className="form-error">最近错误：{status.lastError}</p>}
        {status?.lastEventAt && <p className="settings-hint">最近收到事件：{new Date(status.lastEventAt).toLocaleString("zh-CN")}</p>}

        <div className="feishu-checklist">
          <h4>在飞书开放平台完成这些步骤</h4>
          <ol>
            <li>创建“企业自建应用”，在应用能力里开启机器人。</li>
            <li>在“事件与回调 → 事件配置”选择“使用长连接接收事件”，添加 <code>im.message.receive_v1</code>。</li>
            <li>在权限管理里开通接收消息、以应用身份发消息、读取群信息等最小权限。</li>
            <li>发布应用版本；把允许使用机器人的用户 open_id 填到上面的白名单。</li>
            <li>审批使用文本命令 <code>/approve 前缀</code>、<code>/reject 前缀</code>。飞书卡片按钮回调不支持长连接，首版不做卡片按钮。</li>
          </ol>
          <p>open_id 可以在飞书开放平台的事件日志或调试工具中看到；白名单为空时不会处理任何消息。</p>
        </div>
      </div>
    </section>
  );
}