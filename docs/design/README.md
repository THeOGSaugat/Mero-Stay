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

### Mockups and photos (owner, 2026-11-27, Phase 13)

- `screens/mockup-set-1.png`, `screens/mockup-set-2.png`: home, hotels, buses, guides. **Set 2 is
  the reference** (owner decision), with the headline "Discover Nepal, your way".
- `assets/`: the owner's photos as supplied (crops from the mockups; small; destination photos
  have the place name baked in). Web copies, cropped and re-encoded, are in
  `apps/web/public/images/`. `13_domestic_flight.jpg` is not used (flights are not offered).

### Colour palette (Phase 13, supersedes the Phase 7 navy/teal palette)

From the owner's brief and mockups. Tokens live in `apps/web/src/app/globals.css`; usage and
contrast rules are in [docs/architecture/frontend.md](../architecture/frontend.md).

| Token | Hex | Use |
|---|---|---|
| `primary` | `#1B4332` | Forest green: header, headings, primary buttons |
| `accent` | `#F4A261` | Warm orange: decorative accents only (fails contrast for small text) |
| `accent-strong` | `#B8541A` | Orange text, outlined "Book now", white-text orange buttons |
| `surface` / `line` | `#F4F6F3` / `#E1E7E2` | Section backgrounds / borders |
| `ink` / `muted` | `#1F2A24` / `#4A5A51` | Body / secondary text |

Typography: Inter (text) and Playfair Display (headings), self-hosted with `next/font`.

The Phase 7 palette (navy `#0F3B64`, teal `#14B8A6`, from a brand-kit image) is retired.
