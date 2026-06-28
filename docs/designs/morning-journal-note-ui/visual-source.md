# Morning Journal Note UI Visual Source

- Design slug: `morning-journal-note-ui`
- Approved source image: `assets/source/selected-ui-design.png`
- Approval status: `Approved`
- Approval scope: React reference implementation
- Date: `2026-06-27`

## Approval Notes

The approved source image is the `Sunlit Memory Flow` direction. It combines:

- option 3's implementation-friendly layout skeleton
- option 1's warm sunrise, paper, stationery, and personal memory aesthetic

User acceptance for the direction:

- The overall layout strategy should follow the third visual direction.
- The visual feeling and sensory effect should follow the first visual direction.
- The current combined result is accepted as the effect to implement.

## Visual Truth

Open `assets/source/selected-ui-design.png` before writing UI code. It defines:

- full-screen desktop composition
- left memory timeline
- central writing sanctuary
- right rhythm panel
- top command bar
- bottom flow strip
- warm paper and sunrise material language
- typography hierarchy
- component density and spacing rhythm

The source image is not an implementation asset. Do not use it as a background
in the running prototype.

## Must Match

- App viewport composition: source image is `1536x1024`.
- Region structure: top bar, left memory rail, center editor, right rhythm
  panel, bottom flow strip.
- Warm tactile material system: ivory paper, soft sage, sunrise peach, pale
  gold, faded coral, muted cyan, deep graphite.
- Paper/stationery depth: layered paper shadows, subtle grain, tape, botanical
  accents, small-radius refined surfaces.
- Writing-first hierarchy: center editor dominates the screen without becoming
  blank white SaaS chrome.
- Memory feeling: left rail uses photo thumbnails, dates, times, mood labels,
  and colored status dots.
- Right rhythm panel: paper-slip ritual sections, not generic form cards.
- Bottom focus flow: timer and controls integrated into the paper surface.
- All visible app-specific text from the source direction must remain sparse,
  contained, and readable.

## Allowed Deviations

- Responsive wrapping when the viewport is narrower than the desktop source.
- Platform-native font fallback when the preferred font is unavailable.
- Exact decorative placement may shift slightly to preserve responsive layout.
- Image thumbnails may use generated atomic assets rather than cropped source
  pixels, as long as they preserve the same mood, palette, and density.
- Transparent decorations may be simplified if alpha edges remain clean.

## Forbidden Deviations

- Using the approved source image as the live app background.
- Replacing the approved palette with framework defaults.
- Adding visual sections not shown in the source image.
- Making the right rhythm panel look like ordinary SaaS cards.
- Replacing real bitmap assets with CSS art, handcrafted SVG, emoji, or generic
  placeholders.
- Changing border radius, density, hierarchy, or spacing without a logged
  decision.
- Shipping without desktop and narrow screenshots.
