import JSZip from "jszip";
import { db } from "./db";
import type { PageRecord, PageTransition, ScanTask } from "../types";

function pageFolderName(index: number): string {
  return `page-${String(index + 1).padStart(3, "0")}`;
}

function dataUrlToBase64(dataUrl?: string): string | undefined {
  return dataUrl?.split(",")[1];
}

function pageJson(page: PageRecord) {
  const { html, screenshotDataUrl, network, ...metadata } = page;
  return {
    ...metadata,
    rawEvidence: {
      htmlFile: "page.html",
      screenshotFile: screenshotDataUrl ? "screenshot.png" : null,
      networkFile: "network.json"
    },
    derivedFrom: {
      html: "document.documentElement.outerHTML",
      screenshot: "chrome.tabs.captureVisibleTab",
      network: "fetch/xhr monkey patch in page context, sanitized before storage"
    },
    elements: page.elements,
    naming: page.naming,
    relationSeeds: page.relationSeeds,
    path: page.path,
    manualNote: page.manualNote
  };
}

function effectivePath(page: PageRecord): string[] {
  const manualPath = page.manualNote?.manualPath
    ?.split("/")
    .map((item) => item.trim())
    .filter(Boolean);
  return manualPath?.length ? manualPath : page.path;
}

function pageIndex(pages: PageRecord[]) {
  return pages.map((page, index) => ({
    pageRef: `pages/${pageFolderName(index)}`,
    pageId: page.pageId,
    displayName: page.naming?.displayName || page.title || page.url,
    nameCandidates: page.naming?.candidates ?? [],
    url: page.url,
    title: page.title,
    menuPath: effectivePath(page),
    keyTexts: page.naming?.keyTexts ?? [],
    objectHints: page.naming?.objectHints ?? [],
    duplicateInfo: page.duplicateInfo,
    capturedAt: page.timestamp
  }));
}

function navigationMap(pages: PageRecord[], transitions: PageTransition[]) {
  const nodes = new Map<string, { id: string; name: string; type: "system" | "menu" | "page"; parentId?: string; pageRef?: string }>();
  const edges: Array<{ from: string; to: string; type: "contains" | "opens" | "clicked_to"; timestamp?: string }> = [];
  const systemId = "system";
  nodes.set(systemId, { id: systemId, name: "系统", type: "system" });

  pages.forEach((page, index) => {
    let parentId = systemId;
    const path = effectivePath(page);
    path.forEach((name, pathIndex) => {
      const id = `menu:${path.slice(0, pathIndex + 1).join("/")}`;
      if (!nodes.has(id)) nodes.set(id, { id, name, type: "menu", parentId });
      edges.push({ from: parentId, to: id, type: "contains" });
      parentId = id;
    });

    const pageId = `page:${page.pageId}`;
    nodes.set(pageId, {
      id: pageId,
      name: page.naming?.displayName || page.title || page.url,
      type: "page",
      parentId,
      pageRef: `pages/${pageFolderName(index)}`
    });
    edges.push({ from: parentId, to: pageId, type: "opens" });
  });

  transitions.forEach((transition) => {
    if (!transition.fromPageId) return;
    edges.push({
      from: `page:${transition.fromPageId}`,
      to: `page:${transition.toPageId}`,
      type: "clicked_to",
      timestamp: transition.timestamp
    });
  });

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(new Map(edges.map((edge) => [`${edge.from}->${edge.to}:${edge.type}`, edge])).values())
  };
}

function relationshipSeeds(pages: PageRecord[]) {
  return pages.map((page, index) => ({
    pageRef: `pages/${pageFolderName(index)}`,
    pageId: page.pageId,
    displayName: page.naming?.displayName || page.title || page.url,
    menuPath: effectivePath(page),
    seeds: [
      ...(page.relationSeeds ?? []),
      ...page.network.slice(0, 80).map((entry) => ({
        type: "api" as const,
        name: `${entry.method} ${entry.url}`,
        targetHint: entry.status ? String(entry.status) : "",
        evidence: "sanitized fetch/xhr record"
      }))
    ]
  }));
}

export async function buildTaskZip(task: ScanTask): Promise<Blob> {
  const pages = await db.listPages(task.id);
  const transitions = await db.listTransitions(task.id);
  const zip = new JSZip();

  zip.file("metadata.json", JSON.stringify(task, null, 2));
  zip.file(
    "summary.json",
    JSON.stringify(
      {
        taskId: task.id,
        exportedAt: new Date().toISOString(),
        pageCount: pages.length,
        clickPathCount: transitions.length,
        evidencePolicy: "Raw HTML, screenshots, and sanitized network records are preserved before AI analysis.",
        aiAnalysisMode: "External only. Re-run analysis from exported evidence files.",
        indexFiles: ["page-index.json", "navigation-map.json", "relationship-seeds.json", "click-paths.json"]
      },
      null,
      2
    )
  );
  zip.file("page-index.json", JSON.stringify(pageIndex(pages), null, 2));
  zip.file("navigation-map.json", JSON.stringify(navigationMap(pages, transitions), null, 2));
  zip.file("relationship-seeds.json", JSON.stringify(relationshipSeeds(pages), null, 2));
  zip.file("click-paths.json", JSON.stringify(transitions, null, 2));

  const pagesFolder = zip.folder("pages");
  pages.forEach((page, index) => {
    const folder = pagesFolder?.folder(pageFolderName(index));
    folder?.file("page.html", page.html);
    folder?.file("page.json", JSON.stringify(pageJson(page), null, 2));
    folder?.file("network.json", JSON.stringify(page.network, null, 2));

    const screenshot = dataUrlToBase64(page.screenshotDataUrl);
    if (screenshot) {
      folder?.file("screenshot.png", screenshot, { base64: true });
    }
  });

  return zip.generateAsync({ type: "blob" });
}
