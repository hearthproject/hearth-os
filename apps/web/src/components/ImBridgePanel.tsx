import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, MessageCircle, QrCode, RefreshCw, Save, ShieldCheck, Smartphone, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../lib/api.ts";
import type { ImChannelStatus, ImConnectionState, WechatQrStatusView, WechatQrView } from "../lib/types.ts";

function stateLabel(state: ImConnectionState): string {
  return state === "connected"
    ? "已连接"
    : state === "starting"
      ? "连接中"
      : state === "reconnecting"
        ? "重连中"
        : state === "error"
          ? "异常"
          : "未连接";
}

function StatusPill({ status }: { status: ImChannelStatus | undefined }) {
  const state = status?.state ?? "disabled";
  return (
    <span className={`im-status ${state}`}>
      <span className="im-status-dot" />
      {stateLabel(state)}
    </span>
  );
}

export function ImBridgePanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["imBridge"], queryFn: api.im, refetchInterval: 4_000 });
  const conversationsQuery = useQuery({ queryKey: ["conversations"], queryFn: api.conversations });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [qr, setQr] = useState<WechatQrView | null>(null);
  const [qrStatus, setQrStatus] = useState<WechatQrStatusView | null>(null);
  const [wechatConversationId, setWechatConversationId] = useState("");
  const [qqConversationId, setQqConversationId] = useState("");
  const [qqAppId, setQqAppId] = useState("");
  const [qqSecret, setQqSecret] = useState("");
  const [qqSandbox, setQqSandbox] = useState(false);
  const [wechatToken, setWechatToken] = useState("");
  const [wechatBaseUrl, setWechatBaseUrl] = useState("");

  useEffect(() => {
    const settings = query.data?.settings;
    if (!settings) return;
    setWechatConversationId(settings.wechat.conversationId ?? "");
    setWechatBaseUrl(settings.wechat.baseUrl ?? "");
    setQqConversationId(settings.qq.conversationId ?? "");
    setQqAppId(settings.qq.appId ?? "");
    setQqSandbox(settings.qq.sandbox);
  }, [query.data?.settings.wechat.conversationId, query.data?.settings.wechat.baseUrl, query.data?.settings.qq.conversationId, query.data?.settings.qq.appId, query.data?.settings.qq.sandbox]);

  useEffect(() => {
    if (!qr) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      try {
        const result = await api.pollWechatQr(qr.qrcode);
        if (cancelled) return;
        setQrStatus(result);
        if (result.status === "confirmed") {
          setQr(null);
          setNotice({ tone: "ok", text: result.message ?? "微信已连接，所有消息会进入同一个对话窗口。" });
          await queryClient.invalidateQueries({ queryKey: ["imBridge"] });
          return;
        }
        if (result.status === "expired" || result.status === "error") {
          return;
        }
        timer = setTimeout(() => void tick(), 1_500);
      } catch (error) {
        if (cancelled) return;
        setQrStatus({ status: "error", accountId: null, message: error instanceof Error ? error.message : "扫码状态查询失败" });
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [qr?.qrcode, queryClient]);

  const conversations = conversationsQuery.data?.conversations ?? [];
  const wechat = query.data?.settings.wechat;
  const qq = query.data?.settings.qq;
  const wechatStatus = query.data?.status.wechat;
  const qqStatus = query.data?.status.qq;
  const wechatAutoConversation = useMemo(
    () => !wechatConversationId && wechat?.conversationTitle ? `已自动创建「${wechat.conversationTitle}」` : null,
    [wechatConversationId, wechat?.conversationTitle]
  );

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["imBridge"] });
  }

  async function startWechatQr(): Promise<void> {
    setBusy("wechat-qr");
    setNotice(null);
    setQrStatus(null);
    try {
      const result = await api.startWechatQr();
      setQr(result);
      setNotice({ tone: "info", text: "用微信扫描二维码，确认后所有消息会进入同一个 Hearth 对话。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "获取二维码失败" });
    } finally {
      setBusy(null);
    }
  }

  async function saveWechat(enabled?: boolean): Promise<void> {
    setBusy("wechat-save");
    setNotice(null);
    try {
      await api.saveImWechat({
        ...(enabled !== undefined ? { enabled } : {}),
        ...(wechatToken.trim() ? { token: wechatToken.trim() } : {}),
        ...(wechatBaseUrl.trim() ? { baseUrl: wechatBaseUrl.trim() } : {}),
        conversationId: wechatConversationId || null
      });
      setWechatToken("");
      setNotice({ tone: "ok", text: enabled === false ? "微信连接已停用。" : "微信连接配置已保存。" });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function reconnectWechat(): Promise<void> {
    setBusy("wechat-reconnect");
    setNotice(null);
    try {
      await api.reconnectWechat();
      setNotice({ tone: "ok", text: "已重新连接微信。" });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "重连失败" });
    } finally {
      setBusy(null);
    }
  }

  async function saveQq(enabled?: boolean): Promise<void> {
    setBusy("qq-save");
    setNotice(null);
    try {
      await api.saveImQq({
        ...(enabled !== undefined ? { enabled } : {}),
        ...(qqAppId.trim() ? { appId: qqAppId.trim() } : {}),
        ...(qqSecret.trim() ? { clientSecret: qqSecret.trim() } : {}),
        sandbox: qqSandbox,
        conversationId: qqConversationId || null
      });
      setQqSecret("");
      setNotice({ tone: "ok", text: enabled === false ? "QQ 连接已停用。" : "QQ 机器人配置已保存。" });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function reconnectQq(): Promise<void> {
    setBusy("qq-reconnect");
    setNotice(null);
    try {
      await api.reconnectQq();
      setNotice({ tone: "ok", text: "已重新连接 QQ。" });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "重连失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="im-bridge">
      <div className="im-bridge-intro">
        <div>
          <h3>IM 直连</h3>
          <p>微信扫码即可接入，QQ 使用官方机器人；所有消息统一进入一个 Hearth 对话窗口。</p>
        </div>
        {query.isFetching && <Loader2 size={14} className="spin" />}
      </div>

      {notice && (
        <div className={`settings-notice ${notice.tone}`}>
          {notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <X size={15} /> : <MessageCircle size={15} />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="panel settings-section im-channel-card">
        <div className="settings-body">
          <div className="im-channel-head">
            <div className="im-channel-title">
              <span className="im-channel-icon wechat"><Smartphone size={17} /></span>
              <div>
                <h3>微信</h3>
                <p>扫码登录后自动接收消息；只保留一个对话窗口，不按联系人分身。</p>
              </div>
            </div>
            <div className="im-channel-actions">
              <StatusPill status={wechatStatus} />
              {wechat?.enabled
                ? <button className="ghost-button compact" onClick={() => void saveWechat(false)} disabled={busy !== null}>停用</button>
                : <button className="primary-button compact" onClick={() => void saveWechat(true)} disabled={busy !== null || !wechat?.hasToken}>启用</button>}
            </div>
          </div>

          <div className="im-config-row">
            <label>
              <span>消息进入的对话</span>
              <select value={wechatConversationId} onChange={(event) => setWechatConversationId(event.target.value)}>
                <option value="">自动创建「IM 对话」（微信与 QQ 共用一个窗口）</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
                ))}
              </select>
              {wechatAutoConversation && <small className="field-hint">{wechatAutoConversation}</small>}
            </label>
            <div className="im-connect-actions">
              <button className="primary-button" onClick={() => void startWechatQr()} disabled={busy !== null}>
                {busy === "wechat-qr" ? <Loader2 size={15} className="spin" /> : <QrCode size={15} />} 扫码登录
              </button>
              <button className="ghost-button" onClick={() => void saveWechat()} disabled={busy !== null}>
                {busy === "wechat-save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存设置
              </button>
              <button className="ghost-button" onClick={() => void reconnectWechat()} disabled={busy !== null || !wechat?.enabled}>
                {busy === "wechat-reconnect" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 重连
              </button>
            </div>
          </div>

          {qr && (
            <div className="im-qr-panel">
              <div className="im-qr-code">
                {isImageValue(qr.image)
                  ? <img src={qr.image} alt="微信登录二维码" />
                  : <QRCodeSVG value={qr.image} size={156} level="M" />}
              </div>
              <div>
                <strong>用微信扫一扫</strong>
                <p>{qrStatus?.message ?? "等待扫码…"}</p>
                <small>二维码有效期至 {new Date(qr.expiresAt).toLocaleTimeString("zh-CN")}</small>
                <button className="ghost-button compact" onClick={() => { setQr(null); setQrStatus(null); }}>取消</button>
              </div>
            </div>
          )}

          <details className="im-advanced">
            <summary>手动配置 Bot Token</summary>
            <div className="form-grid">
              <label className="span-2"><span>Bot Token</span><input type="password" value={wechatToken} onChange={(event) => setWechatToken(event.target.value)} placeholder={wechat?.hasToken ? "已保存，留空保留" : "扫码后会自动保存"} autoComplete="off" /></label>
              <label className="span-2"><span>接口地址</span><input value={wechatBaseUrl} onChange={(event) => setWechatBaseUrl(event.target.value)} placeholder="https://ilinkai.weixin.qq.com" spellCheck={false} /></label>
            </div>
          </details>

          <ImMetrics status={wechatStatus} />
          {wechatStatus?.lastError && <p className="form-error">最近错误：{wechatStatus.lastError}</p>}
          <p className="settings-hint"><ShieldCheck size={13} /> Token 使用本机密钥加密保存；所有微信消息进入同一个 Hearth 对话，回复发给最后一位发消息的联系人。</p>
        </div>
      </section>

      <section className="panel settings-section im-channel-card">
        <div className="settings-body">
          <div className="im-channel-head">
            <div className="im-channel-title">
              <span className="im-channel-icon qq"><MessageCircle size={17} /></span>
              <div>
                <h3>QQ</h3>
                <p>使用 QQ 官方机器人 App ID / Secret 直连，不需要公网回调地址。</p>
              </div>
            </div>
            <div className="im-channel-actions">
              <StatusPill status={qqStatus} />
              {qq?.enabled
                ? <button className="ghost-button compact" onClick={() => void saveQq(false)} disabled={busy !== null}>停用</button>
                : <button className="primary-button compact" onClick={() => void saveQq(true)} disabled={busy !== null || !qqAppId.trim() || !qq?.hasClientSecret && !qqSecret.trim()}>启用</button>}
            </div>
          </div>

          <div className="form-grid">
            <label><span>App ID</span><input value={qqAppId} onChange={(event) => setQqAppId(event.target.value)} placeholder="QQ 机器人 AppID" spellCheck={false} /></label>
            <label><span>App Secret</span><input type="password" value={qqSecret} onChange={(event) => setQqSecret(event.target.value)} placeholder={qq?.hasClientSecret ? "已保存，留空保留" : "QQ 机器人 AppSecret"} autoComplete="off" /></label>
            <label><span>消息进入的对话</span><select value={qqConversationId} onChange={(event) => setQqConversationId(event.target.value)}>
              <option value="">自动创建「IM 对话」（微信与 QQ 共用一个窗口）</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
              ))}
            </select></label>
            <label className="im-checkbox"><input type="checkbox" checked={qqSandbox} onChange={(event) => setQqSandbox(event.target.checked)} /><span>使用沙箱环境</span></label>
          </div>

          <div className="settings-actions">
            <button className="primary-button" onClick={() => void saveQq()} disabled={busy !== null}>
              {busy === "qq-save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存并连接
            </button>
            <button className="ghost-button" onClick={() => void reconnectQq()} disabled={busy !== null || !qq?.enabled}>
              {busy === "qq-reconnect" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 重连
            </button>
          </div>

          <ImMetrics status={qqStatus} />
          {qqStatus?.lastError && <p className="form-error">最近错误：{qqStatus.lastError}</p>}
          <details className="im-advanced">
            <summary>QQ 机器人怎么创建</summary>
            <ol>
              <li>在 QQ 开放平台创建一个机器人，记录 App ID 与 App Secret。</li>
              <li>开启私聊与群聊消息能力；开发阶段可先在沙箱环境扫码添加自己。</li>
              <li>保存上面的凭据后 Hearth 会直接建立长连接，不需要配置公网回调。</li>
            </ol>
          </details>
        </div>
      </section>
    </div>
  );
}

function ImMetrics({ status }: { status: ImChannelStatus | undefined }) {
  if (!status) return null;
  return (
    <dl className="feishu-metrics im-metrics">
      <div><dt>收到消息</dt><dd>{status.inboundCount}</dd></div>
      <div><dt>已发送</dt><dd>{status.outboundSent}</dd></div>
      <div><dt>发送失败</dt><dd>{status.outboundFailed}</dd></div>
      <div><dt>重连次数</dt><dd>{status.reconnectAttempts}</dd></div>
      <div><dt>连接时间</dt><dd>{status.connectedAt ? new Date(status.connectedAt).toLocaleString("zh-CN") : "未连接"}</dd></div>
      <div><dt>账号</dt><dd>{status.accountLabel ?? "—"}</dd></div>
    </dl>
  );
}

function isImageValue(value: string): boolean {
  // iLink 返回的 image 是二维码落地页地址，不是图片文件；只有 data URI 或带图片后缀的地址才直接当图片加载。
  return value.startsWith("data:image/") || /\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(value);
}
