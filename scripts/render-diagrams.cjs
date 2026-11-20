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
  const H = 980;
  const rows = [
    { y: 150, h: 118, label: "入口 / apps/web", cards: [
      [64, "聊天工作台", ["目标、对话、任务卡"], "blue"],
      [326, "需要你", ["长任务 / 审批 / 失败"], "amber"],
      [588, "任务详情", ["逐轮时间线 / 回退"], "violet"],
      [850, "浏览器面板", ["标签页 / 截图 / 接管"], "teal"],
      [1112, "档案与设置", ["项目档案 / 工作方式"], "green"]
    ]},
    { y: 292, h: 150, label: "Hearth Server / apps/server", cards: [
      [64, "Fastify API", ["事件推送 / SSE"], "blue"],
      [326, "Scheduler", ["租约 / 预算 / 重试"], "violet"],
      [588, "审批与动作解析", ["参数指纹 / 风险 / 回执"], "amber"],
      [850, "效果账本", ["执行 / 对账 / 回退"], "green"],
      [1112, "监督与档案", ["收件箱 / 日报 / 项目页"], "teal"]
    ]},
    { y: 466, h: 160, label: "执行层 / packages/agent-runtime", cards: [
      [64, "Native Runtime", ["general / coding", "工具、子代理、上下文压缩"], "blue"],
      [326, "Coding Harness", ["workspace-write", "测试 / 诊断 / 逐轮快照"], "violet"],
      [588, "Browser", ["独立 Chrome profile", "快照 / 断言 / 证据"], "teal"],
      [850, "桌面与外部", ["桌面控制 / MCP"], "amber"],
      [1112, "邮件与飞书", ["读取 / 草稿 / 发送审批"], "green"]
    ]},
    { y: 654, h: 150, label: "存储 / 本地优先", cards: [
      [64, "SQLite 事件账本", ["任务 / 运行 / 审批 / 事件"], "amber"],
      [326, "文件系统", ["out / 快照 / 记忆 / 档案"], "blue"],
      [588, "加密备份", ["主密钥 / 恢复校验"], "green"],
      [850, "设置与密钥", ["模型 / 浏览器 / 执行器"], "violet"],
      [1112, "公开基准", ["固定模型 / 预算 / 报告"], "teal"]
    ]}
  ];
  const parts = [header("Hearth 架构", "单用户、本地优先、可审批、可回放的个人代理操作系统", W, H)];
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
  parts.push(`<text x="${W - 64}" y="86" font-size="13" font-family="${MONO}" fill="${COLORS.muted}" text-anchor="end">v0.2 · 2026-11</text>`);
  parts.push(footer(W, H, "没有远程推理集群，没有多设备同步；所有状态落在本机，所有外部动作可追溯到审批指纹。"));
  return parts.join("\n");
}

function flow() {
  const W = 1700;
  const H = 760;
  const stages = [
    ["1 说目标", ["自然语言或附件"], "blue"],
    ["2 定边界", ["目标契约 / 完成判定"], "violet"],
    ["3 选执行", ["general / coding / browser"], "teal"],
    ["4 审批", ["workspace 自动可逆", "外部动作逐次确认"], "amber"],
    ["5 动手", ["工具 / 子代理 / 测试"], "blue"],
    ["6 验证", ["测试 / 断言 / diff"], "green"],
    ["7 报告", ["证据 / 回执 / 可回退"], "violet"]
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
    ["页面快照", ["稳定元素 ID", "密码值不返回"], "teal"],
    ["动作审批", ["风险等级", "参数指纹 / 域名授权"], "amber"],
    ["效果账本", ["执行前记录", "执行后对账"], "green"],
    ["逐轮历史", ["文件快照", "回退漂移保护"], "blue"]
  ];
  trust.forEach(([title, lines, tone], index) => {
    const x = 64 + index * 410;
    parts.push(card(x, 414, 370, 128, title, lines, tone));
    if (index < trust.length - 1) parts.push(rightArrow(x + 370, 478, 40, COLORS.muted));
  });
  parts.push(`<text x="64" y="630" font-size="13" fill="${COLORS.body}">失败时：保留失败原因和证据，任务进入 recoverable；修复后重试，不覆盖历史。</text>`);
  parts.push(footer(W, H, "执行层可替换，审批与证据层不能绕过。"));
  return parts.join("\n");
}

function simple() {
  const W = 1500;
  const H = 620;
  const steps = [
    ["说清楚要什么", ["目标 + 验收标准"], "blue"],
    ["在安全范围内动手", ["工作区可逆写入", "外部动作先问"], "teal"],
    ["自己验证", ["跑测试 / 查页面", "拿证据而不是猜"], "green"],
    ["交给你决定", ["结果 / 证据 / 回退"], "amber"]
  ];
  const parts = [header("Hearth 怎么做事", "四步，结果可核对", W, H)];
  steps.forEach(([title, lines, tone], index) => {
    const x = 64 + index * 360;
    parts.push(card(x, 210, 320, 190, title, lines, tone, `0${index + 1}`));
    if (index < steps.length - 1) parts.push(rightArrow(x + 320, 306, 40, COLORS.muted));
  });
  parts.push(`<rect x="64" y="454" width="1372" height="72" rx="14" fill="${COLORS.blueSoft}" stroke="${COLORS.blue}" stroke-width="1.2"/>`);
  parts.push(`<text x="86" y="485" font-size="13" font-weight="700" fill="${COLORS.ink}">你能看到的东西</text>`);
  parts.push(`<text x="86" y="510" font-size="12.5" fill="${COLORS.body}">每次改了什么文件、增删多少行、跑了什么测试、哪个页面断言通过、失败原因是什么、能不能一键退回去。</text>`);
  parts.push(footer(W, H, "不承诺“全自动”；承诺“做完有证据，做错能回退”。"));
  return parts.join("\n");
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "Hearth-Architecture-Light.svg"), architecture(), "utf8");
fs.writeFileSync(path.join(OUT, "Hearth-Flow-Light.svg"), flow(), "utf8");
fs.writeFileSync(path.join(OUT, "Hearth-Flow-Simple-Light.svg"), simple(), "utf8");
console.log("wrote 3 diagrams to assets/");
