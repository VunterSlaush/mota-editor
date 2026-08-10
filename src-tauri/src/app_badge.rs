//! The app-level indicator: how many tabs want you, in the color of the
//! one that wants you most.
//!
//! Every desktop does this differently, and the difference is not
//! cosmetic — it decides what can be said at all:
//!
//! - **Windows** has no badge. It takes an overlay ICON, which means the
//!   image is ours: color and count both survive.
//! - **macOS** has a dock badge, but AppKit paints it: a red pill, for
//!   every state. So the dock TILE is taken over instead — the app icon
//!   with our own badge drawn on the corner — which is what every chat
//!   app on the platform does and the only way the color survives.
//! - **Linux** exposes the same count through the Unity launcher API,
//!   which GNOME-with-dash-to-dock and KDE honor and other desktops
//!   quietly ignore. Nothing to do about that from here.
//!
//! What the badge MEANS is decided in the frontend (`appBadge.ts`) and
//! the pixels are drawn in `agent_core::badge`; this file only picks the
//! surface.

use agent_core::badge::{self, BadgeLevel};
use tauri::WebviewWindow;

/// Show (or clear) the badge on the taskbar, dock, or launcher.
///
/// `level` is `None` to clear — nothing is pending and the icon should
/// look untouched. An unknown level clears too rather than guessing: a
/// wrong color is worse than no color.
#[tauri::command]
pub async fn set_app_badge(
    window: WebviewWindow,
    level: Option<String>,
    count: u32,
) -> Result<(), String> {
    let level = level.as_deref().and_then(BadgeLevel::from_id);
    apply(&window, level, count).map_err(|e| format!("Could not set the badge: {e}"))
}

#[cfg(target_os = "windows")]
fn apply(
    window: &WebviewWindow,
    level: Option<BadgeLevel>,
    count: u32,
) -> tauri::Result<()> {
    let Some(level) = level else {
        return window.set_overlay_icon(None);
    };
    let pixels = badge::badge_rgba(level, count, badge::OVERLAY_SIZE);
    let icon =
        tauri::image::Image::new(&pixels, badge::OVERLAY_SIZE, badge::OVERLAY_SIZE);
    window.set_overlay_icon(Some(icon))
}

#[cfg(target_os = "macos")]
fn apply(
    window: &WebviewWindow,
    level: Option<BadgeLevel>,
    count: u32,
) -> tauri::Result<()> {
    let wanted = level.map(|level| (level, count));
    // AppKit is main-thread-only and a command runs on the async
    // runtime, so every line below is hopped over deliberately.
    window.run_on_main_thread(move || dock_tile::show(wanted))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn apply(
    window: &WebviewWindow,
    level: Option<BadgeLevel>,
    count: u32,
) -> tauri::Result<()> {
    // The launcher badge is a number and the desktop styles it, so the
    // level only decides whether there is one at all. A level with
    // nothing counted still deserves a mark, and 1 is the nearest thing
    // this API can say.
    match level {
        Some(_) => window.set_badge_count(Some(i64::from(count.max(1)))),
        None => window.set_badge_count(None),
    }
}

/// The macOS half: the dock icon, redrawn with a badge on its corner.
#[cfg(target_os = "macos")]
mod dock_tile {
    use agent_core::badge::{self, BadgeLevel};
    // `alloc` on a class comes from this trait, not the class itself.
    use objc2::AnyThread;
    use objc2_app_kit::{
        NSApplication, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImage, NSImageView,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    /// The badge's side as a fraction of the dock tile, and its inset
    /// from the corner. Proportional because the tile's size is the
    /// dock's business, not ours.
    const BADGE_FRACTION: f64 = 0.375;
    const INSET_FRACTION: f64 = 0.03;

    /// Draw the badge on the dock icon, or hand the tile back to AppKit
    /// with `None`.
    ///
    /// Every failure here is silent on purpose: a dock decoration that
    /// could not be drawn is not worth a dialog, and there is nobody to
    /// report it to on the main thread anyway.
    pub fn show(badge: Option<(BadgeLevel, u32)>) {
        // SAFETY(threading): only ever called through
        // `run_on_main_thread`, which is what this marker asserts.
        let Some(mtm) = MainThreadMarker::new() else { return };
        let app = NSApplication::sharedApplication(mtm);
        let tile = app.dockTile();

        let Some((level, count)) = badge else {
            // A content view of None restores the plain app icon; the
            // tile is not repainted until it is told to.
            tile.setContentView(None);
            tile.display();
            return;
        };
        let Some(icon) = app.applicationIconImage() else { return };
        let Some(overlay) = badge_image(level, count) else { return };

        let tile_size = tile.size();
        let side = tile_size.width * BADGE_FRACTION;
        let inset = tile_size.width * INSET_FRACTION;
        // The image is a 2x bitmap given a 1x point size, so a Retina
        // dock draws the circle at full resolution instead of blurring
        // a 48pt one.
        overlay.setSize(NSSize::new(side, side));

        let content = NSImageView::imageViewWithImage(&icon, mtm);
        content.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), tile_size));
        let corner = NSImageView::imageViewWithImage(&overlay, mtm);
        // AppKit's origin is bottom-left, so this is the top-right one.
        corner.setFrame(NSRect::new(
            NSPoint::new(
                tile_size.width - side - inset,
                tile_size.height - side - inset,
            ),
            NSSize::new(side, side),
        ));
        content.addSubview(&corner);

        tile.setContentView(Some(&content));
        tile.display();
    }

    /// Our RGBA pixels as an `NSImage`, or None if AppKit refused the
    /// bitmap.
    fn badge_image(level: BadgeLevel, count: u32) -> Option<objc2::rc::Retained<NSImage>> {
        let pixels = badge::badge_rgba(level, count, badge::DOCK_SIZE);
        let side = badge::DOCK_SIZE as isize;
        // SAFETY: a null `planes` asks AppKit to own the buffer, which
        // is then exactly `side * 4` bytes per row for `side` rows —
        // the same shape `badge_rgba` produced, and the copy below is
        // bounded by that length.
        unsafe {
            let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                side,
                side,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                side * 4,
                32,
            )?;
            let buffer = rep.bitmapData();
            if buffer.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), buffer, pixels.len());
            let image = NSImage::new();
            image.addRepresentation(&rep);
            Some(image)
        }
    }
}
