import { invoke } from "@tauri-apps/api/core";
import type { AppBadge } from "../../core/entities/appBadge";
import type { AppBadgePort } from "../../core/ports/appBadgePort";

/**
 * Interface adapter — the taskbar/dock badge via the Rust backend, which
 * is where the per-platform surfaces (Windows overlay icon, macOS dock
 * badge, Linux launcher count) are chosen.
 *
 * Failures are swallowed: a desktop that has no badge to set says so by
 * erroring, and an app that popped an error over its own icon decoration
 * would be worse than one that quietly goes without.
 */
export class TauriAppBadge implements AppBadgePort {
  async show(badge: AppBadge | null): Promise<void> {
    await invoke("set_app_badge", {
      level: badge?.level ?? null,
      count: badge?.count ?? 0,
    }).catch(() => undefined);
  }
}
