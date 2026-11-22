# Design References

Place design references supplied by the project owner here (screenshots, Figma links, mood boards,
colour palettes, typography, logo files).

**Rule:** UI work must follow these references. If a reference is missing for a screen being built,
ask the owner before inventing a new visual style.

Suggested structure:

```
docs/design/
├── README.md            # this file: index of references + notes
├── brand/               # logo, colours, typography
├── screens/             # screenshots / mockups per page
└── links.md             # Figma or external links
```

## Index

### Colour palette (owner reference, 2026-11-23)

The owner shared a brand-kit image (Phase 7) and asked to use it **only for the colour palette**.
Nothing else from it is used: no logo, mark, name, tagline, typography or layout. The image itself
is not stored in the repository; these values are the reference.

| Token (`globals.css`) | Hex | Use |
|---|---|---|
| `navy` (Deep Blue) | `#0F3B64` | Primary: headings, buttons, links |
| `teal` (Teal Green) | `#14B8A6` | Accent: focus outlines, borders, highlights, logo mark |
| `mint` (Soft Mint) | `#A7D8D1` | Soft accent: success and status backgrounds |
| `mist` (Light Gray) | `#E8F1F5` | Surfaces: hero, table headers, cards |
| `ink` (Charcoal) | `#2D3748` | Body text |
| `navy-dark` (derived) | `#0B2E4F` | Hover/pressed state of navy |

Contrast rule: text and buttons use navy or ink. Teal and mint are never used for small text on
white, because teal is below 4.5:1 contrast there.

Typography: the system font stack (unchanged). No font was taken from the reference.
