import type {
  CaseCatalogResponse,
  CaseDetailResponse,
  CompareResponse,
  CreateExperimentRequest,
  DashboardResponse,
  EvalEventRecord,
  EvalEventsResponse,
  EvalSystemResponse,
  ExperimentDetailResponse,
  ExperimentRecord,
  ExperimentsResponse,
  HumanReviewRecord,
  ReviewQueueItem,
  ReviewsResponse,
  RunArtifactView,
  RunDetailResponse,
  SubmitReviewRequest
} from "@hearth/eval-core";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) as unknown : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const record = asRecord(payload);
    throw new ApiError(
      response.status,
      typeof record?.error === "string" ? record.error : "REQUEST_FAILED",
      typeof record?.message === "string" ? record.message : `请求失败（HTTP ${response.status}）`,
      payload
    );
  }
  return payload as T;
}

export interface CaseFilters {
  family?: string;
  difficulty?: string;
  runMode?: string;
  search?: string;
}

export interface SubmitReviewResult {
  review: HumanReviewRecord;
  run: RunDetailResponse["run"] | null;
  experiment: ExperimentRecord | null;
}

export const api = {
  dashboard: () => request<DashboardResponse>("/api/dashboard"),
  system: () => request<EvalSystemResponse>("/api/system"),
  cases: (filters: CaseFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    return request<CaseCatalogResponse>(`/api/cases${query.size > 0 ? `?${query.toString()}` : ""}`);
  },
  caseDetail: (caseKey: string) => request<CaseDetailResponse>(`/api/cases/${encodeURIComponent(caseKey)}`),
  experiments: () => request<ExperimentsResponse>("/api/experiments"),
  experiment: (id: string) => request<ExperimentDetailResponse>(`/api/experiments/${encodeURIComponent(id)}`),
  createExperiment: (body: CreateExperimentRequest) => request<ExperimentRecord>("/api/experiments", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  cancelExperiment: (id: string) => request<ExperimentRecord>(`/api/experiments/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}"
  }),
  run: (id: string) => request<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`),
  reviews: () => request<ReviewsResponse>("/api/reviews"),
  submitReview: (id: string, body: SubmitReviewRequest) => request<SubmitReviewResult>(`/api/runs/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify(body)
  }),
  compare: (left: string, right: string) => {
    const query = new URLSearchParams({ left, right });
    return request<CompareResponse>(`/api/compare?${query.toString()}`);
  },
  events: (input: { after?: number; limit?: number; experimentId?: string; runId?: string } = {}) => {
    const query = new URLSearchParams();
    if (input.after !== undefined) query.set("after", String(input.after));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.experimentId) query.set("experimentId", input.experimentId);
    if (input.runId) query.set("runId", input.runId);
    return request<EvalEventsResponse>(`/api/events${query.size > 0 ? `?${query.toString()}` : ""}`);
  },
  artifact: (runId: string, path: string) => {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return request<RunArtifactView>(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`);
  }
};

export function latestEventSeq(events: EvalEventRecord[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export function reviewItemRunId(item: ReviewQueueItem): string {
  return item.run.id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
