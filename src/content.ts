import type { ClickEvidence, ExtensionMessage, PageElements, PageNaming, PageRelationSeed } from "./types";

declare global {
  interface Window {
    __CDA_CONTENT_SCRIPT_READY__?: boolean;
  }
}

let networkHookInjected = false;
let clickCaptureTimer: number | undefined;
let lastClickAt = 0;

function createId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function sanitizeUrl(rawUrl: string): string {
  const sensitiveQueryKeys = ["authorization", "access_token", "token", "password", "passwd", "pwd", "secret", "session", "cookie"];
  try {
    const url = new URL(rawUrl, location.href);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryKeys.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey))) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function injectNetworkHook() {
  if (networkHookInjected) return;
  if (!document.documentElement && !document.head) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;
  (document.documentElement || document.head).appendChild(script);
  script.remove();
  networkHookInjected = true;
}

function visibleText(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function unique(values: string[], max = 80): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, max);
}

function cleanName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[|｜].*$/g, "")
    .trim()
    .slice(0, 80);
}

function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && parts.length < 6) {
    const tag = current.tagName.toLowerCase();
    const id = current.id && /^[a-zA-Z][\w-]*$/.test(current.id) ? `#${current.id}` : "";
    const role = current.getAttribute("role");
    const label = current.getAttribute("aria-label") || current.getAttribute("title");
    const className = Array.from(current.classList)
      .filter((name) => !/active|selected|hover|focus|open|show|disabled/i.test(name))
      .slice(0, 2)
      .map((name) => `.${CSS.escape(name)}`)
      .join("");
    const nth = current.parentElement
      ? `:nth-child(${Array.from(current.parentElement.children).indexOf(current) + 1})`
      : "";
    const hint = label ? `[label="${label.replace(/\s+/g, " ").trim().slice(0, 40)}"]` : role ? `[role="${role}"]` : "";
    parts.unshift(`${tag}${id || className || hint ? `${id}${className}${hint}` : nth}`);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function nearestClickable(element: Element): Element {
  return element.closest("button, a, [role='button'], [role='menuitem'], [role='tab'], input, select, textarea, [onclick], tr, td, [class*='menu' i], [class*='tab' i]") ?? element;
}

function extractClickEvidence(element: Element, event: MouseEvent): ClickEvidence {
  const target = nearestClickable(element);
  const input = target instanceof HTMLInputElement ? target : undefined;
  const inputLabel = input && ["button", "submit", "reset"].includes(input.type) ? input.value : "";
  const anchor = target.closest("a");
  const text = cleanName(
    visibleText(target) ||
      inputLabel ||
      target.getAttribute("aria-label") ||
      target.getAttribute("title") ||
      target.getAttribute("name") ||
      target.id ||
      target.tagName.toLowerCase()
  );

  return {
    text: text || target.tagName.toLowerCase(),
    tagName: target.tagName.toLowerCase(),
    role: target.getAttribute("role") || undefined,
    selector: cssPath(target),
    href: anchor?.href ? sanitizeUrl(anchor.href) : undefined,
    ariaLabel: target.getAttribute("aria-label") || undefined,
    title: target.getAttribute("title") || undefined,
    inputType: input?.type,
    coordinates: {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY)
    }
  };
}

