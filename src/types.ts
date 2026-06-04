export type TaskStatus = "idle" | "running" | "paused" | "ended";

export interface TaskInput {
  taskName: string;
  systemName: string;
  roleName: string;
  operator: string;
}

export interface ScanTask extends TaskInput {
  id: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  pausedAt?: string;
  endedAt?: string;
}

export interface NetworkEntry {
  id: string;
  pageId?: string;
  tabId?: number;
  url: string;
  method: string;
  status?: number | "";
  type: "fetch" | "xhr";
  timestamp: string;
}

export interface ManualNote {
  purpose: string;
  userRole: string;
  importance: string;
  manualPath?: string;
}

export interface PageElements {
  buttons: string[];
  inputs: string[];
  tables: Array<{
    caption?: string;
    columnHeaders: string[];
    rowCount: number;
  }>;
  labels: string[];
}

export interface PageNaming {
  displayName: string;
  candidates: string[];
  keyTexts: string[];
  objectHints: string[];
}

export interface PageRelationSeed {
  type: "navigation" | "detail" | "tab" | "table" | "form" | "api";
  name: string;
  targetHint?: string;
  evidence: string;
}

export interface ClickEvidence {
  text: string;
  tagName: string;
  role?: string;
  selector: string;
  href?: string;
  ariaLabel?: string;
  title?: string;
  inputType?: string;
  coordinates?: {
    x: number;
    y: number;
  };
}

export interface PageDuplicateInfo {
  status: "unique" | "suspected_duplicate";
  exactFingerprint: string;
  structuralFingerprint: string;
  duplicateGroupId?: string;
  canonicalPageId?: string;
  canonicalPageName?: string;
  confidence?: "low" | "medium" | "high";
  reasons: string[];
}

export interface PageTransition {
  id: string;
  taskId: string;
  tabId?: number;
  fromPageId?: string;
  fromPageName?: string;
  fromUrl?: string;
  toPageId: string;
  toPageName: string;
  toUrl: string;
  timestamp: string;
  trigger: "manual_capture" | "page_click";
  clickedElement?: ClickEvidence;
  exactDuplicateSkipped?: boolean;
}

export interface PageRecord {
  pageId: string;
  taskId: string;
  tabId?: number;
  url: string;
  title: string;
  timestamp: string;
  path: string[];
  html: string;
  screenshotDataUrl?: string;
  elements: PageElements;
  naming: PageNaming;
  relationSeeds: PageRelationSeed[];
  duplicateInfo: PageDuplicateInfo;
  network: NetworkEntry[];
  click?: ClickEvidence;
  manualNote?: ManualNote;
  evidenceVersion: "raw-v1";
  derivedVersion: "derived-v1";
}

export type ExtensionMessage =
  | { type: "PAGE_CAPTURE"; payload: Omit<PageRecord, "taskId" | "screenshotDataUrl" | "network" | "duplicateInfo" | "evidenceVersion" | "derivedVersion"> }
  | { type: "NETWORK_CAPTURE"; payload: Omit<NetworkEntry, "id" | "timestamp"> }
  | { type: "FORCE_CAPTURE" }
  | { type: "GET_TASK_STATE" };
