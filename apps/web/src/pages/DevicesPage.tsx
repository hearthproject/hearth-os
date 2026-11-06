import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleOff,
  Eye,
  Hand,
  Keyboard,
  LockKeyhole,
  Monitor,
  MousePointerClick,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Type,
  Undo2,
  X
} from "lucide-react";
import { useState, type MouseEvent } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  DesktopCommandStatusTag,
  DesktopSessionStatusTag,
  DeviceCapabilityStatusTag,
  DeviceOnlineTag
} from "../components/StatusPill.tsx";
import { api } from "../lib/api.ts";
import { abbreviateHash, formatDate, relativeTime } from "../lib/format.ts";
import {
  DESKTOP_SESSION_STATUS_LABELS,
  DEVICE_CAPABILITY_LABELS,
  PAIRING_STATUS_LABELS
} from "../lib/labels.ts";
import type {
  DesktopActionRequest,
  DesktopSessionView,
  DeviceCapability,
  DeviceCapabilityKind,
  DeviceView,
  PairingRequestView
} from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

const CAPABILITY_ORDER: DeviceCapabilityKind[] = ["observe", "desktop.control", "ui.automation"];
const PRESS_KEYS = ["Enter", "Tab", "Escape", "Ctrl+S"];
const COMMAND_KIND_LABELS: Record<string, string> = {
  observe: "观察",
  click: "点击",
  type: "输入",
  press: "按键",
  focus: "切换窗口",
  "uia.invoke": "界面调用",
  "uia.setvalue": "界面写入"
};

export function DevicesPage() {
  const queryClient = useQueryClient();
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const desktopQuery = useQuery({ queryKey: ["desktop"], queryFn: api.desktop, refetchInterval: 3_000 });
  const devices = desktopQuery.data?.devices ?? [];
  const pairings = desktopQuery.data?.pairings ?? [];
  const sessions = desktopQuery.data?.sessions ?? [];
  const pendingPairings = pairings.filter((pairing) => pairing.status === "pending");

  async function perform(key: string, work: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ["desktop"] });
      setNotice(message);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page devices-page">
      <div className="page-head">
        <div>
          <h1>桌面设备</h1>
          <p className="page-meta">配对只建立连接。观察、控制、界面自动化需要分别批准。</p>
        </div>
        <button className="ghost-button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["desktop"] })}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {error && <p className="form-error" role="alert"><X size={14} /> {error}</p>}
      {notice && <p className="device-notice"><Check size={14} /> {notice}</p>}

      {desktopQuery.isLoading ? (
        <p className="section-empty">正在读取桌面设备…</p>
      ) : devices.length === 0 && pendingPairings.length === 0 ? (
        <section className="panel">
          <EmptyState title="还没有桌面设备" body="在这台电脑的终端启动桌面助手，配对码会显示在终端里。" />
          <HelperCommand pro={pro} />
        </section>
      ) : (
        <>
          {pendingPairings.length > 0 && (
            <section className="panel pairing-list">
              <div className="panel-head">
                <h2>等待配对</h2>
                <span className="panel-meta">短时有效 · 批准后不自动授予能力</span>
              </div>
              {pendingPairings.map((pairing) => (
                <PairingRow
                  key={pairing.id}
                  pairing={pairing}
                  busy={busy === `pairing-${pairing.id}`}
                  onApprove={() => void perform(
                    `pairing-${pairing.id}`,
                    () => api.approvePairing(pairing.id),
                    "已配对。接下来请逐项批准设备能力，设备仍不能操作桌面。"
                  )}
                  onReject={() => void perform(
                    `pairing-${pairing.id}`,
                    () => api.rejectPairing(pairing.id),
                    "已拒绝配对请求。"
                  )}
                />
              ))}
            </section>
          )}

          {devices.map((device) => {
            const session = sessions.find((view) => view.device.id === device.id && view.session.status !== "terminated") ?? null;
            return (
              <DevicePanel
                key={device.id}
                device={device}
                session={session}
                pro={pro}
                busy={busy}
                perform={perform}
              />
            );
          })}

          {(devices.length > 0 || pro) && <HelperCommand pro={pro} />}
        </>
      )}

      <p className="device-privacy"><LockKeyhole size={13} /> 桌面截图只保存在本机，默认 2 分钟后不可再查看，不会写入任务事件或发送到外部渠道。</p>
    </div>
  );
}

