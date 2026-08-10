import type { AppBadge } from "../entities/appBadge";

/**
 * Ports layer — the app's own icon in the OS: taskbar, dock, launcher.
 *
 * The core says what the badge means; the adapter owns every platform
 * difference behind it (Windows takes an image, macOS a number, some
 * Linux desktops nothing at all). Best-effort by contract: a desktop
 * that ignores badges is not an error worth surfacing, so implementations
 * resolve either way.
 */
export interface AppBadgePort {
  /** Show the badge, or clear it with null. */
  show(badge: AppBadge | null): Promise<void>;
}
