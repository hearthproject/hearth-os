const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "assets");
const FONT = "'Microsoft YaHei UI','Microsoft YaHei','PingFang SC','Noto Sans SC','Segoe UI',sans-serif";
const MONO = "'Cascadia Mono','Consolas','SFMono-Regular',monospace";
const COLORS = {
  bg: "#F4F7FB",
  card: "#FFFFFF",
  border: "#DDE5F0",
  ink: "#172033",
  body: "#42506A",
  muted: "#74829A",
  blue: "#2563EB",
  blueSoft: "#EAF1FE",
  teal: "#0E8587",
  tealSoft: "#E4F5F4",
  violet: "#6C5BD4",
  violetSoft: "#F0EDFC",
  amber: "#B4680B",
  amberSoft: "#FCF0DF",
  green: "#18794E",
  greenSoft: "#E6F4EC"
};

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function header(title, subtitle, width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">
<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>
<rect x="0" y="0" width="${width}" height="7" fill="${COLORS.blue}"/>
<text x="64" y="72" font-size="30" font-weight="700" fill="${COLORS.ink}">${escape(title)}</text>
<text x="64" y="104" font-size="15" fill="${COLORS.muted}">${escape(subtitle)}</text>`;
}

function card(x, y, w, h, title, lines, tone = "blue", badge = "") {
  const fill = COLORS[`${tone}Soft`] ?? COLORS.blueSoft;
  const stroke = COLORS[tone] ?? COLORS.blue;
  const lineHtml = lines.map((line, index) => `<text x="${x + 18}" y="${y + 62 + index * 21}" font-size="12.5" fill="${COLORS.body}">${escape(line)}</text>`).join("\n");
  const badgeHtml = badge ? `<text x="${x + w - 14}" y="${y + 24}" font-size="10.5" font-family="${MONO}" fill="${COLORS.muted}" text-anchor="end">${escape(badge)}</text>` : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>
<text x="${x + 18}" y="${y + 30}" font-size="15" font-weight="700" fill="${COLORS.ink}">${escape(title)}</text>
${badgeHtml}
${lineHtml}`;
}

function band(x, y, w, h, label) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#FFFFFF" stroke="${COLORS.border}" stroke-width="1.2"/>
<text x="${x + 22}" y="${y + 28}" font-size="12" font-family="${MONO}" fill="${COLORS.muted}">${escape(label)}</text>`;
}

function downArrow(x, y, length, color = COLORS.blue) {
  return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + length}" stroke="${color}" stroke-width="2"/>
<polyline points="${x - 5},${y + length - 7} ${x},${y + length} ${x + 5},${y + length - 7}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

function rightArrow(x, y, length, color = COLORS.muted) {
  return `<line x1="${x}" y1="${y}" x2="${x + length}" y2="${y}" stroke="${color}" stroke-width="1.6"/>
<polyline points="${x + length - 7},${y - 5} ${x + length},${y} ${x + length - 7},${y + 5}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
}

function footer(width, height, text) {
  return `<text x="64" y="${height - 34}" font-size="11" fill="${COLORS.muted}">${escape(text)}</text>
</svg>`;
}

function architecture() {
  const W = 1600;
  const H = 1160;
  const rows = [
    { y: 150, h: 160, label: "入口 / apps/web", cards: [
      [64, "聊天工作台", ["内联执行轨迹", "右侧产物与预览"], "blue"],
      [326, "资料库", ["文件 / 记忆 / 技能", "检索、预览与回收站"], "violet"],
      [588, "Context", ["接手摘要", "多账号共享与导出"], "teal"],
      [850, "邮件与定时任务", ["草稿 / 发送审批", "Cron、补跑与冷却"], "amber"],
      [1112, "连接与设置", ["飞书 / 浏览器", "模型、执行器与数据"], "green"]
    ]},
    { y: 334, h: 160, label: "控制面 / apps/server", cards: [
      [64, "HostKernel", ["单实例宿主租约", "recovering → ready"], "violet"],
      [326, "Fastify API", ["REST + SSE", "就绪前拒绝写请求"], "blue"],
      [588, "Scheduler", ["任务状态机", "租约 / 预算 / 重试"], "amber"],
      [850, "恢复闸门", ["沿父 run 链检查", "未知副作用不重放"], "green"],
      [1112, "审批与效果账本", ["参数指纹与预览", "回执 / 对账"], "teal"]
    ]},
    { y: 518, h: 170, label: "执行内核 / packages/agent-runtime", cards: [
      [64, "Native Runtime", ["4 种模型协议", "工具循环 / 压缩 / 预算"], "blue"],
      [326, "操作账本", ["prepare → dispatch", "settle / unknown"], "violet"],
      [588, "Windows 沙箱", ["AppContainer + Job", "网络 deny / open"], "teal"],
      [850, "PTY 与后台进程", ["ConPTY 交互会话", "PID 注册表恢复"], "amber"],
      [1112, "子代理 / MCP / Worktree", ["单层串行、逐次审批", "隔离分支与产物"], "green"]
    ]},
    { y: 712, h: 160, label: "执行器与外部边界", cards: [
      [64, "Native（默认）", ["通用 + coding", "当前聊天模型"], "blue"],
      [326, "Codex", ["OpenAI Responses", "系统 codex.exe"], "violet"],
      [588, "DeepSeek Harness", ["官方 SDK / JSON-RPC", "会话与事件恢复"], "teal"],
      [850, "外部动作", ["邮件 / 桌面 / 浏览器", "执行前逐次审批"], "amber"],
      [1112, "结果与回收", ["run-evidence.json", "cleanup / storage:prune"], "green"]
    ]},
    { y: 896, h: 160, label: "存储 / 本地优先", cards: [
      [64, "单一事件日志", ["SQLite events", "schema v40"], "amber"],
      [326, "运行账本", ["run_operations", "background_processes"], "blue"],
      [588, "检查点", ["物化视图 + event_seq", "损坏时从事件重建"], "violet"],
      [850, "产物与回执", ["artifacts / outbox", "SHA-256 引用"], "teal"],
      [1112, "备份与诊断", ["AES-256-GCM", "脱敏健康快照"], "green"]
    ]}
  ];
  const parts = [header("Hearth 架构", "单用户、本地优先、可审批、可恢复的个人 Agent OS", W, H)];
  for (const row of rows) {
    parts.push(band(44, row.y, W - 88, row.h, row.label));
    row.cards.forEach(([x, title, lines, tone], index) => {
      parts.push(card(x, row.y + 44, 250, row.h - 58, title, lines, tone, String(index + 1).padStart(2, "0")));
    });
  }
  for (let i = 0; i < rows.length - 1; i += 1) {
    const y = rows[i].y + rows[i].h + 4;
    parts.push(downArrow(W / 2, y, 24));
  }
  parts.push(`<text x="${W - 64}" y="86" font-size="13" font-family="${MONO}" fill="${COLORS.muted}" text-anchor="end">v0.3.4 · 2026-11</text>`);
  parts.push(footer(W, H, "界面状态来自可重建的记录；每个状态只有一个写权威；外部副作用必须经过审批或显式豁免，并留下可核对回执。"));
  return parts.join("\n");
}

