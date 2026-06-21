import { Tray, Menu, nativeImage, MenuItem } from "electron";
import path from "path";
import { SettingsStore } from "./settings";

interface TrayCallbacks {
  onChat: () => void;
  onSettings: () => void;
  onToggle: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;

/** The tray instance, exposed so the popover can anchor to `tray.getBounds()`. */
export function getTray(): Tray | null {
  return tray;
}

export function createTray(callbacks: TrayCallbacks, settings: SettingsStore): Tray {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "..", "..", "assets", "icon.ico")
  );
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Clicky",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Chat",
      click: callbacks.onChat,
    },
    {
      label: "Settings",
      click: callbacks.onSettings,
    },
    { type: "separator" },
    {
      // When checked (default), the caption pill follows the cursor; uncheck to
      // pin it where it first appears. The tray is the only writer, so the
      // checkbox state Electron tracks stays in sync without a rebuild.
      label: "Caption follows cursor",
      type: "checkbox",
      checked: settings.get("overlayCaptionFollowCursor") !== false,
      click: (item: MenuItem) =>
        settings.set("overlayCaptionFollowCursor", item.checked),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: callbacks.onQuit,
    },
  ]);

  tray.setToolTip("Clicky — AI Screen Companion");
  tray.setContextMenu(contextMenu);

  // Left-click toggles the settings/status popover anchored to the tray icon.
  tray.on("click", () => {
    callbacks.onToggle();
  });

  return tray;
}