function PairingRow({
  pairing,
  busy,
  onApprove,
  onReject
}: {
  pairing: PairingRequestView;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <article className="pairing-item">
      <div className="pairing-main">
        <div className="pairing-title">
          <Monitor size={16} />
          <strong>{pairing.name}</strong>
          <span className="status-pill tone-active">{PAIRING_STATUS_LABELS[pairing.status]}</span>
          <span className="pairing-code">{pairing.code}</span>
        </div>
        <p className="pairing-meta">Windows · 助手 {pairing.version} · {relativeTime(pairing.createdAt)}请求</p>
        <p className="pairing-request">申请能力：{pairing.requestedCapabilities.map((kind) => DEVICE_CAPABILITY_LABELS[kind]).join("、")}</p>
        <p className="pairing-apps">申请应用：{pairing.requestedApps.join("、")}</p>
      </div>
      <div className="pairing-actions">
        <button className="ghost-button" onClick={onReject} disabled={busy}><X size={14} /> 拒绝</button>
        <button className="primary-button" onClick={onApprove} disabled={busy}><ShieldCheck size={14} /> 允许配对</button>
      </div>
    </article>
  );
}

function DevicePanel({
  device,
  session,
  pro,
  busy,
  perform
}: {
  device: DeviceView;
  session: DesktopSessionView | null;
  pro: boolean;
  busy: string | null;
  perform: (key: string, work: () => Promise<unknown>, message: string) => Promise<boolean>;
}) {
  const observeApproved = device.capabilities.some((capability) => capability.kind === "observe" && capability.status === "approved");
  const canStart = device.online && observeApproved;

  return (
    <section className={`panel device-panel ${device.status === "revoked" ? "is-revoked" : ""}`}>
      <div className="device-head">
        <div className="device-title">
          <Monitor size={18} />
          <div>
            <h2>{device.name}</h2>
            <p>Windows · 助手 {device.version} · 最近活动 {device.lastSeenAt ? relativeTime(device.lastSeenAt) : "未连接"}</p>
          </div>
          <DeviceOnlineTag online={device.online} revoked={device.status === "revoked"} />
        </div>
        {device.status !== "revoked" && (
          <button
            className="ghost-button danger"
            disabled={busy === `revoke-${device.id}`}
            onClick={() => {
              if (window.confirm(`撤销 ${device.name}？设备令牌会立即失效，正在进行的桌面会话会终止。`)) {
                void perform(`revoke-${device.id}`, () => api.revokeDevice(device.id), "设备已撤销，令牌立即失效。");
              }
            }}
          >
            <CircleOff size={14} /> 撤销设备
          </button>
        )}
      </div>

      {!device.online && device.status !== "revoked" && (
        <p className="device-offline-note">设备离线。启动桌面助手后会自动恢复在线；离线时不能开始新会话或执行动作。</p>
      )}

      <div className="device-capability-list">
        {CAPABILITY_ORDER.map((kind) => {
          const capability = device.capabilities.find((item) => item.kind === kind);
          if (!capability) return null;
          return (
            <CapabilityRow
              key={kind}
              device={device}
              capability={capability}
              busy={busy === `cap-${device.id}-${kind}`}
              perform={perform}
            />
          );
        })}
      </div>

      {device.status !== "revoked" && (
        session ? (
          <SessionPanel sessionView={session} pro={pro} busy={busy} perform={perform} />
        ) : (
          <div className="device-session-start">
            <div>
              <h3>还没有桌面会话</h3>
              <p>开始后，助手会先观察当前白名单应用，不会直接输入。</p>
            </div>
            <button
              className="primary-button"
              disabled={!canStart || busy === `session-${device.id}`}
              onClick={() => void perform(`session-${device.id}`, () => api.createDesktopSession(device.id), "桌面会话已开始，等待助手回传第一张截图。")}
            >
              <Eye size={14} /> 开始观察
            </button>
          </div>
        )
      )}

      {pro && <DeviceAudit device={device} session={session} />}
    </section>
  );
}

