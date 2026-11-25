import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type {
  ArtifactRecord,
  LibraryNode,
  LibraryNodeKind,
  LibraryRoot,
  LibraryTreeNode,
  LocalProject,
  MemoryRecord,
  SkillRecord,
  SourceConnection,
  SourceItem,
  TaskRecord
} from "@hearth/core";
import type { HearthStore, McpServerRecord } from "@hearth/eventlog";
import { isSensitivePath } from "./paths.ts";
import { LibraryRepository } from "./repository.ts";

const MAX_SCANNED_ENTRIES = 20_000;

const ROOT_REFS = {
  memory: "hearth://root/memory",
  task: "hearth://root/task",
  resource: "hearth://root/resource",
  skill: "hearth://root/skill",
  mcp: "hearth://root/mcp",
  project: "hearth://root/project"
} as const;

export class LibraryTreeService {
  readonly repository: LibraryRepository;
  private readonly store: HearthStore;

  constructor(store: HearthStore) {
    this.store = store;
    this.repository = new LibraryRepository(store);
  }

  syncAll(): { nodes: number } {
    this.ensureRoots();
    const memories = this.store.listMemories({ limit: 10_000 });
    const memoryRefs = new Set(
      memories
        .filter((memory) => memory.status !== "forgotten")
        .map((memory) => refFor("memory", memory.id))
    );
    for (const node of this.repository.listNodes({ kind: "memory", limit: 10_000 })) {
      if (!memoryRefs.has(node.ref)) this.repository.deleteNode(node.id);
    }
    for (const memory of memories) {
      if (memory.status !== "forgotten") this.syncMemory(memory);
    }
    for (const task of this.store.listTasks({ includeDeleted: false })) {
      this.syncTask(task);
      for (const artifact of this.store.listArtifacts(task.id)) this.syncArtifact(artifact);
    }
    for (const source of this.store.listSources()) {
      this.syncSource(source);
      for (const item of this.store.listSourceItems(source.id)) this.syncSourceItem(item);
    }
    for (const project of this.store.listLocalProjects()) this.syncProject(project);
    for (const skill of this.store.listSkills()) this.syncSkill(skill);
    for (const server of this.store.listMcpServers()) this.syncMcpServer(server);
    this.syncFileRoots();
    return { nodes: this.repository.countNodes() };
  }

  ensureRoots(): LibraryNode[] {
    return [
      this.ensureRoot("memory", "记忆", "记忆"),
      this.ensureRoot("task", "任务", "任务"),
      this.ensureRoot("resource", "资料", "资料"),
      this.ensureRoot("skill", "技能", "技能"),
      this.ensureRoot("mcp", "MCP", "MCP"),
      this.ensureRoot("project", "项目", "项目")
    ];
  }

  syncMemory(memory: MemoryRecord): LibraryNode {
    const root = this.ensureRoot("memory", "记忆", "记忆");
    const status = memoryStatusLabel(memory.status);
    const statusFolder = this.ensureFolder(
      root.id,
      `hearth://folder/memory-status-${memory.status}`,
      joinPath(root.path, status),
      status
    );
    const kind = kindLabel(memory.kind);
    const kindFolder = this.ensureFolder(
      statusFolder.id,
      `hearth://folder/memory-status-${memory.status}-kind-${memory.kind}`,
      joinPath(statusFolder.path, kind),
      kind
    );
    const title = clipLine(memory.subjectKey || firstLine(memory.content) || kindLabel(memory.kind));
    const path = joinPath(kindFolder.path, withSuffix(title, memory.id));
    return this.repository.upsertNode(this.node({
      kind: "memory",
      refId: memory.id,
      parentId: kindFolder.id,
      path,
      title,
      contentHash: memory.contentHash,
      sizeBytes: Buffer.byteLength(memory.content, "utf8"),
      mimeType: "text/plain",
      sensitivity: memory.sensitivity,
      metadata: {
        memoryId: memory.id,
        memoryKind: memory.kind,
        status: memory.status,
        tags: memory.tags,
        trust: memory.trust,
        taint: memory.taint,
        importance: memory.importance,
        content: memory.content
      },
      updatedAt: memory.updatedAt
    }));
  }

