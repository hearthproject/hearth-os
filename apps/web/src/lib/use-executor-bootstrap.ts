import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import type {
  ExecutorBootstrapResult,
  ExecutorId,
  ExecutorInstallProgress
} from "./types.ts";

export type ExecutorBootstrapState =
  | { status: "installing"; progress: ExecutorInstallProgress }
  | { status: "complete"; progress: ExecutorInstallProgress; result: ExecutorBootstrapResult }
  | { status: "error"; progress: ExecutorInstallProgress | null; error: string };

export function useExecutorBootstrap() {
  const queryClient = useQueryClient();
  const [installs, setInstalls] = useState<Partial<Record<ExecutorId, ExecutorBootstrapState>>>({});

  const bootstrap = useCallback(async (id: ExecutorId): Promise<ExecutorBootstrapResult> => {
    const started: ExecutorInstallProgress = {
      phase: "install",
      message: "正在检查本机安装状态",
      percent: 0
    };
    setInstalls((current) => ({
      ...current,
      [id]: { status: "installing", progress: started }
    }));
    try {
      const result = await api.bootstrapExecutorStream(id, {
        onProgress: (progress) => {
          setInstalls((current) => ({
            ...current,
            [id]: { status: "installing", progress }
          }));
        }
      });
      const complete: ExecutorInstallProgress = {
        phase: "probe",
        message: result.probe.ok ? "真实可用性测试通过" : "安装完成，等待模型或网络检查",
        percent: 100
      };
      setInstalls((current) => ({
        ...current,
        [id]: { status: "complete", progress: complete, result }
      }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["executorSettings"] }),
        queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
        queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] })
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行器下载或安装失败";
      setInstalls((current) => {
        const previous = current[id];
        return {
          ...current,
          [id]: {
            status: "error",
            progress: previous && previous.status !== "error" ? previous.progress : null,
            error: message
          }
        };
      });
      throw error;
    }
  }, [queryClient]);

  return { installs, bootstrap };
}
