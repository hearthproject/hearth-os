import { existsSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";

export function helperCommandPath(root: string, packaged: boolean, resourcesPath: string): string {
  return packaged
    ? join(resourcesPath, "helper", "helper.cmd")
    : join(root, "apps", "desktop", "resources", "helper", "helper.cmd");
}

export async function openDesktopHelper(root: string, packaged: boolean, resourcesPath: string): Promise<string | null> {
  const command = helperCommandPath(root, packaged, resourcesPath);
  if (!existsSync(command)) {
    return "桌面助手没有打包在当前版本里；请使用带 helper 资源的安装包。";
  }
  const error = await shell.openPath(command);
  return error || null;
}