  syncTask(task: TaskRecord): LibraryNode {
    const root = this.ensureRoot("task", "任务", "任务");
    const group = taskStatusGroup(task.status);
    const groupFolder = this.ensureFolder(
      root.id,
      `hearth://folder/task-status-${group}`,
      joinPath(root.path, group),
      group
    );
    const title = clipLine(task.title);
    const path = joinPath(groupFolder.path, withSuffix(title, task.id));
    return this.repository.upsertNode(this.node({
      kind: "task",
      refId: task.id,
      parentId: groupFolder.id,
      path,
      title,
      projectId: task.projectId ?? null,
      contentHash: hash(`${task.title}\n${task.goal}\n${task.resultSummary ?? ""}`),
      sizeBytes: Buffer.byteLength(`${task.goal}\n${task.resultSummary ?? ""}`, "utf8"),
      mimeType: "text/markdown",
      metadata: {
        taskId: task.id,
        status: task.status,
        projectId: task.projectId ?? null,
        executorId: task.executorId ?? null,
        goal: task.goal,
        resultSummary: task.resultSummary ?? null
      },
      updatedAt: task.updatedAt
    }));
  }

  syncSource(source: SourceConnection): LibraryNode {
    const root = this.ensureRoot("resource", "资料", "资料");
    const sourcesFolder = this.ensureFolder(
      root.id,
      "hearth://folder/resources-sources",
      joinPath(root.path, "来源"),
      "来源"
    );
    const title = clipLine(source.displayName);
    const path = joinPath(sourcesFolder.path, withSuffix(title, source.id));
    return this.repository.upsertNode(this.node({
      kind: "source",
      refId: source.id,
      parentId: sourcesFolder.id,
      path,
      title,
      contentHash: hash(`${source.provider}\n${source.displayName}\n${source.status}`),
      mimeType: "application/json",
      metadata: {
        sourceId: source.id,
        sourceKind: source.kind,
        provider: source.provider,
        status: source.status,
        itemCount: source.itemCount
      },
      updatedAt: source.updatedAt
    }));
  }

  syncSourceItem(item: SourceItem): LibraryNode {
    const source = this.store.getSource(item.sourceId);
    if (!source) throw new Error(`source ${item.sourceId} disappeared`);
    const parent = this.syncSource(source);
    const title = clipLine(item.title || item.label || item.itemKey);
    const path = joinPath(parent.path, withSuffix(title, item.id));
    return this.repository.upsertNode(this.node({
      kind: "source",
      refId: item.id,
      parentId: parent.id,
      path,
      title,
      contentHash: item.contentHash,
      sizeBytes: item.bytes,
      mimeType: "text/markdown",
      metadata: {
        sourceId: item.sourceId,
        sourceItemId: item.id,
        itemKey: item.itemKey,
        locator: item.locator,
        status: item.status,
        coverage: item.coverage
      },
      updatedAt: item.fetchedAt
    }));
  }

  syncArtifact(artifact: ArtifactRecord): LibraryNode {
    const task = this.store.getTask(artifact.taskId);
    const taskTitle = task?.title ?? artifact.taskId;
    const resourceRoot = this.ensureRoot("resource", "资料", "资料");
    const artifactsFolder = this.ensureFolder(
      resourceRoot.id,
      "hearth://folder/resources-artifacts",
      joinPath(resourceRoot.path, "产物"),
      "产物"
    );
    const folder = this.ensureFolder(
      artifactsFolder.id,
      `hearth://folder/artifacts-${artifact.taskId}`,
      joinPath(artifactsFolder.path, withSuffix(clipLine(taskTitle), artifact.taskId)),
      clipLine(taskTitle)
    );
    const title = clipLine(basename(artifact.relativePath));
    return this.repository.upsertNode(this.node({
      kind: "artifact",
      refId: artifact.id,
      parentId: folder.id,
      path: joinPath(folder.path, title),
      title,
      projectId: task?.projectId ?? null,
      contentHash: artifact.sha256,
      sizeBytes: artifact.bytes,
      mimeType: artifact.mimeType,
      metadata: {
        artifactId: artifact.id,
        taskId: artifact.taskId,
        runId: artifact.runId,
        relativePath: artifact.relativePath,
        absolutePath: artifact.absolutePath
      },
      updatedAt: artifact.createdAt
    }));
  }

  ensureHandoffFolder(): LibraryNode {
    const root = this.ensureRoot("resource", "资料", "资料");
    return this.ensureFolder(root.id, "hearth://folder/handoffs", joinPath(root.path, "交接"), "交接");
  }

