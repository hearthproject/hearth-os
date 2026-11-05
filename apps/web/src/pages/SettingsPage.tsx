import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Cpu, HardDrive, KeyRound, Loader2, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { api } from "../lib/api.ts";

export function SettingsPage() {
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 20_000 });
  const health = healthQuery.data;
  const authLabel = health?.codex.authSource === "provider-env"
    ? "自定义 Provider 的环境变量"
    : health?.codex.authSource === "openai-login"
      ? "OpenAI 登录"
      : "未检测到可用认证";

  return (
    <div className="page settings-page">
      <header className="page-top compact">
        <div>
          <span className="eyebrow">设置</span>
          <h1>本机、可控、<em>不依赖云端账号。</em></h1>
          <p className="page-lead">Hearth 只监听本机地址。Codex 使用你现有的 <code>~/.codex/config.toml</code>，可以直接走自定义模型 Provider。</p>
        </div>
        <button className="ghost-button" onClick={() => void healthQuery.refetch()} disabled={healthQuery.isFetching}>
          <RefreshCw size={16} className={healthQuery.isFetching ? "spin" : ""} /> 重新检查
        </button>
      </header>

      <section className={`connection-card ${health?.codex.canRun ? "connected" : "disconnected"}`}>
        <div className="connection-icon">
          {healthQuery.isLoading ? <Loader2 className="spin" size={26} /> : health?.codex.canRun ? <CheckCircle2 size={26} /> : <WifiOff size={26} />}
        </div>
        <div>
          <span className="eyebrow">Codex 执行器</span>
          <h2>{health?.codex.canRun ? "已连接，可以开始工作" : "尚未检测到可用连接"}</h2>
          <p>{health?.codex.canRun ? "当前使用自定义 Provider 认证，不要求 OpenAI 登录。" : health?.codex.issues.join("；") || "正在读取本地配置。"}</p>
        </div>
        <span className={`connection-badge ${health?.codex.canRun ? "online" : "offline"}`}>{health?.codex.canRun ? "可用" : "不可用"}</span>
      </section>

      <div className="settings-grid">
        <section className="settings-card">
          <span className="settings-icon"><Cpu size={20} /></span>
          <h3>执行模型</h3>
          <dl>
            <div><dt>Provider</dt><dd>{health?.codex.providerName ?? "—"}</dd></div>
            <div><dt>模型</dt><dd>{health?.codex.model ?? "默认模型"}</dd></div>
            <div><dt>认证来源</dt><dd>{authLabel}</dd></div>
          </dl>
          <p className="settings-note">认证密钥只由本机服务进程读取，不会进入浏览器。</p>
        </section>

        <section className="settings-card">
          <span className="settings-icon"><KeyRound size={20} /></span>
          <h3>无需 Codex 登录</h3>
          <p>只要 <code>config.toml</code> 中配置了 <code>model_provider</code> 和对应的 <code>env_key</code>，即使 <code>codex login status</code> 显示未登录，执行器也能正常工作。</p>
          <div className={`inline-status ${health?.codex.authSource === "provider-env" ? "ok" : ""}`}>
            <span className="status-dot online" /> {authLabel}
          </div>
        </section>

        <section className="settings-card">
          <span className="settings-icon"><HardDrive size={20} /></span>
          <h3>本地数据</h3>
          <dl>
            <div><dt>服务地址</dt><dd>127.0.0.1:4317</dd></div>
            <div><dt>运行数据</dt><dd>.hearth/</dd></div>
            <div><dt>验收产物</dt><dd>eval/runs/</dd></div>
          </dl>
          <p className="settings-note">任务状态写入本地 SQLite 事件日志，刷新或重启后可重建。</p>
          <p className="settings-note">备份：停止任务后复制 <code>.hearth/hearth.sqlite</code>；任务产物位于 <code>eval/runs/</code> 和 <code>.hearth/artifacts/</code>，一并复制即可完整导出。</p>
        </section>

        <section className="settings-card">
          <span className="settings-icon"><ShieldCheck size={20} /></span>
          <h3>安全边界</h3>
          <ul className="plain-list">
            <li>Codex 在隔离任务工作区中执行</li>
            <li>默认禁用联网、网页搜索和 GitHub 凭据</li>
            <li>推送、评论、发布前必须单独审批</li>
            <li>失败不会悄悄重复外部副作用</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
