import JSZip from "jszip";
import { Download, FileArchive, GitBranch, Layers, Network, Upload } from "lucide-react";
import { useMemo, useState } from "react";

type ZipJson = Record<string, unknown>;

type PageIndexItem = {
  pageRef: string;
  pageId: string;
  displayName: string;
  nameCandidates?: string[];
  url?: string;
  title?: string;
  menuPath?: string[];
  keyTexts?: string[];
  objectHints?: string[];
  duplicateInfo?: {
    status?: "unique" | "suspected_duplicate";
    canonicalPageId?: string;
    canonicalPageName?: string;
    confidence?: string;
    reasons?: string[];
  };
};

type NavigationNode = {
  id: string;
  name: string;
  type: "system" | "menu" | "page";
  parentId?: string;
  pageRef?: string;
};

type NavigationEdge = {
  from: string;
  to: string;
  type: "contains" | "opens" | "structure_link";
  entryName?: string;
  relationType?: string;
  confidence?: string;
  supportCount?: number;
};

type RelationshipSeed = {
  pageRef: string;
  pageId: string;
  displayName: string;
  menuPath?: string[];
  seeds?: Array<{
    type: "navigation" | "detail" | "tab" | "table" | "form" | "api";
    name: string;
    targetHint?: string;
    evidence?: string;
  }>;
};

type ClickPath = {
  id: string;
  fromPageName?: string;
  toPageName: string;
  timestamp: string;
  trigger?: "manual_capture" | "page_click";
  clickedElement?: {
    text?: string;
    tagName?: string;
    selector?: string;
  };
  exactDuplicateSkipped?: boolean;
};

type StructureRelation = {
  id: string;
  fromPageName?: string;
  toPageName: string;
  entryName: string;
  entryType?: string;
  relationType: "navigation" | "detail_entry" | "same_page_action" | "manual_checkpoint";
  confidence: "low" | "medium" | "high";
  supportCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceTransitionIds?: string[];
  notes?: string[];
};

type RestoredFunction = {
  functionName: string;
  pageRef: string;
  pageName: string;
  evidence: string[];
};

type RestoredCapability = {
  domainName: string;
  capabilityName: string;
  functions: RestoredFunction[];
  evidencePages: string[];
  confidence: "low" | "medium" | "high";
};

type PageSimilarity = {
  groupKey: string;
  label: string;
  pages: PageIndexItem[];
  verdict: "likely_duplicate" | "same_name_different_page" | "needs_review";
  differences: string[];
  suggestedPath: string[];
};

type RestoredModel = {
  metadata: ZipJson;
  pages: PageIndexItem[];
  navigationNodes: NavigationNode[];
  navigationEdges: NavigationEdge[];
  relationshipSeeds: RelationshipSeed[];
  structureRelations: StructureRelation[];
  clickPaths: ClickPath[];
  functions: RestoredFunction[];
  capabilities: RestoredCapability[];
  similarities: PageSimilarity[];
  suggestedStructure: SuggestedStructureNode[];
};

type SuggestedStructureNode = {
  name: string;
  children: SuggestedStructureNode[];
  pages: PageIndexItem[];
  note?: string;
};

const domainRules = [
  { domainName: "工单域", keywords: ["工单", "case", "caseid", "处理", "派单", "故障"] },
  { domainName: "资产域", keywords: ["资产", "设备", "产品", "序列号", "机器", "sn"] },
  { domainName: "保修域", keywords: ["保修", "warranty", "服务期"] },
  { domainName: "客户域", keywords: ["客户", "企业", "联系人", "电话"] },
  { domainName: "服务商域", keywords: ["服务商", "工程师", "网点"] },
  { domainName: "组织域", keywords: ["组织", "部门", "处理组", "owner"] },
  { domainName: "知识域", keywords: ["知识", "文档", "方案"] },
  { domainName: "项目域", keywords: ["项目"] },
  { domainName: "结费域", keywords: ["结费", "费用", "结算"] },
  { domainName: "任务书域", keywords: ["任务书"] },
  { domainName: "权限域", keywords: ["权限", "角色", "用户"] }
];

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalize(value = ""): string {
  return value.replace(/\s+/g, "").replace(/[：:()（）\[\]【】]/g, "").toLowerCase();
}

