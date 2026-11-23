import { api } from "./api.ts";
import type { ArtifactListItem, ChatAttachment } from "./types.ts";

export interface PreviewTarget {
  name: string;
  url: string;
  mimeType: string;
  bytes: number | null;
  taskId?: string;
  artifactId?: string;
}

export function artifactPreviewTarget(artifact: Pick<ArtifactListItem, "id" | "taskId" | "relativePath" | "mimeType" | "bytes">): PreviewTarget {
  return {
    name: fileName(artifact.relativePath),
    url: api.artifactUrl(artifact.taskId, artifact.id),
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
    taskId: artifact.taskId,
    artifactId: artifact.id
  };
}

export function attachmentPreviewTarget(attachment: ChatAttachment): PreviewTarget {
  return {
    name: attachment.name,
    url: api.attachmentUrl(attachment.id),
    mimeType: attachment.mimeType,
    bytes: attachment.bytes
  };
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
