import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, MessageCircle, Send, Smartphone } from "lucide-react";
import { useState } from "react";
import { FeishuSettingsPanel } from "../components/FeishuSettingsPanel.tsx";
import { ImBridgePanel } from "../components/ImBridgePanel.tsx";
import { api } from "../lib/api.ts";

type ChannelId = "wechat" | "feishu" | "qq";

const CHANNEL_COPY: Record<ChannelId, { name: string; description: string }> = {
  wechat: { name: "微信", description: "扫码登录后收发消息" },
  feishu: { name: "飞书", description: "通过企业自建应用连接" },
  qq: { name: "QQ", description: "使用官方机器人连接" }
};

export function ConnectionsPage() {
  const [selected, setSelected] = useState<ChannelId | null>(null);
  const imQuery = useQuery({ queryKey: ["imBridge"], queryFn: api.im, refetchInterval: 8_000 });
  const feishuQuery = useQuery({ queryKey: ["feishu"], queryFn: api.feishu, refetchInterval: 15_000 });

  const states: Record<ChannelId, string | undefined> = {
    wechat: imQuery.data?.status.wechat.state,
    feishu: feishuQuery.data?.status.state,
    qq: imQuery.data?.status.qq.state
  };

  return (
    <div className="page connections-page">
      <header className="settings-head">
        <h1>连接</h1>
      </header>

      <div className="settings-content connections-content">
        {selected === null ? (
          <>
            <p className="connections-lead">选择一个平台开始配置。</p>
            <div className="connection-card-list">
              {(Object.keys(CHANNEL_COPY) as ChannelId[]).map((channel) => (
                <button
                  key={channel}
                  type="button"
                  className="connection-card"
                  data-channel={channel}
                  onClick={() => setSelected(channel)}
                >
                  <span className={`connection-card-icon ${channel}`}>
                    {channel === "wechat" ? <Smartphone size={19} /> : channel === "feishu" ? <Send size={19} /> : <MessageCircle size={19} />}
                  </span>
                  <span className="connection-card-copy">
                    <strong>{CHANNEL_COPY[channel].name}</strong>
                    <small>{CHANNEL_COPY[channel].description}</small>
                  </span>
                  <ConnectionState state={states[channel]} />
                  <ChevronRight size={16} className="connection-card-chevron" />
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="connection-detail">
            <button type="button" className="connection-back" onClick={() => setSelected(null)}>
              <ArrowLeft size={15} /> 返回连接
            </button>
            {selected === "feishu" ? <FeishuSettingsPanel /> : <ImBridgePanel channel={selected} />}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionState({ state }: { state: string | undefined }) {
  const label = state === "connected"
    ? "已连接"
    : state === "starting"
      ? "连接中"
      : state === "reconnecting"
        ? "重连中"
        : state === "error"
          ? "异常"
          : state === undefined
            ? "读取中"
            : "未连接";
  const tone = state === "connected" ? "ok" : state === "error" ? "warn" : "idle";
  return (
    <span className={`status-chip ${tone} connection-card-state`}>
      <span className={`status-dot ${state === "connected" ? "online" : state === "error" ? "offline" : "idle"}`} />
      {label}
    </span>
  );
}
