import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { NotificationPort } from "../../core/ports/notificationPort";

/**
 * Interface adapter — OS notifications via the Tauri plugin. Suppressed
 * when the user is already looking at the finished tab in a focused
 * window; permission is requested lazily on first use.
 */
export class TauriNotifications implements NotificationPort {
  private permissionChecked = false;
  private permissionGranted = false;

  async turnCompleted(
    projectName: string,
    providerName: string,
    tabActive: boolean,
  ): Promise<void> {
    if (tabActive && document.hasFocus()) return; // already watching

    if (!(await this.ensurePermission())) return;
    sendNotification({
      title: `${providerName} finished — ${projectName}`,
      body: "The agent completed its task. Click the tab to review.",
    });
  }

  private async ensurePermission(): Promise<boolean> {
    if (!this.permissionChecked) {
      this.permissionGranted = await isPermissionGranted();
      if (!this.permissionGranted) {
        this.permissionGranted = (await requestPermission()) === "granted";
      }
      this.permissionChecked = true;
    }
    return this.permissionGranted;
  }
}
