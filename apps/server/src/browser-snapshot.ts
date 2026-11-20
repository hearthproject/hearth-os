import { createHash } from "node:crypto";
import type { Page } from "playwright-core";

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value: string | null;
  disabled: boolean;
  checked: boolean | null;
  bbox: { x: number; y: number; width: number; height: number };
  tag: string;
  type: string | null;
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

const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_TEXT_CHARS = 2_400;
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable=true]"
].join(",");

export async function captureBrowserSnapshot(page: Page): Promise<BrowserSnapshot> {
  const raw = await page.evaluate((selector) => {
    const root = document.documentElement;
    let seq = Number(root.dataset.hearthRefSeq ?? "0");
    const elements: Array<{
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
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width <= 1 || rect.height <= 1 || style.display === "none" || style.visibility === "hidden") continue;
      let ref = node.dataset.hearthRef;
      if (!ref) {
        seq += 1;
        ref = `e${seq}`;
        node.dataset.hearthRef = ref;
      }
      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute("type");
      const role = node.getAttribute("role") || inferRole(node, tag, type);
      const name = (
        node.getAttribute("aria-label")
        || node.getAttribute("aria-placeholder")
        || node.getAttribute("placeholder")
        || node.getAttribute("alt")
        || node.getAttribute("title")
        || node.textContent
        || node.getAttribute("name")
        || ""
      ).replace(/\s+/g, " ").trim().slice(0, 120);
      const input = node as HTMLInputElement;
      const value = type === "password"
        ? null
        : typeof input.value === "string" && input.value
          ? input.value.slice(0, 160)
          : null;
      elements.push({
        ref,
        role,
        name,
        value,
        disabled: Boolean((node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true"),
        checked: type === "checkbox" || type === "radio" ? Boolean(input.checked) : null,
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
    root.dataset.hearthRefSeq = String(seq);
    const bodyText = (document.body?.innerText ?? "").replace(/\r/g, "");
    return {
      url: location.href,
      title: document.title,
      text: bodyText,
      elements
    };
  }, INTERACTIVE_SELECTOR);

  const digest = createHash("sha256")
    .update(JSON.stringify({ url: raw.url, title: raw.title, elements: raw.elements, text: raw.text.slice(0, MAX_TEXT_CHARS) }))
    .digest("hex")
    .slice(0, 16);
  const lines = [
    `页面：${raw.title || "(无标题)"}`,
    `网址：${raw.url}`,
    `摘要指纹：${digest}`,
    "",
    "可交互元素：",
    ...raw.elements.map((element) => {
      const state = [
        element.role,
        `${element.bbox.x},${element.bbox.y} ${element.bbox.width}x${element.bbox.height}`,
        element.type ? `type=${element.type}` : "",
        element.disabled ? "disabled" : "",
        element.checked === null ? "" : `checked=${element.checked}`
      ].filter(Boolean).join(" · ");
      const value = element.value ? ` value="${clip(element.value, 60)}"` : "";
      return `- ${element.ref} ${state} 「${element.name || "(无名)"}」${value}`;
    }),
    "",
    "页面正文：",
    clip(raw.text, MAX_TEXT_CHARS)
  ];
  let content = lines.join("\n");
  const truncated = content.length > MAX_SNAPSHOT_CHARS;
  if (truncated) {
    const suffix = "\n…（页面摘要已截断）";
    content = `${content.slice(0, MAX_SNAPSHOT_CHARS - suffix.length)}${suffix}`;
  }
  return {
    url: raw.url,
    title: raw.title,
    digest,
    content,
    elements: raw.elements,
    truncated,
    capturedAt: new Date().toISOString()
  };
}

function inferRole(node: HTMLElement, tag: string, type: string | null): string {
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  return node.getAttribute("contenteditable") === "true" ? "textbox" : "element";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