function flow() {
  const W = 1700;
  const H = 780;
  const stages = [
    ["1 说目标", ["对话或附件", "路径即工作目录"], "blue"],
    ["2 定任务", ["执行器与产物契约", "权限与网络范围"], "violet"],
    ["3 进沙箱", ["AppContainer", "网络 deny / open"], "teal"],
    ["4 记操作", ["prepare / dispatch", "外部动作先审批"], "amber"],
    ["5 动手", ["工具 / 子代理 / PTY", "测试与页面断言"], "blue"],
    ["6 结算", ["settle / cleanup", "未知则停车核对"], "green"],
    ["7 交证据", ["产物 / run-evidence", "回执与回退"], "violet"]
  ];
  const parts = [header("一次任务的完整路径", "从一句目标到可核对的完成证据", W, H)];
  parts.push(band(44, 150, W - 88, 190, "request path"));
  stages.forEach(([title, lines, tone], index) => {
    const x = 64 + index * 236;
    parts.push(card(x, 196, 206, 128, title, lines, tone));
    if (index < stages.length - 1) parts.push(rightArrow(x + 206, 260, 30, COLORS.muted));
  });
  parts.push(band(44, 370, W - 88, 190, "trust boundary"));
  const trust = [
    ["宿主租约", ["单实例写入", "恢复完成才就绪"], "teal"],
    ["操作账本", ["未结算不重放", "外部写要回执"], "amber"],
    ["沙箱与审批", ["文件 / 进程 / 网络", "参数指纹与预览"], "green"],
    ["证据与回退", ["checkpoint proof", "文件哈希与漂移保护"], "blue"]
  ];
  trust.forEach(([title, lines, tone], index) => {
    const x = 64 + index * 410;
    parts.push(card(x, 414, 370, 128, title, lines, tone));
    if (index < trust.length - 1) parts.push(rightArrow(x + 370, 478, 40, COLORS.muted));
  });
  parts.push(`<text x="64" y="630" font-size="13" fill="${COLORS.body}">失败时：保留失败原因和证据，任务进入可恢复状态；未知副作用停车等待人工核对，不覆盖历史。</text>`);
  parts.push(footer(W, H, "执行器可替换，审批、操作账本与证据层不能绕过。"));
  return parts.join("\n");
}

function simple() {
  const W = 1500;
  const H = 620;
  const steps = [
    ["说清楚要什么", ["目标 + 验收标准", "需要的文件和路径"], "blue"],
    ["在边界内动手", ["工作区可写、外部先问", "沙箱限制文件与网络"], "teal"],
    ["自己验证", ["跑测试 / 查页面", "拿证据而不是猜"], "green"],
    ["交给你决定", ["结果 / 证据 / 回退", "回执与不确定项"], "amber"]
  ];
  const parts = [header("Hearth 怎么做事", "四步，结果可核对", W, H)];
  steps.forEach(([title, lines, tone], index) => {
    const x = 64 + index * 360;
    parts.push(card(x, 210, 320, 190, title, lines, tone, `0${index + 1}`));
    if (index < steps.length - 1) parts.push(rightArrow(x + 320, 306, 40, COLORS.muted));
  });
  parts.push(`<rect x="64" y="454" width="1372" height="72" rx="14" fill="${COLORS.blueSoft}" stroke="${COLORS.blue}" stroke-width="1.2"/>`);
  parts.push(`<text x="86" y="485" font-size="13" font-weight="700" fill="${COLORS.ink}">你能看到的东西</text>`);
  parts.push(`<text x="86" y="510" font-size="12.5" fill="${COLORS.body}">每次改了什么文件、跑了什么测试、哪个页面断言通过、哪个操作还没结算、能不能一键退回去。</text>`);
  parts.push(footer(W, H, "不承诺“全自动”；承诺“做完有证据，做错能回退”。"));
  return parts.join("\n");
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "Hearth-Architecture-Light.svg"), architecture(), "utf8");
fs.writeFileSync(path.join(OUT, "Hearth-Flow-Light.svg"), flow(), "utf8");
fs.writeFileSync(path.join(OUT, "Hearth-Flow-Simple-Light.svg"), simple(), "utf8");
console.log("wrote 3 diagrams to assets/");
