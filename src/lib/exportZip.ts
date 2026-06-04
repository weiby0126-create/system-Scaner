import JSZip from "jszip";
import { db } from "./db";
import type { PageRecord, PageTransition, ScanTask, StructureRelation } from "../types";

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

function normalize(value = ""): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function entryType(transition: PageTransition): StructureRelation["entryType"] {
  const click = transition.clickedElement;
  if (!click) return "manual";
  if (click.role === "tab" || /tab/i.test(click.selector)) return "tab";
  if (click.tagName === "a" || click.href) return "link";
  if (click.tagName === "tr" || click.tagName === "td") return "row";
  if (click.role === "menuitem" || /menu/i.test(click.selector)) return "menu";
  if (click.tagName === "button" || click.role === "button" || click.inputType === "button" || click.inputType === "submit") return "button";
  return "unknown";
}

function relationType(transition: PageTransition): StructureRelation["relationType"] {
  if (!transition.clickedElement) return "manual_checkpoint";
  if (transition.fromPageId === transition.toPageId) return "same_page_action";
  if (/detail|详情|handle|view/i.test(`${transition.toPageName} ${transition.toUrl}`)) return "detail_entry";
  return "navigation";
}

function confidenceFor(relation: StructureRelation): StructureRelation["confidence"] {
  if (relation.relationType === "same_page_action") return relation.supportCount > 1 ? "medium" : "low";
  if (relation.relationType === "manual_checkpoint") return "low";
  if (relation.supportCount > 1) return "high";
  return "medium";
}

function buildStructureRelations(transitions: PageTransition[]): StructureRelation[] {
  const grouped = new Map<string, StructureRelation>();

  transitions.forEach((transition) => {
    const entryName = transition.clickedElement?.text || (transition.trigger === "manual_capture" ? "手动补采" : "未知入口");
    const type = entryType(transition);
    const relation = relationType(transition);
    const key = [
      transition.taskId,
      transition.fromPageId || "start",
      transition.toPageId,
      normalize(entryName),
      relation
    ].join("::");

    const existing = grouped.get(key);
    if (existing) {
      existing.supportCount += 1;
      existing.lastSeenAt = transition.timestamp;
      existing.evidenceTransitionIds.push(transition.id);
      existing.confidence = confidenceFor(existing);
      if (transition.exactDuplicateSkipped && !existing.notes.includes("重复进入未新增页面证据")) {
        existing.notes.push("重复进入未新增页面证据");
      }
      return;
    }

    const next: StructureRelation = {
      id: `relation-${grouped.size + 1}`,
      taskId: transition.taskId,
      fromPageId: transition.fromPageId,
      fromPageName: transition.fromPageName,
      toPageId: transition.toPageId,
      toPageName: transition.toPageName,
      entryName,
      entryType: type,
      relationType: relation,
      confidence: "medium",
      supportCount: 1,
      firstSeenAt: transition.timestamp,
      lastSeenAt: transition.timestamp,
      evidenceTransitionIds: [transition.id],
      notes: [
        ...(transition.exactDuplicateSkipped ? ["重复进入未新增页面证据"] : []),
        ...(relation === "same_page_action" ? ["同页操作，作为页面内功能线索，不作为目录层级入口"] : []),
        ...(relation === "manual_checkpoint" ? ["手动补采，仅作为页面存在证据，不作为业务入口"] : [])
      ]
    };
    next.confidence = confidenceFor(next);
    grouped.set(key, next);
  });

  return Array.from(grouped.values()).sort((left, right) => {
    const rank = { navigation: 0, detail_entry: 1, same_page_action: 2, manual_checkpoint: 3 };
    return rank[left.relationType] - rank[right.relationType] || right.supportCount - left.supportCount || left.firstSeenAt.localeCompare(right.firstSeenAt);
  });
}

function navigationMap(pages: PageRecord[], relations: StructureRelation[]) {
  const nodes = new Map<string, { id: string; name: string; type: "system" | "menu" | "page"; parentId?: string; pageRef?: string }>();
  const edges: Array<{ from: string; to: string; type: "contains" | "opens" | "structure_link"; entryName?: string; relationType?: StructureRelation["relationType"]; confidence?: StructureRelation["confidence"]; supportCount?: number }> = [];
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

  relations.forEach((relation) => {
    if (!relation.fromPageId || relation.fromPageId === relation.toPageId || relation.relationType === "same_page_action" || relation.relationType === "manual_checkpoint") return;
    edges.push({
      from: `page:${relation.fromPageId}`,
      to: `page:${relation.toPageId}`,
      type: "structure_link",
      entryName: relation.entryName,
      relationType: relation.relationType,
      confidence: relation.confidence,
      supportCount: relation.supportCount
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
  const structureRelations = buildStructureRelations(transitions);
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
        structureRelationCount: structureRelations.length,
        evidencePolicy: "Raw HTML, screenshots, and sanitized network records are preserved before AI analysis.",
        aiAnalysisMode: "External only. Re-run analysis from exported evidence files.",
        indexFiles: ["page-index.json", "navigation-map.json", "relationship-seeds.json", "structure-relations.json", "click-paths.json"]
      },
      null,
      2
    )
  );
  zip.file("page-index.json", JSON.stringify(pageIndex(pages), null, 2));
  zip.file("navigation-map.json", JSON.stringify(navigationMap(pages, structureRelations), null, 2));
  zip.file("relationship-seeds.json", JSON.stringify(relationshipSeeds(pages), null, 2));
  zip.file("structure-relations.json", JSON.stringify(structureRelations, null, 2));
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