function CapabilityRow({
  device,
  capability,
  busy,
  perform
}: {
  device: DeviceView;
  capability: DeviceCapability;
  busy: boolean;
  perform: (key: string, work: () => Promise<unknown>, message: string) => Promise<boolean>;
}) {
  const [apps, setApps] = useState(capability.apps.join(", "));
  const approved = capability.status === "approved";
  return (
    <div className={`device-capability status-${capability.status}`}>
      <div className="device-capability-label">
        <strong>{DEVICE_CAPABILITY_LABELS[capability.kind]}</strong>
        <DeviceCapabilityStatusTag status={capability.status} />
      </div>
      <p className="device-capability-apps">应用：{capability.apps.join("、")}</p>
      {approved ? (
        <button
          className="ghost-button danger"
          disabled={busy}
          onClick={() => void perform(
            `cap-${device.id}-${capability.kind}`,
            () => api.revokeDeviceCapability(device.id, capability.kind),
            `${DEVICE_CAPABILITY_LABELS[capability.kind]}已撤销。`
          )}
        >
          撤销能力
        </button>
      ) : (
        <div className="device-capability-approve">
          <label>
            <span>允许的应用或进程</span>
            <input value={apps} onChange={(event) => setApps(event.target.value)} placeholder="notepad, calculator" />
          </label>
          <button
            className="ghost-button"
            disabled={busy || parseApps(apps).length === 0}
            onClick={() => void perform(
              `cap-${device.id}-${capability.kind}`,
              () => api.approveDeviceCapability(device.id, capability.kind, parseApps(apps)),
              `${DEVICE_CAPABILITY_LABELS[capability.kind]}已批准。`
            )}
          >
            <Check size={14} /> 批准能力
          </button>
        </div>
      )}
    </div>
  );
}

