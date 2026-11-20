import { FeishuSettingsPanel } from "../components/FeishuSettingsPanel.tsx";

export function ConnectionsPage() {
  return (
    <div className="page connections-page">
      <header className="settings-head">
        <h1>连接</h1>
      </header>

      <div className="settings-content connections-content">
        <FeishuSettingsPanel />
      </div>
    </div>
  );
}
