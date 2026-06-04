import { Download, Pause, Play, Square, ClipboardList, RefreshCw, MousePointerClick, GitBranch, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/db";
import { buildTaskZip } from "../lib/exportZip";
import { createId } from "../lib/ids";
import type { ManualNote, PageRecord, PageTransition, ScanTask, StructureRelation, TaskInput } from "../types";
import { Analyzer } from "./Analyzer";

const emptyTask: TaskInput = {
  taskName: "",
  systemName: "",
  roleName: "",
  operator: ""
};

function now() {
  return new Date().toISOString();
}

function zipName(task: ScanTask) {
  const safeName = `${task.systemName || "system"}-${task.roleName || "role"}-${task.taskName || "scan"}`
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safeName || "capability-scan"}.zip`;
}

function pageDisplayName(page: PageRecord): string {
  return page.naming?.displayName || page.title || page.url;
}

function inferLiveDomain(page: PageRecord): string {
  const text = [pageDisplayName(page), ...page.path, ...(page.naming?.keyTexts ?? []), ...(page.naming?.objectHints ?? [])].join(" ").toLowerCase();
  if (/工单|case|派单|故障|处理/.test(text)) return "工单域";
  if (/资产|设备|产品|序列号/.test(text)) return "资产域";
  if (/客户|企业|联系人/.test(text)) return "客户域";
  if (/权限|角色|用户/.test(text)) return "权限域";
  return "未分类域";
}

function inferLiveObject(page: PageRecord): string {
  const hint = page.naming?.objectHints?.find((item) => item.length <= 12);
  if (hint) return hint;
  if (/case/i.test(pageDisplayName(page))) return "Case";
  return pageDisplayName(page).replace(/查询|详情|列表|页面|管理/g, "") || "业务对象";
}

function inferLiveAction(page: PageRecord): string {
  const name = pageDisplayName(page);
  if (/详情|detail|handle/i.test(name) || /详情|detail|handle/i.test(page.url)) return "详情查看";
  if (/查询|列表|搜索/i.test(name)) return "查询检索";
  if ((page.elements?.inputs?.length ?? 0) > 0) return "表单操作";
  if ((page.elements?.tables?.length ?? 0) > 0) return "列表查看";
  return "页面查看";
}

function normalizeRelationText(value = ""): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function liveRelationType(transition: PageTransition): StructureRelation["relationType"] {
  if (!transition.clickedElement) return "manual_checkpoint";
  if (transition.fromPageId === transition.toPageId) return "same_page_action";
  if (/detail|详情|handle|view/i.test(`${transition.toPageName} ${transition.toUrl}`)) return "detail_entry";
  return "navigation";
}

function liveEntryType(transition: PageTransition): StructureRelation["entryType"] {
  const click = transition.clickedElement;
  if (!click) return "manual";
  if (click.role === "tab" || /tab/i.test(click.selector)) return "tab";
  if (click.tagName === "a" || click.href) return "link";
  if (click.tagName === "tr" || click.tagName === "td") return "row";
  if (click.role === "menuitem" || /menu/i.test(click.selector)) return "menu";
  if (click.tagName === "button" || click.role === "button" || click.inputType === "button" || click.inputType === "submit") return "button";
  return "unknown";
}

function buildLiveStructureRelations(transitions: PageTransition[]): StructureRelation[] {
  const grouped = new Map<string, StructureRelation>();
  transitions.forEach((transition) => {
    const entryName = transition.clickedElement?.text || (transition.trigger === "manual_capture" ? "手动补采" : "未知入口");
    const relationType = liveRelationType(transition);
    const key = [transition.fromPageId || "start", transition.toPageId, normalizeRelationText(entryName), relationType].join("::");
    const existing = grouped.get(key);
    if (existing) {
      existing.supportCount += 1;
      existing.lastSeenAt = transition.timestamp;
      existing.evidenceTransitionIds.push(transition.id);
      existing.confidence = existing.supportCount > 1 && relationType !== "same_page_action" ? "high" : existing.confidence;
      return;
    }

    grouped.set(key, {
      id: `live-relation-${grouped.size + 1}`,
      taskId: transition.taskId,
      fromPageId: transition.fromPageId,
      fromPageName: transition.fromPageName,
      toPageId: transition.toPageId,
      toPageName: transition.toPageName,
      entryName,
      entryType: liveEntryType(transition),
      relationType,
      confidence: relationType === "same_page_action" || relationType === "manual_checkpoint" ? "low" : "medium",
      supportCount: 1,
      firstSeenAt: transition.timestamp,
      lastSeenAt: transition.timestamp,
      evidenceTransitionIds: [transition.id],
      notes: []
    });
  });

  return Array.from(grouped.values()).sort((left, right) => right.supportCount - left.supportCount || left.firstSeenAt.localeCompare(right.firstSeenAt));
}

async function requestActivePageCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch {
    // The script may already be injected, or the browser may block special pages.
  }

  await chrome.tabs.sendMessage(tab.id, { type: "FORCE_CAPTURE" }).catch(() => undefined);
}

export function App() {
  const [view, setView] = useState<"capture" | "restore">("capture");
  const [form, setForm] = useState<TaskInput>(emptyTask);
  const [tasks, setTasks] = useState<ScanTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string>("");
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [transitions, setTransitions] = useState<PageTransition[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const activeTaskIdRef = useRef("");

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId), [activeTaskId, tasks]);
  const selectedPage = useMemo(() => pages.find((page) => page.pageId === selectedPageId), [pages, selectedPageId]);

  async function refresh() {
    const nextTasks = await db.listTasks();
    const sortedTasks = nextTasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const nextActiveTask = sortedTasks.find((task) => task.status === "running" || task.status === "paused") ?? sortedTasks[0];
    setTasks(sortedTasks);
    setActiveTaskId((current) => current || nextActiveTask?.id || "");

    const taskForPages = sortedTasks.find((task) => task.id === (activeTaskIdRef.current || nextActiveTask?.id));
    const nextPages = taskForPages ? await db.listPages(taskForPages.id) : [];
    const nextTransitions = taskForPages ? await db.listTransitions(taskForPages.id) : [];
    setPages(nextPages);
    setTransitions(nextTransitions);
    setSelectedPageId((current) => current || nextPages[0]?.pageId || "");
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) return;
    void db.listPages(activeTaskId).then((nextPages) => {
      setPages(nextPages);
      setSelectedPageId((current) => (nextPages.some((page) => page.pageId === current) ? current : nextPages[0]?.pageId || ""));
    });
    void db.listTransitions(activeTaskId).then(setTransitions);
  }, [activeTaskId]);

  async function createTask() {
    if (!form.taskName || !form.systemName || !form.roleName || !form.operator) return;
    const task: ScanTask = {
      ...form,
      id: createId("task"),
      status: "running",
      createdAt: now(),
      startedAt: now()
    };
    await db.putTask(task);
    setForm(emptyTask);
    activeTaskIdRef.current = task.id;
    await refresh();
    setActiveTaskId(task.id);
  }

  async function updateTask(status: ScanTask["status"]) {
    if (!activeTask) return;
    const patch: Partial<ScanTask> =
      status === "running"
        ? { status, startedAt: activeTask.startedAt ?? now() }
        : status === "paused"
          ? { status, pausedAt: now() }
          : { status, endedAt: now() };
    await db.putTask({ ...activeTask, ...patch });
    await refresh();
  }

  async function exportTask() {
    if (!activeTask) return;
    setBusy(true);
    try {
      const blob = await buildTaskZip(activeTask);
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename: zipName(activeTask), saveAs: true });
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote(note: ManualNote) {
    if (!selectedPage) return;
    await db.putPage({ ...selectedPage, manualNote: note });
    await refresh();
  }

  async function deleteActiveTask() {
    if (!activeTask) return;
    const confirmed = window.confirm(`确认删除项目「${activeTask.taskName}」吗？该项目的页面、网络记录和点击路径都会被删除。`);
    if (!confirmed) return;
    await db.deleteTask(activeTask.id);
    setActiveTaskId("");
    activeTaskIdRef.current = "";
    setPages([]);
    setTransitions([]);
    setSelectedPageId("");
    await refresh();
  }

  async function clearAllTasks() {
    const confirmed = window.confirm("确认清空全部已扫描项目吗？这会删除所有本地任务、页面证据、网络记录和点击路径。");
    if (!confirmed) return;
    await db.clearAll();
    setTasks([]);
    setActiveTaskId("");
    activeTaskIdRef.current = "";
    setPages([]);
    setTransitions([]);
    setSelectedPageId("");
  }

  const completion = pages.length === 0 ? 0 : Math.round((pages.filter((page) => page.html && page.network && page.screenshotDataUrl).length / pages.length) * 100);

  return (
    <main>
      <header>
        <div>
          <h1>系统能力发现助手</h1>
          <p>点击业务页面后自动保存原始证据，再导出给外部 AI 分析。</p>
        </div>
        <button className="iconButton" onClick={() => void refresh()} title="刷新面板">
          <RefreshCw size={16} />
        </button>
      </header>

      <nav className="tabs">
        <button className={view === "capture" ? "active" : ""} onClick={() => setView("capture")}>采集</button>
        <button className={view === "restore" ? "active" : ""} onClick={() => setView("restore")}>系统还原</button>
      </nav>

      {view === "restore" ? <Analyzer /> : (
      <>
      <section className="panel">
        <h2>采集任务</h2>
        <div className="grid">
          <input placeholder="任务名称" value={form.taskName} onChange={(event) => setForm({ ...form, taskName: event.target.value })} />
          <input placeholder="系统名称" value={form.systemName} onChange={(event) => setForm({ ...form, systemName: event.target.value })} />
          <input placeholder="角色名称" value={form.roleName} onChange={(event) => setForm({ ...form, roleName: event.target.value })} />
          <input placeholder="采集员" value={form.operator} onChange={(event) => setForm({ ...form, operator: event.target.value })} />
        </div>
        <button className="primary" onClick={() => void createTask()} disabled={!form.taskName || !form.systemName || !form.roleName || !form.operator}>
          <Play size={16} />
          开始采集
        </button>
      </section>

      <section className="toolbar">
        <select value={activeTaskId} onChange={(event) => setActiveTaskId(event.target.value)}>
          <option value="">选择任务</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.systemName} / {task.roleName} / {task.taskName}
            </option>
          ))}
        </select>
        <button onClick={() => void updateTask("running")} disabled={!activeTask || activeTask.status === "running"} title="继续采集">
          <Play size={16} />
        </button>
        <button onClick={() => void updateTask("paused")} disabled={!activeTask || activeTask.status !== "running"} title="暂停采集">
          <Pause size={16} />
        </button>
        <button onClick={() => void updateTask("ended")} disabled={!activeTask || activeTask.status === "ended"} title="结束采集">
          <Square size={16} />
        </button>
        <button onClick={() => void exportTask()} disabled={!activeTask || busy} title="导出 ZIP">
          <Download size={16} />
        </button>
        <button onClick={() => void deleteActiveTask()} disabled={!activeTask} title="删除当前项目">
          <Trash2 size={16} />
        </button>
      </section>

      <button className="dangerButton" onClick={() => void clearAllTasks()} disabled={tasks.length === 0}>
        <Trash2 size={16} />
        清空全部项目
      </button>

      <button className="primary captureButton" onClick={() => void requestActivePageCapture().then(() => window.setTimeout(() => void refresh(), 1500))} disabled={!activeTask || activeTask.status !== "running"}>
        <MousePointerClick size={16} />
        手动补采当前页
      </button>

      <section className="stats">
        <div>
          <strong>{activeTask?.status ?? "idle"}</strong>
          <span>任务状态</span>
        </div>
        <div>
          <strong>{pages.length}</strong>
          <span>已采页面</span>
        </div>
        <div>
          <strong>{completion}%</strong>
          <span>证据完整率</span>
        </div>
      </section>

      <section className="panel">
        <div className="sectionTitle">
          <h2>已扫描结构</h2>
          <GitBranch size={16} />
        </div>
        <ScannedStructure pages={pages} transitions={transitions} />
      </section>

      <section className="panel">
        <div className="sectionTitle">
          <h2>页面证据</h2>
          <ClipboardList size={16} />
        </div>
        <select value={selectedPageId} onChange={(event) => setSelectedPageId(event.target.value)}>
          <option value="">选择页面</option>
          {pages.map((page, index) => (
            <option key={page.pageId} value={page.pageId}>
              {String(index + 1).padStart(3, "0")} - {pageDisplayName(page)}
            </option>
          ))}
        </select>
        {selectedPage ? <PageDetail page={selectedPage} onSave={saveNote} /> : <p className="empty">打开目标系统页面后，采集结果会自动出现在这里。</p>}
      </section>
      </>
      )}
    </main>
  );
}

function ScannedStructure({ pages, transitions }: { pages: PageRecord[]; transitions: PageTransition[] }) {
  if (pages.length === 0) return <p className="empty">开始采集后，在业务页面点击菜单、按钮或链接，这里会生成系统结构。</p>;

  const pageById = new Map(pages.map((page) => [page.pageId, page]));
  const structureRelations = buildLiveStructureRelations(transitions);
  const roots = new Map<string, { name: string; children: Map<string, PageRecord[]> }>();

  pages.forEach((page) => {
    const manualPath = page.manualNote?.manualPath
      ?.split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const path = manualPath?.length ? manualPath : page.path;
    const rootName = path[0] || inferLiveDomain(page);
    const branchName = path.slice(1).join(" / ") || `${inferLiveObject(page)} / ${inferLiveAction(page)}`;
    if (!roots.has(rootName)) roots.set(rootName, { name: rootName, children: new Map() });
    const root = roots.get(rootName)!;
    root.children.set(branchName, [...(root.children.get(branchName) ?? []), page]);
  });

  return (
    <div className="mindmap">
      {Array.from(roots.values()).map((root) => (
        <div className="mindRoot" key={root.name}>
          <strong>{root.name}</strong>
          {Array.from(root.children.entries()).map(([branchName, branchPages]) => (
            <div className="mindBranch" key={`${root.name}-${branchName}`}>
              <span>{branchName}</span>
              {branchPages.map((page) => (
                <div className="mindLeaf" key={page.pageId}>
                  {pageDisplayName(page)}
                  {page.duplicateInfo?.status === "suspected_duplicate" ? <em>疑似重复</em> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
      {transitions.length > 0 ? (
        <div className="clickPaths">
          <strong>结构入口</strong>
          {structureRelations.slice(0, 8).map((relation) => {
            const fromPage = relation.fromPageId ? pageById.get(relation.fromPageId) : undefined;
            return (
              <p key={relation.id}>
                {fromPage ? pageDisplayName(fromPage) : relation.fromPageName || "起点"} → {relation.toPageName}
                {relation.entryName ? `（入口：${relation.entryName}）` : ""}
                {relation.supportCount > 1 ? ` ×${relation.supportCount}` : ""}
                {relation.relationType === "same_page_action" ? "（页内功能线索）" : ""}
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PageDetail({ page, onSave }: { page: PageRecord; onSave: (note: ManualNote) => Promise<void> }) {
  const [note, setNote] = useState<ManualNote>(page.manualNote ?? { purpose: "", userRole: "", importance: "", manualPath: "" });

  useEffect(() => {
    setNote(page.manualNote ?? { purpose: "", userRole: "", importance: "", manualPath: "" });
  }, [page.pageId]);

  return (
    <div className="detail">
      <div className="evidence">
        <span>HTML {page.html ? "已保存" : "缺失"}</span>
        <span>截图 {page.screenshotDataUrl ? "已保存" : "待补采"}</span>
        <span>Network {page.network.length} 条</span>
        <span>{page.duplicateInfo?.status === "suspected_duplicate" ? "疑似重复" : "唯一页面"}</span>
      </div>
      {page.duplicateInfo?.status === "suspected_duplicate" ? (
        <p className="duplicate">疑似重复于：{page.duplicateInfo.canonicalPageName ?? page.duplicateInfo.canonicalPageId}</p>
      ) : null}
      {page.click ? (
        <p className="path">触发点击：{page.click.text}（{page.click.tagName}）</p>
      ) : null}
      <p className="url">{page.url}</p>
      <p className="path">{page.path.length ? page.path.join(" / ") : "菜单路径待人工补充"}</p>
      <textarea placeholder="人工菜单路径，例如：首页 / 工单管理 / 工单查询" value={note.manualPath ?? ""} onChange={(event) => setNote({ ...note, manualPath: event.target.value })} />
      <textarea placeholder="页面用途" value={note.purpose} onChange={(event) => setNote({ ...note, purpose: event.target.value })} />
      <textarea placeholder="用户角色" value={note.userRole} onChange={(event) => setNote({ ...note, userRole: event.target.value })} />
      <textarea placeholder="重要程度" value={note.importance} onChange={(event) => setNote({ ...note, importance: event.target.value })} />
      <button className="primary" onClick={() => void onSave(note)}>保存备注</button>
    </div>
  );
}
