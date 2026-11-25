import { createHash } from "node:crypto";
import type { Frame, Page } from "playwright-core";

export interface BrowserElement {
  ref: string;
  frameIndex: number;
  frameUrl: string;
  role: string;
  name: string;
  value: string | null;
  disabled: boolean;
  checked: boolean | null;
  bbox: { x: number; y: number; width: number; height: number };
  tag: string;
  type: string | null;
}

export interface BrowserFrameSnapshot {
  index: number;
  url: string;
  name: string;
  elements: Array<Omit<BrowserElement, "frameIndex" | "frameUrl">>;
  text: string;
}

export interface RawBrowserSnapshot {
  url: string;
  title: string;
  frames: BrowserFrameSnapshot[];
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  digest: string;
  content: string;
  elements: BrowserElement[];
  truncated: boolean;
  capturedAt: string;
}

const MAX_SNAPSHOT_CHARS = 16_000;
const MAX_FRAME_TEXT_CHARS = 2_800;

/**
 * Runs inside each Playwright frame. It walks open shadow roots and assigns
 * epoch-scoped refs so a ref captured before a user takeover cannot be reused.
 */
export function inspectBrowserFrame(input: {
  epoch: number;
  startSeq: number;
  frameIndex: number;
}): {
  url: string;
  name: string;
  text: string;
  elements: Array<{
    ref: string;
    role: string;
    name: string;
    value: string | null;
    disabled: boolean;
    checked: boolean | null;
    bbox: { x: number; y: number; width: number; height: number };
    tag: string;
    type: string | null;
  }>;
} {
  const interactiveRoles = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "option",
    "textbox", "combobox", "switch", "slider", "spinbutton", "searchbox"
  ]);
  const output: Array<{
    ref: string;
    role: string;
    name: string;
    value: string | null;
    disabled: boolean;
    checked: boolean | null;
    bbox: { x: number; y: number; width: number; height: number };
    tag: string;
    type: string | null;
  }> = [];
  const texts: string[] = [];
  let seq = input.startSeq;

  function visible(node: HTMLElement): boolean {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function isInteractive(node: HTMLElement): boolean {
    const tag = node.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary"].includes(tag)) return true;
    if (node.isContentEditable || node.getAttribute("contenteditable") === "true") return true;
    const role = node.getAttribute("role");
    return Boolean(role && interactiveRoles.has(role));
  }

  function accessibleName(node: HTMLElement): string {
    const explicit = node.getAttribute("aria-label")
      || node.getAttribute("aria-placeholder")
      || node.getAttribute("placeholder")
      || node.getAttribute("alt")
      || node.getAttribute("title");
    if (explicit) return explicit.replace(/\s+/g, " ").trim().slice(0, 160);
    const labelledBy = node.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id) => node.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text.slice(0, 160);
    }
    const label = node.closest("label")?.textContent;
    if (label) return label.replace(/\s+/g, " ").trim().slice(0, 160);
    return (node.innerText || node.textContent || node.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  function visit(root: Document | ShadowRoot): void {
    const nodes = root.querySelectorAll("*");
    for (const raw of nodes) {
      if (!(raw instanceof HTMLElement)) continue;
      if (raw.shadowRoot) visit(raw.shadowRoot);
      if (!isInteractive(raw) || !visible(raw)) continue;
      const tag = raw.tagName.toLowerCase();
      const type = tag === "input" ? (raw as HTMLInputElement).type || "text" : raw.getAttribute("type");
      const role = raw.getAttribute("role") || (
        tag === "a" ? "link"
          : tag === "button" || tag === "summary" ? "button"
            : tag === "select" ? "combobox"
              : tag === "textarea" ? "textbox"
                : tag === "input"
                  ? type === "checkbox" ? "checkbox"
                    : type === "radio" ? "radio"
                      : type === "submit" || type === "button" ? "button"
                        : type === "search" ? "searchbox"
                          : "textbox"
                  : raw.isContentEditable ? "textbox" : "element"
      );
      seq += 1;
      const ref = `${input.epoch}:e${seq}`;
      raw.dataset.hearthRef = ref;
      const inputNode = raw as HTMLInputElement;
      const rawValue = typeof inputNode.value === "string" ? inputNode.value : "";
      const rect = raw.getBoundingClientRect();
      output.push({
        ref,
        role,
        name: accessibleName(raw),
        value: type === "password" || inputNode.autocomplete === "current-password" || inputNode.autocomplete === "new-password"
          ? null
          : rawValue ? rawValue.slice(0, 240) : null,
        disabled: Boolean((raw as HTMLButtonElement).disabled || raw.getAttribute("aria-disabled") === "true"),
        checked: type === "checkbox" || type === "radio" ? Boolean(inputNode.checked) : null,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        tag,
        type
      });
    }

    const text = root instanceof Document
      ? (root.body?.innerText ?? "")
      : (root.textContent ?? "");
    if (text.trim()) texts.push(text.replace(/\r/g, "").trim());
  }

  visit(document);
  return {
    url: location.href,
    name: window.name || `frame-${input.frameIndex}`,
    text: [...new Set(texts)].join("\n\n"),
    elements: output
  };
}

