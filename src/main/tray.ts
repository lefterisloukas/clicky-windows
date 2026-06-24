import { Tray, Menu, nativeImage } from "electron";
import path from "path";

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

export function createTray(callbacks: TrayCallbacks): Tray {
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