function uniqueText(values: string[] = []): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function overlap(left: string[] = [], right: string[] = []): number {
  const leftSet = new Set(left.map(normalize).filter(Boolean));
  const rightSet = new Set(right.map(normalize).filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let count = 0;
  leftSet.forEach((value) => {
    if (rightSet.has(value)) count += 1;
  });
  return count / Math.min(leftSet.size, rightSet.size);
}

function diffText(label: string, left: string[] = [], right: string[] = []): string | undefined {
  const leftOnly = left.filter((value) => !right.map(normalize).includes(normalize(value))).slice(0, 6);
  const rightOnly = right.filter((value) => !left.map(normalize).includes(normalize(value))).slice(0, 6);
  if (leftOnly.length === 0 && rightOnly.length === 0) return undefined;
  return `${label}差异：A有「${leftOnly.join("、") || "无"}」，B有「${rightOnly.join("、") || "无"}」`;
}

function textIncludes(source: string[], keyword: string): boolean {
  const joined = source.join(" ").toLowerCase();
  return joined.includes(keyword.toLowerCase());
}

function pathKey(page: PageIndexItem): string {
  return (page.menuPath ?? []).map(normalize).join("/");
}

function baseName(page: PageIndexItem): string {
  return normalize(page.displayName).replace(/页面|列表|详情|查询|管理|查看/g, "") || normalize(page.displayName);
}

function comparePages(left: PageIndexItem, right: PageIndexItem): PageSimilarity["verdict"] {
  const sameDisplayName = normalize(left.displayName) === normalize(right.displayName);
  const sameBaseName = baseName(left) === baseName(right);
  const samePath = pathKey(left) === pathKey(right);
  const keyOverlap = overlap(left.keyTexts, right.keyTexts);
  const objectOverlap = overlap(left.objectHints, right.objectHints);
  const bothMarked = left.duplicateInfo?.status === "suspected_duplicate" || right.duplicateInfo?.status === "suspected_duplicate";

  if ((sameDisplayName && samePath && keyOverlap >= 0.85) || (bothMarked && keyOverlap >= 0.75)) return "likely_duplicate";
  if ((sameDisplayName || sameBaseName) && (pathKey(left) !== pathKey(right) || keyOverlap < 0.75 || objectOverlap < 0.75)) return "same_name_different_page";
  return "needs_review";
}

function pageDifferences(left: PageIndexItem, right: PageIndexItem): string[] {
  return uniqueText([
    pathKey(left) !== pathKey(right) ? `菜单路径不同：A「${left.menuPath?.join(" / ") || "无"}」，B「${right.menuPath?.join(" / ") || "无"}」` : "",
    left.url && right.url && left.url !== right.url ? "URL不同，可能是不同入口或不同详情对象" : "",
    diffText("关键文本", left.keyTexts, right.keyTexts) ?? "",
    diffText("对象线索", left.objectHints, right.objectHints) ?? "",
    left.duplicateInfo?.status === "suspected_duplicate" || right.duplicateInfo?.status === "suspected_duplicate" ? "已有疑似重复标记，建议人工确认是否合并" : ""
  ]);
}

function suggestedPathForGroup(pages: PageIndexItem[]): string[] {
  const domain = inferDomain(pages[0] ?? ({ displayName: "" } as PageIndexItem));
  const object = objectName(pages[0] ?? ({ displayName: "业务对象" } as PageIndexItem));
  const action = pages.some((page) => /详情|detail|handle/i.test(page.displayName)) ? "详情查看" : pages.some((page) => /查询|列表|搜索/i.test(page.displayName)) ? "查询检索" : "功能页面";
  return [domain, object, action];
}

function buildSimilarities(pages: PageIndexItem[]): PageSimilarity[] {
  const groups = new Map<string, PageIndexItem[]>();
  pages.forEach((page) => {
    const key = baseName(page);
    groups.set(key, [...(groups.get(key) ?? []), page]);
  });

  return Array.from(groups.entries())
    .filter(([, groupPages]) => groupPages.length > 1)
    .map(([groupKey, groupPages]) => {
      const verdicts: PageSimilarity["verdict"][] = [];
      const differences: string[] = [];
      for (let index = 0; index < groupPages.length; index += 1) {
        for (let nextIndex = index + 1; nextIndex < groupPages.length; nextIndex += 1) {
          const left = groupPages[index];
          const right = groupPages[nextIndex];
          verdicts.push(comparePages(left, right));
          differences.push(...pageDifferences(left, right).map((item) => `${left.displayName} vs ${right.displayName}：${item}`));
        }
      }
      const verdict = verdicts.includes("same_name_different_page")
        ? "same_name_different_page"
        : verdicts.includes("needs_review")
          ? "needs_review"
          : "likely_duplicate";
      return {
        groupKey,
        label: groupPages[0].displayName,
        pages: groupPages,
        verdict,
        differences: uniqueText(differences).slice(0, 12),
        suggestedPath: suggestedPathForGroup(groupPages)
      };
    });
}

function buildSuggestedStructure(pages: PageIndexItem[], similarities: PageSimilarity[]): SuggestedStructureNode[] {
  const roots = new Map<string, SuggestedStructureNode>();
  const similarityByRef = new Map<string, PageSimilarity>();
  similarities.forEach((group) => group.pages.forEach((page) => similarityByRef.set(page.pageRef, group)));

  pages.forEach((page) => {
    const group = similarityByRef.get(page.pageRef);
    const path = group?.suggestedPath ?? [inferDomain(page), objectName(page), page.displayName];
    const [domain, object, action] = path;
    if (!roots.has(domain)) roots.set(domain, { name: domain, children: [], pages: [] });
    const root = roots.get(domain)!;
    let objectNode = root.children.find((child) => child.name === object);
    if (!objectNode) {
      objectNode = { name: object, children: [], pages: [] };
      root.children.push(objectNode);
    }
    let actionNode = objectNode.children.find((child) => child.name === action);
    if (!actionNode) {
      actionNode = { name: action, children: [], pages: [], note: group ? verdictText(group.verdict) : undefined };
      objectNode.children.push(actionNode);
    }
    actionNode.pages.push(page);
  });

  return Array.from(roots.values());
}

function verdictText(verdict: PageSimilarity["verdict"]): string {
  if (verdict === "likely_duplicate") return "高度重复，建议合并为一个目录节点";
  if (verdict === "same_name_different_page") return "同名但存在差异，建议拆分子节点";
  return "相似页面，建议人工确认";
}

function inferDomain(page: PageIndexItem): string {
  const sources = [page.displayName, page.title ?? "", ...(page.menuPath ?? []), ...(page.keyTexts ?? []), ...(page.objectHints ?? [])];
  return domainRules.find((rule) => rule.keywords.some((keyword) => textIncludes(sources, keyword)))?.domainName ?? "未分类域";
}

function objectName(page: PageIndexItem): string {
  const hints = page.objectHints ?? [];
  const firstHint = hints.find((hint) => hint.length <= 12);
  if (firstHint) return firstHint.replace(/域$/, "");
  if (/case/i.test(page.displayName)) return "Case";
  if (page.displayName.includes("工单")) return "工单";
  return page.displayName.replace(/查询|详情|列表|页面|管理/g, "") || "业务对象";
}

function actionFromSeed(seedName: string, seedType: string): string {
  if (seedType === "tab") return `${seedName}查看`;
  if (seedType === "table") return `${seedName}查看`;
  if (seedType === "form") return `${seedName}筛选`;
  if (seedType === "detail") return `${seedName}详情查看`;
  return seedName;
}

function buildFunctions(pages: PageIndexItem[], seeds: RelationshipSeed[]): RestoredFunction[] {
  const seedByPage = new Map(seeds.map((seed) => [seed.pageRef, seed]));
  return pages.flatMap((page) => {
    const pageSeeds = seedByPage.get(page.pageRef)?.seeds ?? [];
    const functionNames = new Set<string>();
    const evidence = new Set<string>([page.pageRef, "page-index.json"]);

    if (/查询|列表|搜索/i.test(page.displayName)) functionNames.add(`${objectName(page)}查询`);
    if (/详情|detail|handle/i.test(page.displayName)) functionNames.add(`${objectName(page)}详情查看`);

    pageSeeds
      .filter((seed) => seed.type === "tab" || seed.type === "table" || seed.type === "form" || seed.type === "detail")
      .slice(0, 12)
      .forEach((seed) => {
        functionNames.add(actionFromSeed(seed.name, seed.type));
        evidence.add("relationship-seeds.json");
      });

    if (functionNames.size === 0) functionNames.add(`${page.displayName}查看`);

    return Array.from(functionNames).map((functionName) => ({
      functionName,
      pageRef: page.pageRef,
      pageName: page.displayName,
      evidence: Array.from(evidence)
    }));
  });
}

function buildCapabilities(pages: PageIndexItem[], functions: RestoredFunction[]): RestoredCapability[] {
  const pageByRef = new Map(pages.map((page) => [page.pageRef, page]));
  const groups = new Map<string, RestoredFunction[]>();

  functions.forEach((fn) => {
    const page = pageByRef.get(fn.pageRef);
    const domainName = page ? inferDomain(page) : "未分类域";
    const capabilityName = `${page ? objectName(page) : fn.pageName}${fn.functionName.includes("查询") ? "查询" : fn.functionName.includes("详情") ? "详情查看" : "管理"}能力`;
    const key = `${domainName}::${capabilityName}`;
    groups.set(key, [...(groups.get(key) ?? []), fn]);
  });

  return Array.from(groups.entries()).map(([key, fns]) => {
    const [domainName, capabilityName] = key.split("::");
    return {
      domainName,
      capabilityName,
      functions: fns,
      evidencePages: Array.from(new Set(fns.map((fn) => fn.pageRef))),
      confidence: fns.length > 1 ? "medium" : "low"
    };
  });
}

async function readJson(zip: JSZip, path: string): Promise<ZipJson | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return JSON.parse(await file.async("string")) as ZipJson;
}