export async function captureRawBrowserSnapshot(page: Page, epoch: number): Promise<RawBrowserSnapshot> {
  const frames: BrowserFrameSnapshot[] = [];
  let startSeq = 0;
  const pageFrames = page.frames();
  for (let index = 0; index < pageFrames.length; index += 1) {
    const frame = pageFrames[index]!;
    const data = await inspectFrame(frame, { epoch, startSeq, frameIndex: index }).catch(() => null);
    if (!data) continue;
    frames.push({ ...data, index });
    startSeq += data.elements.length;
  }
  return { url: page.url(), title: await page.title().catch(() => ""), frames };
}

async function inspectFrame(
  frame: Frame,
  input: { epoch: number; startSeq: number; frameIndex: number }
): Promise<Omit<BrowserFrameSnapshot, "index">> {
  const source = `(() => {
    const __name = (target) => target;
    return (${inspectBrowserFrame.toString()})(${JSON.stringify(input)});
  })()`;
  return frame.evaluate(source);
}

export function formatBrowserSnapshot(raw: RawBrowserSnapshot): BrowserSnapshot {
  const elements: BrowserElement[] = raw.frames.flatMap((frame) =>
    frame.elements.map((element) => ({ ...element, frameIndex: frame.index, frameUrl: frame.url }))
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ url: raw.url, title: raw.title, elements, frames: raw.frames.map((frame) => frame.text.slice(0, MAX_FRAME_TEXT_CHARS)) }))
    .digest("hex")
    .slice(0, 16);
  const lines = [
    `页面：${raw.title || "(无标题)"}`,
    `网址：${raw.url}`,
    `摘要指纹：${digest}`,
    "",
    "可交互元素："
  ];
  if (elements.length === 0) lines.push("- (没有发现可结构化操作的可见元素)");
  for (const element of elements) {
    const state = [
      `frame=${element.frameIndex}`,
      element.role,
      `${element.bbox.x},${element.bbox.y} ${element.bbox.width}x${element.bbox.height}`,
      element.type ? `type=${element.type}` : "",
      element.disabled ? "disabled" : "",
      element.checked === null ? "" : `checked=${element.checked}`
    ].filter(Boolean).join(" · ");
    const value = element.value ? ` value="${clip(element.value, 60)}"` : "";
    lines.push(`- ${element.ref} ${state} 「${element.name || "(无名)"}」${value}`);
  }
  for (const frame of raw.frames) {
    if (!frame.text.trim()) continue;
    lines.push("", `Frame ${frame.index}：${frame.name || "(未命名)"} ${frame.url}`, clip(frame.text, MAX_FRAME_TEXT_CHARS));
  }
  let content = lines.join("\n");
  const truncated = content.length > MAX_SNAPSHOT_CHARS;
  if (truncated) {
    const suffix = "\n…（页面摘要已截断，可结合截图与坐标工具继续）";
    content = `${content.slice(0, MAX_SNAPSHOT_CHARS - suffix.length)}${suffix}`;
  }
  return { url: raw.url, title: raw.title, digest, content, elements, truncated, capturedAt: new Date().toISOString() };
}

export async function captureBrowserSnapshot(page: Page, epoch = 1): Promise<BrowserSnapshot> {
  return formatBrowserSnapshot(await captureRawBrowserSnapshot(page, epoch));
}

export function extensionSnapshotCode(epoch: number): string {
  return `async (page) => {
    const __name = (target) => target;
    const inspect = (${inspectBrowserFrame.toString()});
    const frames = [];
    let startSeq = 0;
    const pageFrames = page.frames();
    for (let index = 0; index < pageFrames.length; index += 1) {
      try {
        const data = await pageFrames[index].evaluate(inspect, { epoch: ${epoch}, startSeq, frameIndex: index });
        frames.push({ ...data, index });
        startSeq += data.elements.length;
      } catch {}
    }
    return { url: page.url(), title: await page.title().catch(() => ""), frames };
  }`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