function urlSegments(): string[] {
  return unique(
    location.hash
      .replace(/^#/, "")
      .split(/[/?&=]+/)
      .concat(location.pathname.split("/"))
      .filter((segment) => segment && !/^[a-f0-9]{16,}$/i.test(segment) && !/^\d+$/.test(segment)),
    12
  );
}

function extractPath(): string[] {
  const selectors = [
    "[aria-label*='breadcrumb' i] a, [aria-label*='breadcrumb' i] span",
    ".breadcrumb a, .breadcrumb span, .breadcrumbs a, .breadcrumbs span",
    "[class*='breadcrumb' i] a, [class*='breadcrumb' i] span",
    "[class*='menu' i] .active, [class*='menu' i] [aria-current='page']",
    "[class*='tree' i] .active, [class*='tree' i] [aria-selected='true']"
  ];

  for (const selector of selectors) {
    const path = unique(Array.from(document.querySelectorAll(selector)).map(visibleText), 12);
    if (path.length > 0) return path;
  }

  return [];
}

function extractElements(): PageElements {
  const buttons = unique(
    Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"))
      .map((element) => visibleText(element) || element.getAttribute("value") || element.getAttribute("aria-label") || "")
  );

  const inputs = unique(
    Array.from(document.querySelectorAll("input, textarea, select"))
      .map((element) => element.getAttribute("placeholder") || element.getAttribute("aria-label") || element.getAttribute("name") || element.id || element.tagName.toLowerCase())
  );

  const tables = Array.from(document.querySelectorAll("table")).slice(0, 20).map((table) => ({
    caption: visibleText(table.querySelector("caption") ?? table).slice(0, 80) || undefined,
    columnHeaders: unique(Array.from(table.querySelectorAll("th")).map(visibleText), 30),
    rowCount: table.querySelectorAll("tbody tr, tr").length
  }));

  const labels = unique(
    Array.from(document.querySelectorAll("label, h1, h2, h3, [class*='label' i]"))
      .map(visibleText),
    120
  );

  return { buttons, inputs, tables, labels };
}

function extractNaming(path: string[], elements: PageElements): PageNaming {
  const headingCandidates = unique(
    Array.from(document.querySelectorAll("h1, h2, h3, .title, [class*='title' i], [class*='tab' i].active, [aria-selected='true']"))
      .map(visibleText)
      .map(cleanName),
    20
  );

  const tableHeaders = elements.tables.flatMap((table) => table.columnHeaders).slice(0, 20);
  const formLabels = unique(elements.inputs.concat(elements.labels).map(cleanName), 30);
  const keyTexts = unique(path.concat(headingCandidates, tableHeaders, formLabels), 40);
  const objectHints = unique(
    keyTexts.filter((text) => /工单|Case|客户|资产|设备|服务商|组织|用户|项目|任务书|结费|保修|知识|附件|日志|记录/i.test(text)),
    20
  );

  const candidates = unique(
    [
      path.at(-1) ?? "",
      ...headingCandidates,
      document.title,
      ...objectHints,
      ...urlSegments()
    ].map(cleanName),
    20
  );

  return {
    displayName: candidates[0] || cleanName(document.title) || location.pathname || location.href,
    candidates,
    keyTexts,
    objectHints
  };
}

function extractRelationSeeds(path: string[], elements: PageElements, naming: PageNaming): PageRelationSeed[] {
  const seeds: PageRelationSeed[] = [];

  path.forEach((item, index) => {
    seeds.push({
      type: "navigation",
      name: item,
      targetHint: path.slice(0, index + 1).join(" / "),
      evidence: "auto-detected menu or breadcrumb path"
    });
  });

  Array.from(document.querySelectorAll("[class*='tab' i], [role='tab'], .ant-tabs-tab, .el-tabs__item"))
    .map(visibleText)
    .filter(Boolean)
    .slice(0, 20)
    .forEach((tab) => seeds.push({ type: "tab", name: cleanName(tab), targetHint: naming.displayName, evidence: "visible tab text" }));

  elements.tables.forEach((table, index) => {
    if (table.columnHeaders.length > 0) {
      seeds.push({
        type: "table",
        name: table.caption || `表格${index + 1}`,
        targetHint: table.columnHeaders.slice(0, 8).join(" / "),
        evidence: "table column headers"
      });
    }
  });

  elements.inputs.slice(0, 30).forEach((input) => {
    seeds.push({ type: "form", name: input, targetHint: naming.displayName, evidence: "input placeholder, aria-label, name or id" });
  });

  if (/detail|详情|handle|view/i.test(location.href)) {
    seeds.push({ type: "detail", name: naming.displayName, targetHint: location.href, evidence: "url detail-like pattern" });
  }

  return seeds;
}

function sendCapture(click?: ClickEvidence) {
  const message: ExtensionMessage = {
    type: "PAGE_CAPTURE",
    payload: {
      pageId: createId("page"),
      tabId: undefined,
      url: location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      path: (() => {
        const path = extractPath();
        return path;
      })(),
      html: document.documentElement.outerHTML,
      elements: extractElements(),
      naming: { displayName: "", candidates: [], keyTexts: [], objectHints: [] },
      relationSeeds: [],
      click,
      manualNote: { purpose: "", userRole: "", importance: "", manualPath: "" }
    }
  };

  const path = message.payload.path;
  const elements = message.payload.elements;
  const naming = extractNaming(path, elements);
  message.payload.naming = naming;
  message.payload.relationSeeds = extractRelationSeeds(path, elements, naming);

  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function scheduleClickCapture(event: MouseEvent) {
  const taskStateMessage: ExtensionMessage = { type: "GET_TASK_STATE" };
  void chrome.runtime.sendMessage(taskStateMessage).then((task) => {
    if (!task || task.status !== "running") return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target) return;

    const now = Date.now();
    if (now - lastClickAt < 250) return;
    lastClickAt = now;

    const click = extractClickEvidence(target, event);
    window.clearTimeout(clickCaptureTimer);
    clickCaptureTimer = window.setTimeout(() => sendCapture(click), 1200);
  }).catch(() => undefined);
}

function start() {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "CDA_NETWORK_CAPTURE") return;

    const message: ExtensionMessage = {
      type: "NETWORK_CAPTURE",
      payload: {
        ...event.data.payload,
        url: sanitizeUrl(event.data.payload.url)
      }
    };
    chrome.runtime.sendMessage(message).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "FORCE_CAPTURE") sendCapture();
  });

  document.addEventListener("click", scheduleClickCapture, true);

  injectNetworkHook();
}

if (!window.__CDA_CONTENT_SCRIPT_READY__) {
  window.__CDA_CONTENT_SCRIPT_READY__ = true;
  start();
}
