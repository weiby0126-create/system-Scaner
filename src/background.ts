import { db } from "./lib/db";
import { createId } from "./lib/ids";
import { sanitizeUrl } from "./lib/sanitize";
import type { ClickEvidence, ExtensionMessage, NetworkEntry, PageDuplicateInfo, PageRecord, PageTransition } from "./types";

const latestPageByTab = new Map<number, string>();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

async function getRunningTask() {
  const task = await db.getActiveTask();
  return task?.status === "running" ? task : undefined;
}

async function captureScreenshot(tabId?: number): Promise<string | undefined> {
  if (!tabId) return undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId || !tab.active) return undefined;
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    return undefined;
  }
}

function normalizeText(value = ""): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function stableUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const volatileKeys = ["checkcode", "_", "t", "ts", "timestamp", "random", "nonce", "token", "access_token", "session"];
    for (const key of Array.from(url.searchParams.keys())) {
      if (volatileKeys.some((volatileKey) => key.toLowerCase().includes(volatileKey))) {
        url.searchParams.delete(key);
      }
    }
    const query = url.searchParams.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
  } catch {
    return rawUrl.split("?")[0];
  }
}

function compactList(values: string[] = [], max = 24): string {
  return Array.from(new Set(values.map(normalizeText).filter(Boolean))).sort().slice(0, max).join("|");
}

function exactFingerprint(page: Omit<PageRecord, "duplicateInfo">): string {
  const tableColumns = page.elements.tables.flatMap((table) => table.columnHeaders);
  return [
    stableUrl(page.url),
    normalizeText(page.title),
    compactList(page.path),
    normalizeText(page.naming?.displayName),
    compactList(page.elements.buttons),
    compactList(page.elements.inputs),
    compactList(tableColumns),
    page.html.length
  ].join("::");
}

function structuralFingerprint(page: Omit<PageRecord, "duplicateInfo">): string {
  const tableColumns = page.elements.tables.flatMap((table) => table.columnHeaders);
  return [
    normalizeText(page.naming?.displayName),
    compactList(page.path),
    compactList(page.naming?.objectHints),
    compactList(page.elements.inputs, 18),
    compactList(tableColumns, 18)
  ].join("::");
}

function overlapRatio(left: string[] = [], right: string[] = []): number {
  const leftSet = new Set(left.map(normalizeText).filter(Boolean));
  const rightSet = new Set(right.map(normalizeText).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  leftSet.forEach((value) => {
    if (rightSet.has(value)) overlap += 1;
  });
  return overlap / Math.min(leftSet.size, rightSet.size);
}

type DedupeResult = { kind: "exact"; page: PageRecord } | { kind: "new"; info: PageDuplicateInfo };

function duplicateInfo(page: Omit<PageRecord, "duplicateInfo">, existingPages: PageRecord[]): DedupeResult {
  const exact = exactFingerprint(page);
  const structural = structuralFingerprint(page);
  const exactMatch = existingPages.find((existing) => existing.duplicateInfo?.exactFingerprint === exact);
  if (exactMatch) return { kind: "exact", page: exactMatch };

  const tableColumns = page.elements.tables.flatMap((table) => table.columnHeaders);
  const suspected = existingPages.find((existing) => {
    const sameStructural = existing.duplicateInfo?.structuralFingerprint === structural;
    const sameName = normalizeText(existing.naming?.displayName) === normalizeText(page.naming?.displayName);
    const samePath = compactList(existing.path) === compactList(page.path);
    const inputOverlap = overlapRatio(existing.elements.inputs, page.elements.inputs);
    const tableOverlap = overlapRatio(existing.elements.tables.flatMap((table) => table.columnHeaders), tableColumns);
    return sameStructural || (sameName && samePath) || (sameName && (inputOverlap >= 0.8 || tableOverlap >= 0.8));
  });

  if (!suspected) {
    return {
      kind: "new",
      info: {
        status: "unique",
        exactFingerprint: exact,
        structuralFingerprint: structural,
        reasons: []
      }
    };
  }

  return {
    kind: "new",
    info: {
      status: "suspected_duplicate",
      exactFingerprint: exact,
      structuralFingerprint: structural,
      duplicateGroupId: suspected.duplicateInfo?.duplicateGroupId ?? `dup-${suspected.pageId}`,
      canonicalPageId: suspected.duplicateInfo?.canonicalPageId ?? suspected.pageId,
      canonicalPageName: suspected.naming?.displayName || suspected.title || suspected.url,
      confidence: "medium",
      reasons: [
        "页面名称、菜单路径、表单项或表格列与已采页面高度相似",
        "保留当前页面证据，仅标记为疑似重复，供后续人工合并"
      ]
    }
  };
}

function pageName(page: PageRecord): string {
  return page.naming?.displayName || page.title || page.url;
}

async function recordTransition(
  taskId: string,
  tabId: number | undefined,
  toPage: PageRecord,
  exactDuplicateSkipped = false,
  clickedElement?: ClickEvidence
) {
  const fromPageId = tabId ? latestPageByTab.get(tabId) : undefined;
  if (fromPageId === toPage.pageId && !clickedElement) return;

  const fromPage = fromPageId ? await db.getPage(fromPageId) : undefined;
  const transition: PageTransition = {
    id: createId("path"),
    taskId,
    tabId,
    fromPageId,
    fromPageName: fromPage ? pageName(fromPage) : undefined,
    fromUrl: fromPage?.url,
    toPageId: toPage.pageId,
    toPageName: pageName(toPage),
    toUrl: toPage.url,
    timestamp: new Date().toISOString(),
    trigger: clickedElement ? "page_click" : "manual_capture",
    clickedElement,
    exactDuplicateSkipped
  };
  await db.putTransition(transition);
  if (tabId) latestPageByTab.set(tabId, toPage.pageId);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === "GET_TASK_STATE") {
    db.getActiveTask().then(sendResponse);
    return true;
  }

  if (message.type === "PAGE_CAPTURE") {
    void (async () => {
      const task = await getRunningTask();
      const tabId = sender.tab?.id;
      if (!task) return;

      const pageId = message.payload.pageId;

      const network = await db.listNetwork(pageId);
      const basePage: Omit<PageRecord, "duplicateInfo"> = {
        ...message.payload,
        taskId: task.id,
        tabId,
        url: sanitizeUrl(message.payload.url),
        screenshotDataUrl: await captureScreenshot(tabId),
        network,
        evidenceVersion: "raw-v1",
        derivedVersion: "derived-v1"
      };

      const existingPages = await db.listPages(task.id);
      const dedupe = duplicateInfo(basePage, existingPages);
      if (dedupe.kind === "exact") {
        await recordTransition(task.id, tabId, dedupe.page, true, message.payload.click);
        return;
      }

      const page: PageRecord = { ...basePage, duplicateInfo: dedupe.info };
      await db.putPage(page);
      await recordTransition(task.id, tabId, page, false, message.payload.click);
    })();
  }

  if (message.type === "NETWORK_CAPTURE") {
    void (async () => {
      const task = await getRunningTask();
      if (!task) return;

      const tabId = sender.tab?.id;
      const pageId = tabId ? latestPageByTab.get(tabId) : undefined;
      const entry: NetworkEntry = {
        ...message.payload,
        id: createId("net"),
        tabId,
        pageId,
        url: sanitizeUrl(message.payload.url),
        timestamp: new Date().toISOString()
      };
      await db.putNetwork(entry);

      if (pageId) {
        const page = await db.getPage(pageId);
        if (page) {
          const network = await db.listNetwork(pageId);
          await db.putPage({ ...page, network });
        }
      }
    })();
  }
});