async function readPageJsons(zip: JSZip): Promise<PageIndexItem[]> {
  const files = Object.keys(zip.files).filter((path) => /^pages\/page-\d+\/page\.json$/.test(path));
  const pages = await Promise.all(
    files.map(async (path) => {
      const raw = JSON.parse(await zip.file(path)!.async("string")) as ZipJson;
      return {
        pageRef: path.replace("/page.json", ""),
        pageId: String(raw.pageId ?? path),
        displayName: String((raw.naming as { displayName?: string } | undefined)?.displayName ?? raw.title ?? raw.url ?? path),
        nameCandidates: asArray<string>((raw.naming as { candidates?: string[] } | undefined)?.candidates),
        url: String(raw.url ?? ""),
        title: String(raw.title ?? ""),
        menuPath: asArray<string>(raw.path),
        keyTexts: asArray<string>((raw.naming as { keyTexts?: string[] } | undefined)?.keyTexts),
        objectHints: asArray<string>((raw.naming as { objectHints?: string[] } | undefined)?.objectHints),
        duplicateInfo: raw.duplicateInfo as PageIndexItem["duplicateInfo"]
      };
    })
  );
  return pages;
}

async function restoreFromZip(file: File): Promise<RestoredModel> {
  const zip = await JSZip.loadAsync(file);
  const metadata = (await readJson(zip, "metadata.json")) ?? {};
  const pageIndexRaw = await readJson(zip, "page-index.json");
  const navigationRaw = await readJson(zip, "navigation-map.json");
  const seedsRaw = await readJson(zip, "relationship-seeds.json");
  const clickPathsRaw = await readJson(zip, "click-paths.json");
  const structureRelationsRaw = await readJson(zip, "structure-relations.json");
  const fallbackPages = await readPageJsons(zip);

  const pages = asArray<PageIndexItem>(pageIndexRaw).length > 0 ? asArray<PageIndexItem>(pageIndexRaw) : fallbackPages;
  const navigationNodes = asArray<NavigationNode>((navigationRaw as { nodes?: NavigationNode[] } | undefined)?.nodes);
  const navigationEdges = asArray<NavigationEdge>((navigationRaw as { edges?: NavigationEdge[] } | undefined)?.edges);
  const relationshipSeeds = asArray<RelationshipSeed>(seedsRaw);
  const structureRelations = asArray<StructureRelation>(structureRelationsRaw);
  const clickPaths = asArray<ClickPath>(clickPathsRaw);
  const functions = buildFunctions(pages, relationshipSeeds);
  const capabilities = buildCapabilities(pages, functions);
  const similarities = buildSimilarities(pages);
  const suggestedStructure = buildSuggestedStructure(pages, similarities);

  return { metadata, pages, navigationNodes, navigationEdges, relationshipSeeds, structureRelations, clickPaths, functions, capabilities, similarities, suggestedStructure };
}