  syncHandoff(input: {
    handoffId: string;
    title: string;
    markdownPath: string;
    archivePath: string | null;
    memoryCount: number;
    contentHash: string;
    sizeBytes: number;
    createdAt: string;
  }): LibraryNode {
    const folder = this.ensureHandoffFolder();
    return this.repository.upsertNode(this.node({
      kind: "artifact",
      refId: `handoff-${input.handoffId}`,
      parentId: folder.id,
      path: joinPath(folder.path, withSuffix(input.title, input.handoffId)),
      title: clipLine(input.title),
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      mimeType: "text/markdown",
      metadata: {
        handoff: true,
        handoffId: input.handoffId,
        absolutePath: input.markdownPath,
        archivePath: input.archivePath,
        memoryCount: input.memoryCount,
        generatedAt: input.createdAt
      },
      updatedAt: input.createdAt
    }));
  }

  syncProject(project: LocalProject): LibraryNode {
    const root = this.ensureRoot("project", "项目", "项目");
    const title = clipLine(project.name);
    return this.repository.upsertNode(this.node({
      kind: "project",
      refId: project.id,
      parentId: root.id,
      path: joinPath(root.path, withSuffix(title, project.id)),
      title,
      projectId: project.id,
      contentHash: hash(`${project.name}\n${project.path}`),
      mimeType: "inode/directory",
      metadata: { projectId: project.id, name: project.name, path: project.path, defaultBranch: project.defaultBranch },
      updatedAt: project.updatedAt
    }));
  }

  syncSkill(skill: SkillRecord): LibraryNode {
    const root = this.ensureRoot("skill", "技能", "技能");
    const title = clipLine(skill.name);
    return this.repository.upsertNode(this.node({
      kind: "skill",
      refId: skill.id,
      parentId: root.id,
      path: joinPath(root.path, withSuffix(title, skill.id)),
      title,
      contentHash: skill.contentHash,
      mimeType: "text/markdown",
      metadata: {
        skillId: skill.id,
        version: skill.version,
        status: skill.status,
        description: skill.manifest.description,
        path: skill.path
      },
      updatedAt: skill.updatedAt
    }));
  }

  removeSkill(skillId: string): void {
    const node = this.repository.getNodeByRef(`hearth://skill/${skillId}`);
    if (node) this.repository.deleteNode(node.id);
  }

