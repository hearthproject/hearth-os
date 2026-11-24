import { FeishuSettingsPanel } from "../components/FeishuSettingsPanel.tsx";
import { ImBridgePanel } from "../components/ImBridgePanel.tsx";

export function ConnectionsPage() {
  return (
    <div className="page connections-page">
      <header className="settings-head">
        <h1>连接</h1>
      </header>

      <div className="settings-content connections-content">
        <ImBridgePanel />
        <FeishuSettingsPanel />
      </div>
    </div>
  );
}
