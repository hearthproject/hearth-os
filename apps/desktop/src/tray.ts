import { Menu, Tray, nativeImage } from "electron";

export interface TrayActions {
  open: () => void;
  environment: () => void;
  openDataDir: () => void;
  openLogs: () => void;
  quit: () => void;
}

export function createTray(iconPath: string, actions: TrayActions): Tray {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(image);

  tray.setToolTip("Hearth");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Hearth", click: actions.open },
    { type: "separator" },
    { label: "环境体检", click: actions.environment },
    { type: "separator" },
    { label: "数据目录", click: actions.openDataDir },
    { label: "日志目录", click: actions.openLogs },
    { type: "separator" },
    { label: "退出", click: actions.quit }
  ]));
  tray.on("double-click", actions.open);

  return tray;
}