function downloadJson(model: RestoredModel) {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "restored-system-model.json";
  link.click();
  URL.revokeObjectURL(url);
}

export function Analyzer() {
  const [model, setModel] = useState<RestoredModel>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleFile(file?: File) {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      setModel(await restoreFromZip(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "ZIP 解析失败");
    } finally {
      setLoading(false);
    }
  }

  const domains = useMemo(() => {
    const map = new Map<string, RestoredCapability[]>();
    (model?.capabilities ?? []).forEach((capability) => {
      map.set(capability.domainName, [...(map.get(capability.domainName) ?? []), capability]);
    });
    return Array.from(map.entries());
  }, [model]);

  return (
    <section className="restore">
      <div className="panel">
        <div className="sectionTitle">
          <h2>系统还原</h2>
          <FileArchive size={16} />
        </div>
        <label className="uploadBox">
          <Upload size={18} />
          <span>{loading ? "正在解析..." : "选择采集结果 ZIP"}</span>
          <input type="file" accept=".zip" onChange={(event) => void handleFile(event.target.files?.[0])} />
        </label>
        {error ? <p className="duplicate">{error}</p> : null}
      </div>

      {model ? (
        <>
          <section className="stats">
            <div>
              <strong>{String(model.metadata.systemName ?? "未命名")}</strong>
              <span>系统</span>
            </div>
            <div>
              <strong>{model.pages.length}</strong>
              <span>页面</span>
            </div>
            <div>
              <strong>{model.capabilities.length}</strong>
              <span>能力草稿</span>
            </div>
            <div>
              <strong>{model.structureRelations.length || model.clickPaths.length}</strong>
              <span>结构关系</span>
            </div>
          </section>

          <section className="panel">
            <div className="sectionTitle">
              <h2>功能图</h2>
              <button className="iconButton" onClick={() => downloadJson(model)} title="导出还原结果">
                <Download size={16} />
              </button>
            </div>
            <SystemTree nodes={model.navigationNodes} pages={model.pages} />
          </section>

          <section className="panel">
            <div className="sectionTitle">
              <h2>相似页面判别</h2>
              <Layers size={16} />
            </div>
            {model.similarities.length === 0 ? (
              <p className="empty">暂未发现同名或高度相似页面。</p>
            ) : (
              <div className="pageList">
                {model.similarities.map((group) => (
                  <div className="compareCard" key={group.groupKey}>
                    <div className="compareHeader">
                      <strong>{group.label}</strong>
                      <em>{verdictText(group.verdict)}</em>
                    </div>
                    <span>建议目录：{group.suggestedPath.join(" / ")}</span>
                    <div className="comparePages">
                      {group.pages.map((page) => (
                        <code key={page.pageRef}>{page.displayName}</code>
                      ))}
                    </div>
                    {group.differences.length > 0 ? (
                      <ul>
                        {group.differences.slice(0, 6).map((difference) => (
                          <li key={difference}>{difference}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>未发现明显结构差异，倾向合并。</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="sectionTitle">
              <h2>建议目录结构</h2>
              <GitBranch size={16} />
            </div>
            <SuggestedTree nodes={model.suggestedStructure} />
          </section>

          <section className="panel">
            <div className="sectionTitle">
              <h2>能力层次</h2>
              <Layers size={16} />
            </div>
            {domains.map(([domainName, capabilities]) => (
              <div className="domainBlock" key={domainName}>
                <h3>{domainName}</h3>
                {capabilities.map((capability) => (
                  <div className="capabilityItem" key={`${capability.domainName}-${capability.capabilityName}`}>
                    <strong>{capability.capabilityName}</strong>
                    <span>{capability.confidence} / {capability.evidencePages.length} 个证据页</span>
                    <ul>
                      {capability.functions.slice(0, 5).map((fn) => (
                        <li key={`${fn.pageRef}-${fn.functionName}`}>{fn.functionName}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="sectionTitle">
              <h2>页面索引</h2>
              <Network size={16} />
            </div>
            <div className="pageList">
              {model.pages.map((page) => (
                <div className="pageRow" key={page.pageRef}>
                  <strong>{page.displayName}</strong>
                  <span>{page.menuPath?.join(" / ") || "无路径"}</span>
                  {page.duplicateInfo?.status === "suspected_duplicate" ? <em>疑似重复</em> : null}
                </div>
              ))}
            </div>
          </section>

          {(model.structureRelations.length > 0 || model.clickPaths.length > 0) ? (
            <section className="panel">
              <div className="sectionTitle">
                <h2>结构入口关系</h2>
                <GitBranch size={16} />
              </div>
              <div className="pageList">
                {(model.structureRelations.length > 0 ? model.structureRelations : model.clickPaths.map((path) => ({
                  id: path.id,
                  fromPageName: path.fromPageName,
                  toPageName: path.toPageName,
                  entryName: path.clickedElement?.text || (path.trigger === "manual_capture" ? "手动补采" : "页面点击"),
                  relationType: "navigation" as const,
                  confidence: "low" as const,
                  supportCount: 1,
                  firstSeenAt: path.timestamp,
                  lastSeenAt: path.timestamp,
                  notes: path.exactDuplicateSkipped ? ["重复页面未新增证据"] : []
                }))).slice(0, 20).map((relation) => (
                  <div className="pageRow" key={relation.id}>
                    <strong>{relation.fromPageName || "起点"} → {relation.toPageName}</strong>
                    <span>入口：{relation.entryName}，{relation.supportCount} 次，置信度 {relation.confidence}</span>
                    <span>{relation.relationType === "same_page_action" ? "页内功能线索" : relation.relationType === "manual_checkpoint" ? "补采证据" : relation.relationType === "detail_entry" ? "详情入口" : "导航入口"}</span>
                    {relation.notes?.length ? <em>{relation.notes[0]}</em> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <section className="emptyState">
          <GitBranch size={28} />
          <p>上传采集结果 ZIP 后，会在这里生成系统菜单、页面、功能和能力草稿。</p>
        </section>
      )}
    </section>
  );
}

function SystemTree({ nodes, pages }: { nodes: NavigationNode[]; pages: PageIndexItem[] }) {
  if (nodes.length === 0) {
    return (
      <div className="treeList">
        {pages.map((page) => (
          <div className="treeNode pageNode" key={page.pageRef}>
            {page.menuPath?.join(" / ") || "未识别菜单"} / {page.displayName}
          </div>
        ))}
      </div>
    );
  }

  const children = new Map<string | undefined, NavigationNode[]>();
  nodes.forEach((node) => {
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  });

  function renderNode(node: NavigationNode, depth = 0) {
    return (
      <div key={node.id}>
        <div className={`treeNode ${node.type === "page" ? "pageNode" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {node.name}
        </div>
        {(children.get(node.id) ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return <div className="treeList">{(children.get(undefined) ?? children.get("system") ?? nodes.filter((node) => node.type === "system")).map((node) => renderNode(node))}</div>;
}

function SuggestedTree({ nodes }: { nodes: SuggestedStructureNode[] }) {
  function renderNode(node: SuggestedStructureNode, depth = 0) {
    return (
      <div key={`${node.name}-${depth}`}>
        <div className="treeNode" style={{ paddingLeft: 8 + depth * 14 }}>
          <strong>{node.name}</strong>
          {node.note ? <em>{node.note}</em> : null}
        </div>
        {node.children.map((child) => renderNode(child, depth + 1))}
        {node.pages.map((page) => (
          <div className="treeNode pageNode" style={{ paddingLeft: 22 + depth * 14 }} key={page.pageRef}>
            {page.displayName}
            {page.duplicateInfo?.status === "suspected_duplicate" ? <em>疑似重复</em> : null}
          </div>
        ))}
      </div>
    );
  }

  return <div className="treeList">{nodes.map((node) => renderNode(node))}</div>;
}
