import { ImBridgePanel } from "../components/ImBridgePanel.tsx";

export function ConnectionsPage() {
  return (
    <div className="page connections-page">
      <header className="settings-head">
        <h1>连接微信</h1>
      </header>

      <div className="settings-content connections-content">
        <p className="connections-lead">扫码登录微信后，消息会进入固定的「微信IM」对话。</p>
        <ImBridgePanel />
      </div>
    </div>
  );
}
