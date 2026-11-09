import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommit,
  Loader2,
  MinusCircle,
  RefreshCw,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatTime } from "../lib/format.ts";
import type { GitCheckSummary, GitDiffScope, GitFileChange, GitFileStatus, GitPullRequestView } from "../lib/types.ts";

interface TaskGitPanelProps {
  taskId: string;
}

export function TaskGitPanel({ taskId }: TaskGitPanelProps) {
  const [scope, setScope] = useState<GitDiffScope | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; fromHead: boolean } | null>(null);
  const gitQuery = useQuery({
    queryKey: ["task-git", taskId],
    queryFn: () => api.gitView(taskId),
    refetchInterval: 8_000,
    retry: false
  });
  const view = gitQuery.data;
  const activeScope = scope ?? view?.filesScope ?? "working";
  const diffQuery = useQuery({
    queryKey: ["task-git-diff", taskId, activeScope, selectedPath],
    queryFn: () => api.gitDiff(taskId, activeScope, selectedPath ?? undefined),
    enabled: Boolean(view?.available),
    retry: false
  });
  const fileQuery = useQuery({
    queryKey: ["task-git-file", taskId, preview?.path, preview?.fromHead],
    queryFn: () => api.gitFile(taskId, preview?.path ?? "", preview?.fromHead ?? false),
    enabled: Boolean(preview),
    retry: false
  });

  if (gitQuery.isLoading) {
    return <section className="panel git-panel"><div className="git-loading"><Loader2 size={15} className="spin" /> 正在读取任务仓库</div></section>;
  }
  if (gitQuery.isError) {
    return (
      <section className="panel git-panel">
        <div className="panel-head"><h2>代码改动</h2></div>
        <div className="git-empty">
          <XCircle size={17} />
          <div><strong>无法读取 Git 工作区</strong><p>{gitQuery.error instanceof Error ? gitQuery.error.message : "未知错误"}</p></div>
        </div>
      </section>
    );
  }
  if (!view) return null;
  if (!view.available) {
    return (
      <section className="panel git-panel">
        <div className="panel-head">
          <h2>代码改动</h2>
          <span className="panel-meta">Git 工作台</span>
        </div>
        <div className="git-empty">
          <GitBranch size={17} />
          <div><strong>这个任务没有可用的 Git 仓库</strong><p>{view.reason ?? "工作区中没有 .git 目录。"}</p></div>
        </div>
      </section>
    );
  }

  const activeFiles = activeScope === "branch" ? view.branchFiles : view.files;
  const activeAdditions = activeScope === "branch" ? view.branchAdditions : view.additions;
  const activeDeletions = activeScope === "branch" ? view.branchDeletions : view.deletions;
  const selectedFile = activeFiles.find((file) => file.path === selectedPath) ?? null;
  const selectedDiff = selectedPath ? diffQuery.data : null;

  function selectScope(next: GitDiffScope) {
    setScope(next);
    setSelectedPath(null);
    setPreview(null);
  }

  function selectFile(file: GitFileChange) {
    setSelectedPath(file.path);
    setPreview(null);
  }

  function openPreview(path: string, fromHead: boolean) {
    setPreview({ path, fromHead });
  }

  return (
    <section className="panel git-panel">
      <div className="panel-head">
        <h2>代码改动</h2>
        <div className="git-head-actions">
          <span className="panel-meta">{view.repo ?? "任务仓库"}</span>
          <button className="icon-button" onClick={() => void gitQuery.refetch()} disabled={gitQuery.isFetching} title="刷新 Git 状态">
            <RefreshCw size={13} className={gitQuery.isFetching ? "spin" : ""} />
          </button>
        </div>
      </div>
      <div className="git-body">
        <div className="git-summary-row">
          <span className="git-branch"><GitBranch size={14} /> {view.branch || "detached"}</span>
          <span className="git-base">相对 {view.base ?? "基线"}</span>
          <span className="git-counts"><strong className="add">+{activeAdditions}</strong><strong className="del">-{activeDeletions}</strong></span>
          <span className={`git-clean ${(activeScope === "working" ? view.clean : activeFiles.length === 0) ? "clean" : "dirty"}`}>
            {activeScope === "working"
              ? view.clean ? "工作区干净" : `${view.files.length} 个文件有改动`
              : activeFiles.length === 0 ? "没有分支改动" : `${view.branchFiles.length} 个分支文件有改动`}
          </span>
          {view.commitsAhead > 0 && <span className="git-ahead">领先 {view.commitsAhead} 个提交</span>}
        </div>

        <div className="git-main">
          <aside className="git-files">
            <div className="git-scope-toggle" role="group" aria-label="Diff 范围">
              <button className={activeScope === "working" ? "active" : ""} onClick={() => selectScope("working")}>工作区</button>
              <button className={activeScope === "branch" ? "active" : ""} onClick={() => selectScope("branch")} disabled={!view.baseSha}>相对基线</button>
            </div>
            <p className="git-file-caption">
              {activeScope === "working" ? "未提交改动" : `相对 origin/${view.base ?? "base"} 的分支改动`}
            </p>
            {activeFiles.length === 0 ? (
              <p className="git-no-files">{activeScope === "working" ? "没有未提交改动。" : "没有相对基线的分支改动。"}</p>
            ) : (
              <ul className="git-file-list">
                <li>
                  <button className={`git-file-all ${selectedPath === null ? "active" : ""}`} onClick={() => setSelectedPath(null)}>
                    <FileText size={13} /> 全部改动
                  </button>
                </li>
                {activeFiles.map((file) => (
                  <li key={`${file.oldPath ?? ""}:${file.path}`}>
                    <button className={`git-file-item ${selectedPath === file.path ? "active" : ""}`} onClick={() => selectFile(file)}>
                      <span className={`git-file-status ${file.status}`}>{statusLetter(file.status)}</span>
                      <span className="git-file-path" title={file.path}>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                      <span className="git-file-stats">
                        {file.binary ? "bin" : <><em className="add">+{file.additions}</em><em className="del">-{file.deletions}</em></>}
                      </span>
                    </button>
                    <button className="git-file-open" onClick={() => openPreview(file.path, file.status === "deleted")} title="查看文件内容">
                      <ExternalLink size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {view.commits.length > 0 && (
              <div className="git-commits">
                <h3><GitCommit size={13} /> {view.commits.length} 个提交</h3>
                <ul>
                  {view.commits.map((commit) => (
                    <li key={commit.sha}>
                      <span className="git-commit-sha">{commit.shortSha}</span>
                      <span className="git-commit-subject" title={commit.subject}>{commit.subject}</span>
                      <small>{commit.authorName} · {formatTime(commit.authoredAt)}</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>

          <div className="git-viewer">
            <div className="git-viewer-head">
              <div>
                <strong>{selectedPath ?? (activeScope === "working" ? "全部工作区改动" : "全部分支改动")}</strong>
                {selectedFile && <small>{statusLabel(selectedFile.status)} · {activeScope === "working" ? "未提交" : "相对基线"}</small>}
              </div>
              {selectedFile && (
                <div className="git-viewer-actions">
                  <button className="ghost-button" onClick={() => openPreview(selectedFile.path, false)}>查看源码</button>
                  {selectedFile.status === "deleted" && <button className="ghost-button" onClick={() => openPreview(selectedFile.path, true)}>HEAD 版本</button>}
                </div>
              )}
            </div>
            {diffQuery.isLoading && <div className="git-loading"><Loader2 size={14} className="spin" /> 正在读取 diff</div>}
            {diffQuery.isError && <p className="form-error">{diffQuery.error instanceof Error ? diffQuery.error.message : "Diff 读取失败"}</p>}
            {selectedDiff && !diffQuery.isLoading && (
              selectedDiff.patch.trim() ? (
                <>
                  {selectedDiff.truncated && <p className="git-truncated">Diff 过长，只显示前面部分。</p>}
                  <DiffView patch={selectedDiff.patch} />
                </>
              ) : <p className="git-no-files">这个文件没有可展示的文本 diff。</p>
            )}
            {!selectedPath && diffQuery.data && !diffQuery.isLoading && (
              diffQuery.data.patch.trim()
                ? <DiffView patch={diffQuery.data.patch} />
                : <p className="git-no-files">没有可展示的 diff。</p>
            )}
            {preview && (
              <div className="git-file-preview">
                <div className="git-file-preview-head">
                  <strong>{preview.path}</strong>
                  <span>{preview.fromHead ? "HEAD 版本" : "当前工作区"}</span>
                  <button className="ghost-button" onClick={() => setPreview(null)}>关闭</button>
                </div>
                {fileQuery.isLoading && <div className="git-loading"><Loader2 size={14} className="spin" /> 正在读取文件</div>}
                {fileQuery.isError && <p className="form-error">{fileQuery.error instanceof Error ? fileQuery.error.message : "文件读取失败"}</p>}
                {fileQuery.data && (
                  fileQuery.data.exists
                    ? <><pre className="git-file-content">{fileQuery.data.content}</pre>{fileQuery.data.truncated && <p className="git-truncated">文件过大，只显示前面部分。</p>}</>
                    : <p className="git-no-files">当前工作区中不存在这个文件。</p>
                )}
              </div>
            )}
          </div>
        </div>

        {view.pullRequest && <PullRequestCard pullRequest={view.pullRequest} />}
        {!view.pullRequest && view.pullRequestError && (
          <p className="git-pr-hint"><MinusCircle size={13} /> 未读取到 PR：{view.pullRequestError}</p>
        )}
        {!view.pullRequest && !view.pullRequestError && view.commitsAhead > 0 && (
          <p className="git-pr-hint"><GitBranch size={13} /> 分支上已有 {view.commitsAhead} 个提交，还没有关联 PR。</p>
        )}
        {!view.clean && view.statusText && (
          <details className="git-status-details">
            <summary>查看原始 git status</summary>
            <pre>{view.statusText}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

function PullRequestCard({ pullRequest }: { pullRequest: GitPullRequestView }) {
  return (
    <div className="git-pr-card">
      <div className="git-pr-main">
        <span className={`git-pr-state ${pullRequest.state.toLowerCase()}`}>{pullRequest.state}{pullRequest.draft ? " · Draft" : ""}</span>
        <div>
          <a href={pullRequest.url} target="_blank" rel="noreferrer">PR #{pullRequest.number} · {pullRequest.title} <ExternalLink size={12} /></a>
          <small>
            {pullRequest.reviewDecision ? `评审：${pullRequest.reviewDecision}` : "尚无评审结论"}
            {pullRequest.mergeable ? ` · 合并状态：${pullRequest.mergeable}` : ""}
          </small>
        </div>
      </div>
      {pullRequest.checks.length > 0 && (
        <ul className="git-checks">
          {pullRequest.checks.map((check) => (
            <li key={`${check.name}:${check.url ?? ""}`} className={checkTone(check)}>
              {check.conclusion?.toLowerCase() === "success" || check.status.toLowerCase() === "completed"
                ? <CheckCircle2 size={13} />
                : <XCircle size={13} />}
              <span>{check.name}</span>
              <small>{check.conclusion ?? check.status}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  return (
    <div className="git-diff" role="region" aria-label="代码 diff">
      {patch.split("\n").map((line, index) => {
        const tone = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
            ? "meta"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "context";
        return (
          <div className={`git-diff-line ${tone}`} key={index}>
            <span className="git-diff-no">{index + 1}</span>
            <span className="git-diff-text">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function statusLetter(status: GitFileStatus): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "untracked") return "?";
  if (status === "conflicted") return "!";
  return "M";
}

function statusLabel(status: GitFileStatus): string {
  if (status === "added") return "新增";
  if (status === "deleted") return "删除";
  if (status === "renamed") return "重命名";
  if (status === "untracked") return "未跟踪";
  if (status === "conflicted") return "冲突";
  return "修改";
}

function checkTone(check: GitCheckSummary): string {
  const value = `${check.status} ${check.conclusion ?? ""}`.toLowerCase();
  if (value.includes("failure") || value.includes("error") || value.includes("cancel") || value.includes("timed")) return "bad";
  if (value.includes("success") || value.includes("pass") || value.includes("completed")) return "ok";
  return "pending";
}
