import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";

export function GmailConnect() {
  const settings = useQuery({ queryKey: ["gmailSettings"], queryFn: api.gmailSettings });
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (settings.data) { setClientId(settings.data.clientId); setRedirectUri(settings.data.redirectUri); }
  }, [settings.data]);
  async function connect() {
    setBusy(true); setError("");
    try {
      await api.saveGmailSettings({ clientId, ...(secret ? { clientSecret: secret } : {}), redirectUri });
      setSecret("");
      const result = await api.connectGmail();
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Google 连接失败"); setBusy(false); }
  }
  return <section className="panel mail-account-editor gmail-connect">
    <div className="panel-head"><h2>连接 Gmail</h2><span className="panel-meta">Google 授权 · 仅发送邮件</span></div>
    <p>无需应用专用密码。登录 Google 并授权后，即可在聊天信件卡片里发送邮件。</p>
    <details open={!settings.data?.hasClientSecret}>
      <summary>首次配置 Google OAuth 应用</summary>
      <ol>
        <li>在 <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud</a> 创建项目，启用 Gmail API。</li>
        <li>配置 Google Auth Platform 的受众；测试模式下把自己的邮箱加入测试用户。</li>
        <li>创建「Web 应用」OAuth 客户端，将下面的回调地址原样加入「已获授权的重定向 URI」。页面与回调使用同一个主机名。</li>
        <li>填写 Client ID 和 Client Secret，点击连接。测试模式的授权可能在 7 天后过期，届时重新连接。</li>
      </ol>
      <div className="mail-form">
        <label className="span-2"><span>Google Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
        <label className="span-2"><span>Google Client Secret</span><input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={settings.data?.hasClientSecret ? "已保存，留空保留" : "只保存在本机"} /></label>
        <label className="span-2"><span>Google 回调地址</span><input value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} /></label>
      </div>
    </details>
    {(error || settings.isError) && <p role="alert">{error || "无法读取 Google 配置，请刷新重试。"}</p>}
    <div className="settings-actions"><button className="primary-button" disabled={busy || !clientId || !redirectUri || (!secret && !settings.data?.hasClientSecret)} onClick={() => void connect()}>{busy ? "正在连接…" : "连接 Google 账户"}</button></div>
    <p className="settings-hint">只获取账户邮箱与发送权限，不读取收件箱。学校或工作账户可能需要管理员允许。断开本机连接后，可在 Google 账户的第三方连接中撤销授权。</p>
  </section>;
}
