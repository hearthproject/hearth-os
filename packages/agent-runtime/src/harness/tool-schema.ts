import { Ajv, type ValidateFunction } from "ajv";

export interface ToolArgumentIssue {
  path: string;
  message: string;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});

const validators = new WeakMap<object, ValidateFunction>();

/**
 * Validate model-provided tool arguments against the same JSON Schema the
 * model saw. A failure is a rejection, not an exception: the model gets a
 * readable message and the runtime never dispatches the call.
 */
export function validateToolArguments(parameters: unknown, args: unknown): ToolArgumentIssue[] {
  if (!parameters || typeof parameters !== "object") return [];
  const cached = validators.get(parameters as object);
  if (cached) return runValidator(cached, args);
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(parameters as object);
  } catch (error) {
    return [{
      path: "$schema",
      message: `工具参数 schema 无法编译：${error instanceof Error ? error.message : String(error)}`
    }];
  }
  validators.set(parameters as object, compiled);
  return runValidator(compiled, args);
}

function runValidator(validate: ValidateFunction, args: unknown): ToolArgumentIssue[] {
  if (validate(args)) return [];
  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || error.schemaPath,
    message: error.message ?? "不满足 schema"
  }));
}

export function formatToolArgumentIssues(issues: ToolArgumentIssue[], limit = 6): string {
  const shown = issues.slice(0, limit).map((issue) => `${issue.path || "/"} ${issue.message}`);
  const suffix = issues.length > limit ? `（另有 ${issues.length - limit} 处）` : "";
  return `${shown.join("；")}${suffix}`;
}
