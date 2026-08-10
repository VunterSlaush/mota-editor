//! The taskbar badge, as pixels.
//!
//! Windows has no badge API — it takes an overlay ICON — so the image
//! has to be drawn. That drawing is pure arithmetic over a byte buffer,
//! which is why it lives here and not in the shell: no window, no
//! platform, nothing to mock. The shell only decides which surface to
//! hand it to.
//!
//! Colors match the tab dots in `styles.css` (dark theme) on purpose:
//! the taskbar is saying the same thing the tab bar is, and a person
//! should not have to learn two palettes.

/// What the badge is reporting, worst first. The order is the type's
/// meaning — a level that outranks another wins the badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeLevel {
    /// A tab's last turn failed.
    Error,
    /// A tab is blocked on the user: approval, plan, or a question.
    NeedsInput,
    /// A tab finished while the user was looking elsewhere.
    Done,
    /// A tab is working and nothing waits on a person.
    Busy,
}

impl BadgeLevel {
    /// The id the UI sends. None for anything else — an unknown level is
    /// a wiring mistake, and a badge in a made-up color would hide it.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "error" => Some(Self::Error),
            "needsInput" => Some(Self::NeedsInput),
            "done" => Some(Self::Done),
            "busy" => Some(Self::Busy),
            _ => None,
        }
    }

    /// Fill color, RGB. `--error`, `--warning`, `--success`, `--accent`.
    const fn rgb(self) -> [u8; 3] {
        match self {
            Self::Error => [0xff, 0x6b, 0x6b],
            Self::NeedsInput => [0xf0, 0xb4, 0x29],
            Self::Done => [0x7e, 0xe2, 0xa8],
            Self::Busy => [0x4f, 0x8c, 0xff],
        }
    }
}

/// Side of the square image, in pixels, for a Windows overlay icon —
/// what the taskbar asks for, and what every scale reads cleanly.
pub const OVERLAY_SIZE: u32 = 32;

/// Side for the macOS dock tile's badge, at 2x: the tile draws it at
/// 48pt, and a Retina dock would otherwise show a soft circle.
pub const DOCK_SIZE: u32 = 96;

/// All four fills are light, so one dark ink reads on every one of them
/// — and stays legible against a light or dark taskbar.
const INK: [u8; 3] = [0x14, 0x18, 0x1f];

const GLYPH_W: u32 = 3;
const GLYPH_H: u32 = 5;
/// Blank columns between two digits, in font pixels.
const GLYPH_GAP: u32 = 1;

/// Two digits are all that fit inside the circle; a person with a
/// hundred waiting tabs is not being helped by the exact number.
const MAX_COUNT: u32 = 99;

/// 3x5 bitmap digits, one byte per row, low three bits left-to-right.
/// Hand-drawn because a font crate to write ten glyphs would be a
/// dependency to avoid drawing ten glyphs.
const DIGITS: [[u8; GLYPH_H as usize]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

/// How big one font pixel is drawn, so the digits keep their share of
/// the badge at any size: 3 at 32px, 9 at 96px.
const fn glyph_scale(size: u32) -> u32 {
    let scale = size * 3 / 32;
    if scale == 0 { 1 } else { scale }
}

/// The badge as RGBA8, `size` square, ready to become an icon: a filled
/// circle in the level's color with the count on it, and fully
/// transparent everywhere else.
///
/// The size is the caller's because each surface asks for its own — 32
/// for a Windows overlay icon, 96 for a Retina dock tile — and scaling
/// a 32px circle up to a dock is exactly the blur this avoids.
///
/// A count of 0 draws the dot alone — the colored state is the message,
/// and "0" would contradict it.
pub fn badge_rgba(level: BadgeLevel, count: u32, size: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let fill = level.rgb();
    let center = size as f32 / 2.0;
    let radius = center - 0.5;

    for y in 0..size {
        for x in 0..size {
            // Pixel centers, so the circle is symmetric about the image.
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            // One pixel of coverage at the rim instead of a staircase.
            let coverage = (radius - distance + 0.5).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }
            let index = ((y * size + x) * 4) as usize;
            pixels[index] = fill[0];
            pixels[index + 1] = fill[1];
            pixels[index + 2] = fill[2];
            pixels[index + 3] = (coverage * 255.0).round() as u8;
        }
    }

    if count > 0 {
        draw_count(&mut pixels, size, count.min(MAX_COUNT));
    }
    pixels
}

/// Stamp the count across the middle of the badge in ink.
fn draw_count(pixels: &mut [u8], size: u32, count: u32) {
    let scale = glyph_scale(size);
    let digits: Vec<u32> = if count < 10 {
        vec![count]
    } else {
        vec![count / 10, count % 10]
    };
    let width = digits.len() as u32 * GLYPH_W * scale
        + (digits.len() as u32 - 1) * GLYPH_GAP * scale;
    let left = (size.saturating_sub(width)) / 2;
    let top = (size.saturating_sub(GLYPH_H * scale)) / 2;

    for (position, digit) in digits.iter().enumerate() {
        let origin = left + position as u32 * (GLYPH_W + GLYPH_GAP) * scale;
        for (row, bits) in DIGITS[*digit as usize].iter().enumerate() {
            for column in 0..GLYPH_W {
                // Bit 2 is the leftmost column of the glyph.
                if bits & (1 << (GLYPH_W - 1 - column)) == 0 {
                    continue;
                }
                fill_block(
                    pixels,
                    size,
                    scale,
                    origin + column * scale,
                    top + row as u32 * scale,
                );
            }
        }
    }
}