  syncMcpServer(server: McpServerRecord): LibraryNode {
    const root = this.ensureRoot("mcp", "MCP", "MCP");
    const title = clipLine(server.name);
    const endpoint = server.transport === "streamable-http" ? server.url ?? "" : [server.command, ...server.args].join(" ");
    return this.repository.upsertNode(this.node({
      kind: "mcp",
      refId: server.id,
      parentId: root.id,
      path: joinPath(root.path, withSuffix(title, server.id)),
      title,
      contentHash: hash([
        server.name,
        server.transport,
        endpoint,
        server.status,
        server.enabled ? "enabled" : "disabled",
        server.tools.map((tool) => tool.name).join(",")
      ].join("\n")),
      mimeType: "application/json",
      metadata: {
        mcpServerId: server.id,
        transport: server.transport,
        endpoint,
        status: server.status,
        enabled: server.enabled,
        registryServerId: server.registryServerId,
        registryName: server.registryName,
        packageName: server.packageName,
        packageVersion: server.packageVersion,
        runtime: server.runtime,
        tools: server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description
        })),
        error: server.error
      },
      updatedAt: server.updatedAt
    }));
  }

  removeMcpServer(serverId: string): void {
    const node = this.repository.getNodeByRef(`hearth://mcp/${serverId}`);
    if (node) this.repository.deleteNode(node.id);
  }

  buildTree(depth = 1, parentId: string | null = null): LibraryTreeNode[] {
    this.ensureRoots();
    const nodes = this.repository.listChildren(parentId);
    if (parentId === null) {
      const order = ["记忆", "任务", "资料", "技能", "MCP", "项目"];
      nodes.sort((left, right) => order.indexOf(left.title) - order.indexOf(right.title));
    }
    return nodes.map((node) => this.treeNode(node, depth));
  }

  getNode(id: string): LibraryNode | null {
    return this.repository.getNode(id);
  }

  getNodeByRef(ref: string): LibraryNode | null {
    return this.repository.getNodeByRef(ref);
  }

  getNodeByPath(path: string): LibraryNode | null {
    const row = this.store.db.prepare("SELECT * FROM context_nodes WHERE path = ? AND trashed_at IS NULL").get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.repository.getNode(String(row.id));
  }

  listChildren(id: string): LibraryNode[] {
    return this.repository.listChildren(id);
  }

  listRoots(): LibraryRoot[] {
    return this.repository.listRoots();
  }

  addRoot(path: string, options: { projectId?: string | null } = {}): LibraryRoot {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error("这个文件夹不存在");
    const stat = statSync(absolute);
    const now = new Date().toISOString();
    const existing = this.repository.listRoots().find((root) => resolve(root.path) === absolute);
    const root: LibraryRoot = existing ?? {
      id: randomUUID(),
      path: absolute,
      kind: stat.isDirectory() ? "folder" : "file",
      projectId: options.projectId ?? null,
      recursive: stat.isDirectory(),
      includeGlobs: [],
      excludeGlobs: [],
      lastScanAt: null,
      status: "ready",
      error: null,
      createdAt: now,
      updatedAt: now
    };
    const saved = this.repository.upsertRoot({ ...root, status: "ready", error: null, updatedAt: now });
    this.syncFileRoot(saved);
    return saved;
  }

  removeRoot(id: string): boolean {
    const root = this.repository.listRoots().find((candidate) => candidate.id === id);
    if (!root) return false;
    const node = this.repository.getNodeByRef(`hearth://folder/files-root-${id}`);
    if (node) this.repository.hideNode(node, "folder_removed");
    this.repository.deleteRoot(root.path);
    return true;
  }

  syncFileRoots(): void {
    for (const root of this.repository.listRoots()) this.syncFileRoot(root);
  }

  private syncFileRoot(root: LibraryRoot): void {
    try {
      if (!existsSync(root.path)) throw new Error("文件夹已不存在");
      const resourceRoot = this.ensureRoot("resource", "资料", "资料");
      const filesRoot = this.ensureFolder(resourceRoot.id, "hearth://folder/files", "资料/文件", "文件");
      const title = clipLine(basename(root.path) || root.path);
      const path = joinPath(filesRoot.path, withSuffix(title, root.id));
      const stat = statSync(root.path);
      if (root.kind === "file") {
        this.syncFileEntry(root, filesRoot, root.path, title, path, stat);
      } else {
        const folder = this.ensureFolder(filesRoot.id, `hearth://folder/files-root-${root.id}`, path, title);
        this.walkFileRoot(root, folder, root.path, "", { count: 0 });
      }
      this.repository.upsertRoot({ ...root, status: "ready", error: null, lastScanAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } catch (error) {
      this.repository.upsertRoot({
        ...root,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
    }
  }

  private walkFileRoot(root: LibraryRoot, parent: LibraryNode, absoluteDir: string, relativeDir: string, state: { count: number }): void {
    if (state.count >= MAX_SCANNED_ENTRIES) return;
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (state.count >= MAX_SCANNED_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(absoluteDir, entry.name);
      if (isSensitivePath(absolute)) continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const nodePath = joinPath(parent.path, clipLine(entry.name));
      state.count += 1;
      if (entry.isDirectory()) {
        const folder = this.ensureFileNode(root, "folder", `dir:${rel}`, parent.id, nodePath, entry.name, absolute, rel, null);
        this.walkFileRoot(root, folder, absolute, rel, state);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(absolute);
      this.syncFileEntry(root, parent, absolute, entry.name, nodePath, stat);
    }
  }

  private syncFileEntry(root: LibraryRoot, parent: LibraryNode, absolute: string, title: string, path: string, stat: Stats): LibraryNode {
    const rel = relative(root.path, absolute).replace(/\\/g, "/");
    return this.ensureFileNode(root, "file", `file:${rel}`, parent.id, path, title, absolute, rel, stat);
  }

  private ensureFileNode(
    root: LibraryRoot,
    kind: "file" | "folder",
    refId: string,
    parentId: string,
    path: string,
    title: string,
    absolute: string,
    rel: string,
    stat: Stats | null
  ): LibraryNode {
    const node = this.node({
      kind,
      refId: `${root.id}:${refId}`,
      parentId,
      path,
      title: clipLine(title),
      projectId: root.projectId,
      mimeType: kind === "folder" ? "inode/directory" : mimeFor(title),
      sizeBytes: stat?.isFile() ? stat.size : null,
      contentHash: stat ? hash(`${stat.size}:${stat.mtimeMs}`) : null,
      metadata: {
        rootId: root.id,
        absolutePath: absolute,
        relativePath: rel,
        extension: kind === "file" ? extname(title).toLowerCase() : null
      },
      updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString()
    });
    return this.repository.upsertNode({ ...node, ref: `hearth://${kind}/${root.id}/${hash(refId).slice(0, 20)}` });
  }

  treeNode(node: LibraryNode, remainingDepth: number): LibraryTreeNode {
    const children = remainingDepth > 1 ? this.repository.listChildren(node.id).map((child) => this.treeNode(child, remainingDepth - 1)) : undefined;
    const childCount = children?.length ?? this.repository.listChildren(node.id, { limit: 5_000 }).length;
    const summary = this.repository.getSummary(node.id, 1);
    return {
      ...node,
      childCount,
      summary: summary && !summary.stale ? summary.content : null,
      ...(children ? { children } : {})
    };
  }

  private node(input: {
    kind: LibraryNodeKind;
    refId: string;
    parentId: string | null;
    path: string;
    title: string;
    projectId?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    contentHash?: string | null;
    sensitivity?: LibraryNode["sensitivity"];
    metadata?: Record<string, unknown>;
    updatedAt?: string;
  }): LibraryNode {
    const now = new Date().toISOString();
    return {
      id: nodeId(input.kind, input.refId),
      ref: refFor(input.kind, input.refId),
      kind: input.kind,
      refId: input.refId,
      parentId: input.parentId,
      path: input.path,
      title: input.title,
      projectId: input.projectId ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      contentHash: input.contentHash ?? null,
      status: "ready",
      sensitivity: input.sensitivity ?? "normal",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
      trashedAt: null
    };
  }

  private ensureRoot(kind: "memory" | "task" | "resource" | "skill" | "mcp" | "project", title: string, path: string): LibraryNode {
    const ref = ROOT_REFS[kind];
    const existing = this.repository.getNodeByRef(ref);
    if (existing) return existing;
    return this.repository.upsertNode(this.node({
      kind: "root",
      refId: kind,
      parentId: null,
      path,
      title,
      mimeType: "inode/directory",
      metadata: { rootKind: kind }
    }));
  }

  private ensureFolder(parentId: string, ref: string, path: string, title: string): LibraryNode {
    const existing = this.repository.getNodeByRef(ref);
    if (existing) {
      if (existing.parentId !== parentId || existing.path !== path || existing.title !== title) {
        return this.repository.updateNode(existing.id, {
          parentId,
          path,
          title,
          updatedAt: new Date().toISOString()
        }) ?? existing;
      }
      return existing;
    }
    return this.repository.upsertNode({
      ...this.node({ kind: "folder", refId: ref.replace("hearth://folder/", ""), parentId, path, title, mimeType: "inode/directory" }),
      ref
    });
  }
}

function nodeId(kind: LibraryNodeKind, refId: string): string {
  return hash(`${kind}:${refId}`).slice(0, 32);
}

function refFor(kind: LibraryNodeKind, refId: string): string {
  return `hearth://${kind}/${refId}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function joinPath(...parts: string[]): string {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function withSuffix(title: string, id: string): string {
  return `${clipLine(title)}-${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 10) || hash(id).slice(0, 8)}`;
}

function clipLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return line || "未命名";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0] ?? "";
}

function kindLabel(kind: string): string {
  return ({ fact: "事实", preference: "偏好", project: "项目", commitment: "承诺", experience: "经验", method: "方法" } as Record<string, string>)[kind] ?? kind;
}

function memoryStatusLabel(status: string): string {
  return ({ candidate: "待确认", active: "已记住", conflict: "有冲突", superseded: "已替代", forgotten: "已遗忘" } as Record<string, string>)[status] ?? status;
}

function taskStatusGroup(status: string): string {
  if (["running", "queued"].includes(status)) return "进行中";
  if (["waiting_input", "waiting_approval", "waiting_budget"].includes(status)) return "等待";
  if (status === "completed") return "已完成";
  if (status === "failed" || status === "recoverable") return "失败";
  return "其他";
}

function mimeFor(name: string): string | null {
  return ({
    ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
    ".json": "application/json", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
    ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  } as Record<string, string>)[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export { nodeId, refFor };