function SessionPanel({
  sessionView,
  pro,
  busy,
  perform
}: {
  sessionView: DesktopSessionView;
  pro: boolean;
  busy: string | null;
  perform: (key: string, work: () => Promise<unknown>, message: string) => Promise<boolean>;
}) {
  const { session, frame, commands } = sessionView;
  const [typeText, setTypeText] = useState("");
  const [uiaName, setUiaName] = useState("");
  const [uiaType, setUiaType] = useState("Button");
  const [uiaValue, setUiaValue] = useState("");
  const [focusApp, setFocusApp] = useState(frame?.activeApp ?? "");
  const actionKey = `desktop-action-${session.id}`;
  const active = session.status === "active";
  const canAct = active && frame !== null && Date.parse(frame.expiresAt) > Date.now();
  const lastCommand = commands[commands.length - 1];

  async function sendAction(input: DesktopActionRequest, message: string): Promise<void> {
    await perform(actionKey, () => api.desktopAction(session.id, input), message);
  }

  function clickFrame(event: MouseEvent<HTMLButtonElement>): void {
    if (!frame || !canAct) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    void sendAction({ kind: "click", frameId: frame.id, x, y }, "点击已排队。助手执行后会回传新的观察。");
  }

  return (
    <div className="device-session">
      <div className="device-session-head">
        <div className="device-session-title">
          <h3>桌面会话</h3>
          <DesktopSessionStatusTag status={session.status} />
          {lastCommand && <span className="device-command-last">{COMMAND_KIND_LABELS[lastCommand.kind] ?? lastCommand.kind} <DesktopCommandStatusTag status={lastCommand.status} /></span>}
        </div>
        <div className="device-session-controls">
          <button className="ghost-button" disabled={!active || busy !== null} onClick={() => void perform(
            `session-${session.id}-pause`, () => api.pauseDesktop(session.id), "已暂停。待执行输入已取消，助手不会开始新的动作。"
          )}><Pause size={14} /> 暂停</button>
          <button className="ghost-button" disabled={session.status !== "paused" || busy !== null} onClick={() => void perform(
            `session-${session.id}-resume`, () => api.resumeDesktop(session.id), "已继续，并请求重新观察。"
          )}><Play size={14} /> 继续</button>
          <button className="ghost-button" disabled={!active || busy !== null} onClick={() => void perform(
            `session-${session.id}-takeover`, () => api.takeOverDesktop(session.id), "你已接管。自动输入已取消，交还前需要重新观察。"
          )}><Hand size={14} /> 接管</button>
          <button className="ghost-button" disabled={session.status !== "taken_over" || busy !== null} onClick={() => void perform(
            `session-${session.id}-release`, () => api.releaseDesktop(session.id), "已交还控制，正在等待新观察。"
          )}><Undo2 size={14} /> 交还</button>
          <button className="ghost-button danger" disabled={busy !== null} onClick={() => {
            if (window.confirm("终止这个桌面会话？后续命令会被取消。")) {
              void perform(`session-${session.id}-terminate`, () => api.terminateDesktop(session.id), "桌面会话已终止。");
            }
          }}><CircleOff size={14} /> 终止</button>
        </div>
      </div>

      <div className="device-frame-area">
        {frame ? (
          <>
            <button
              type="button"
              className="device-frame-button"
              onClick={clickFrame}
              disabled={!canAct || busy !== null}
              aria-label="点击截图会在当前应用执行一次点击"
            >
              <img src={frame.url} alt={`${frame.windowTitle || frame.activeApp} 的桌面截图`} />
            </button>
            <p className="device-frame-meta">
              <MousePointerClick size={13} /> {canAct ? "点击截图会在当前白名单应用中点按一次。" : "会话不在自动控制状态，截图仅供查看。"}
              <span>{frame.activeApp} · {frame.windowTitle || "未命名窗口"} · {formatDate(frame.capturedAt)}</span>
            </p>
            {pro && (
              <p className="mono tiny device-frame-hash">frame {frame.id} · {frame.width}×{frame.height} · sha256 {abbreviateHash(frame.sha256)} · 到期 {formatDate(frame.expiresAt)}</p>
            )}
          </>
        ) : (
          <div className="device-frame-empty">
            <Eye size={16} />
            <span>{active || session.status === "paused" ? "等待助手回传新的观察。" : "你接管期间不会自动观察。"}</span>
          </div>
        )}
        <button className="ghost-button" disabled={busy !== null} onClick={() => void perform(
          `session-${session.id}-observe`, () => api.observeDesktop(session.id), "已请求观察；新截图到达后会自动显示。"
        )}><RefreshCw size={14} /> 重新观察</button>
      </div>

      {frame && active && (
        <div className="device-actions">
          <div className="device-action-row">
            <label className="device-action-field">
              <span><Type size={13} /> 输入短文本</span>
              <input value={typeText} onChange={(event) => setTypeText(event.target.value)} maxLength={1000} placeholder="只输入当前窗口需要的内容" />
            </label>
            <button className="ghost-button" disabled={!canAct || !typeText || busy !== null} onClick={() => void sendAction(
              { kind: "type", frameId: frame.id, text: typeText },
              "文字输入已排队。助手执行后会回传新的观察。"
            )}><Type size={14} /> 输入</button>
          </div>
          <div className="device-action-row device-key-row">
            <span><Keyboard size={13} /> 按键</span>
            {PRESS_KEYS.map((keys) => (
              <button key={keys} className="ghost-button" disabled={!canAct || busy !== null} onClick={() => void sendAction(
                { kind: "press", frameId: frame.id, keys },
                `${keys} 已排队。`
              )}>{keys}</button>
            ))}
          </div>
          {pro && (
            <>
              <div className="device-action-row">
                <label className="device-action-field">
                  <span><Monitor size={13} /> 切换到应用</span>
                  <input value={focusApp} onChange={(event) => setFocusApp(event.target.value)} placeholder={frame.activeApp} />
                </label>
                <button className="ghost-button" disabled={!canAct || !focusApp || busy !== null} onClick={() => void sendAction(
                  { kind: "focus", frameId: frame.id, app: focusApp },
                  "切换窗口已排队。"
                )}>切换</button>
              </div>
              <div className="device-action-row device-uia-row">
                <label className="device-action-field">
                  <span>界面元素</span>
                  <input value={uiaName} onChange={(event) => setUiaName(event.target.value)} placeholder="按钮或输入框名称" />
                </label>
                <label className="device-action-field compact">
                  <span>控件类型</span>
                  <select value={uiaType} onChange={(event) => setUiaType(event.target.value)}>
                    {["Button", "MenuItem", "Edit", "ListItem", "TabItem", "Hyperlink", "CheckBox", "ComboBox", "TreeItem"].map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
                <button className="ghost-button" disabled={!canAct || !uiaName || busy !== null} onClick={() => void sendAction(
                  { kind: "uia.invoke", frameId: frame.id, elementName: uiaName, controlType: uiaType },
                  "界面调用已排队。"
                )}><MousePointerClick size={14} /> 调用</button>
                <label className="device-action-field">
                  <span>写入值</span>
                  <input value={uiaValue} onChange={(event) => setUiaValue(event.target.value)} maxLength={500} placeholder="只写草稿或筛选条件" />
                </label>
                <button className="ghost-button" disabled={!canAct || !uiaName || busy !== null} onClick={() => void sendAction(
                  { kind: "uia.setvalue", frameId: frame.id, elementName: uiaName, value: uiaValue, controlType: uiaType },
                  "界面写入已排队。"
                )}>写入</button>
              </div>
            </>
          )}
        </div>
      )}

      {session.status === "taken_over" && (
        <p className="device-takeover-note">你正在操作这台设备。Hearth 不会发送输入；完成后点“交还”，系统会先重新观察。</p>
      )}
      {pro && <DeviceCommands sessionView={sessionView} />}
    </div>
  );
}

function DeviceCommands({ sessionView }: { sessionView: DesktopSessionView }) {
  const commands = [...sessionView.commands].reverse().slice(0, 10);
  return (
    <div className="panel device-command-panel">
      <div className="panel-head">
        <h2>命令记录</h2>
        <span className="panel-meta">控制代次 {sessionView.session.controlEpoch}</span>
      </div>
      {commands.length === 0 ? (
        <p className="section-empty">还没有命令。</p>
      ) : (
        <div className="table-panel">
          <table className="data-table">
            <thead><tr><th>动作</th><th>状态</th><th>帧</th><th>时间</th><th>结果</th></tr></thead>
            <tbody>
              {commands.map((command) => (
                <tr key={command.id}>
                  <td>{COMMAND_KIND_LABELS[command.kind] ?? command.kind}</td>
                  <td><DesktopCommandStatusTag status={command.status} /></td>
                  <td className="mono">{command.frameId ? abbreviateHash(command.frameId) : "—"}</td>
                  <td>{formatDate(command.createdAt)}</td>
                  <td className="device-command-result">{command.error ?? (command.result ? JSON.stringify(command.result) : "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeviceAudit({ device, session }: { device: DeviceView; session: DesktopSessionView | null }) {
  return (
    <div className="panel device-audit-panel">
      <div className="panel-head">
        <h2>设备审计</h2>
        <span className="panel-meta">仅专业版显示</span>
      </div>
      <dl className="kv-grid device-audit">
        <div><dt>设备 ID</dt><dd className="mono select-all">{device.id}</dd></div>
        <div><dt>配对请求</dt><dd className="mono select-all">{device.pairingRequestId}</dd></div>
        <div><dt>最近心跳</dt><dd>{formatDate(device.lastSeenAt)}</dd></div>
        <div><dt>会话状态</dt><dd>{session ? `${DESKTOP_SESSION_STATUS_LABELS[session.session.status]} · 代次 ${session.session.controlEpoch}` : "无活动会话"}</dd></div>
        {session && <div><dt>当前观察</dt><dd className="mono select-all">{session.frame?.id ?? "等待新截图"}</dd></div>}
      </dl>
      {session && session.frames.length > 1 && (
        <div className="device-frame-history">
          <h3>最近观察</h3>
          <div className="device-frame-thumbs">
            {session.frames.slice(0, 4).map((frame) => (
              <figure key={frame.id}>
                <img src={frame.url} alt="历史桌面观察" />
                <figcaption>{frame.activeApp} · {formatDate(frame.capturedAt)}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HelperCommand({ pro }: { pro: boolean }) {
  return (
    <div className="device-helper">
      <div>
        <strong><Terminal size={14} /> 启动桌面助手</strong>
        <p>在要连接的 Windows 电脑上运行。助手会显示六位配对码。</p>
      </div>
      {pro ? (
        <code>npm run helper:windows -- --apps notepad,calculator</code>
      ) : (
        <span className="subtle">先把助手下载到同一台电脑，再输入配对码。</span>
      )}
    </div>
  );
}

function parseApps(value: string): string[] {
  return value.split(/[,，;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}