/// One font pixel, `scale` square, painted opaque ink.
fn fill_block(pixels: &mut [u8], size: u32, scale: u32, x: u32, y: u32) {
    for dy in 0..scale {
        for dx in 0..scale {
            let (px, py) = (x + dx, y + dy);
            if px >= size || py >= size {
                continue;
            }
            let index = ((py * size + px) * 4) as usize;
            pixels[index] = INK[0];
            pixels[index + 1] = INK[1];
            pixels[index + 2] = INK[2];
            pixels[index + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four bytes at (x, y) of a `size`-square image.
    fn pixel(pixels: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let index = ((y * size + x) * 4) as usize;
        [
            pixels[index],
            pixels[index + 1],
            pixels[index + 2],
            pixels[index + 3],
        ]
    }

    fn ink_pixels(pixels: &[u8]) -> usize {
        pixels
            .chunks_exact(4)
            .filter(|p| p[0] == INK[0] && p[1] == INK[1] && p[2] == INK[2] && p[3] == 255)
            .count()
    }

    /// The overlay icon is the size every test that does not care uses.
    fn overlay(level: BadgeLevel, count: u32) -> Vec<u8> {
        badge_rgba(level, count, OVERLAY_SIZE)
    }

    #[test]
    fn the_image_is_a_square_rgba_buffer_at_the_size_asked_for() {
        for size in [OVERLAY_SIZE, DOCK_SIZE] {
            let pixels = badge_rgba(BadgeLevel::Error, 1, size);
            assert_eq!(pixels.len(), (size * size * 4) as usize);
        }
    }

    #[test]
    fn the_corners_stay_transparent_so_the_badge_reads_as_a_dot() {
        let pixels = overlay(BadgeLevel::Busy, 3);
        for (x, y) in [(0, 0), (OVERLAY_SIZE - 1, 0), (0, OVERLAY_SIZE - 1)] {
            assert_eq!(pixel(&pixels, OVERLAY_SIZE, x, y)[3], 0);
        }
    }

    #[test]
    fn each_level_paints_its_own_color() {
        // Off-center: the middle of the badge is covered by the digit.
        let sample = |level| {
            pixel(&overlay(level, 1), OVERLAY_SIZE, 4, OVERLAY_SIZE / 2)
        };
        assert_eq!(sample(BadgeLevel::Error), [0xff, 0x6b, 0x6b, 255]);
        assert_eq!(sample(BadgeLevel::NeedsInput), [0xf0, 0xb4, 0x29, 255]);
        assert_eq!(sample(BadgeLevel::Done), [0x7e, 0xe2, 0xa8, 255]);
        assert_eq!(sample(BadgeLevel::Busy), [0x4f, 0x8c, 0xff, 255]);
    }

    #[test]
    fn the_count_is_drawn_on_the_dot() {
        let one = overlay(BadgeLevel::Error, 1);
        let twelve = overlay(BadgeLevel::Error, 12);
        assert!(ink_pixels(&one) > 0, "a count must be visible");
        assert!(
            ink_pixels(&twelve) > ink_pixels(&one),
            "two digits must use more ink than one"
        );
    }

    #[test]
    fn a_countless_badge_is_a_plain_dot() {
        assert_eq!(ink_pixels(&overlay(BadgeLevel::Busy, 0)), 0);
    }

    #[test]
    fn counts_past_two_digits_are_capped_rather_than_overflowing() {
        let capped = overlay(BadgeLevel::NeedsInput, 500);
        assert_eq!(ink_pixels(&capped), ink_pixels(&overlay(BadgeLevel::NeedsInput, 99)));
        // Still inside the circle: the corners never take ink.
        assert_eq!(pixel(&capped, OVERLAY_SIZE, 0, 0)[3], 0);
    }

    #[test]
    fn digits_keep_their_share_of_the_badge_at_every_size() {
        // Nine times the pixels, so nine times the ink: the glyphs scale
        // with the circle instead of shrinking into a dot.
        let small = ink_pixels(&badge_rgba(BadgeLevel::Done, 7, OVERLAY_SIZE));
        let large = ink_pixels(&badge_rgba(BadgeLevel::Done, 7, DOCK_SIZE));
        assert_eq!(large, small * 9);
    }

    #[test]
    fn a_badge_too_small_for_the_font_still_draws_a_dot() {
        // The dot is the message; a digit that cannot fit is dropped, not
        // smeared across the rim.
        let tiny = badge_rgba(BadgeLevel::Error, 8, 8);
        assert_eq!(tiny.len(), 8 * 8 * 4);
        assert_eq!(pixel(&tiny, 8, 4, 4)[3], 255, "the circle is still filled");
    }

    #[test]
    fn only_the_levels_the_ui_sends_are_accepted() {
        assert_eq!(BadgeLevel::from_id("needsInput"), Some(BadgeLevel::NeedsInput));
        assert_eq!(BadgeLevel::from_id("done"), Some(BadgeLevel::Done));
        assert_eq!(BadgeLevel::from_id("idle"), None);
        assert_eq!(BadgeLevel::from_id(""), None);
    }
}
