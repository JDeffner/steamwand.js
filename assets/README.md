# assets/

Repo artwork. Not shipped to npm: `files` in package.json lists only `dist`,
`runtime`, `README.md`, and `LICENSE`, so nothing here reaches the tarball.
The root README references `banner.png` by absolute raw URL for that reason,
because a relative path renders on GitHub and breaks on npmjs.com.

| file | size | used for |
| --- | --- | --- |
| `social-preview.png` | 1280x640 | GitHub social preview (Settings, General, Social preview) |
| `banner.png` | 1200x280 | the image at the top of the root README |

Both PNGs are rendered from the `.html` next to them, so edit the HTML and
re-render rather than touching the image. Type stays crisp that way, and the
palette is the same one the workbench uses (`scripts/workbench.html`):
background `#101418`, accent `#5fb4a2`, text `#cdd6e0`, rules `#2a3441`.

## Re-rendering

Headless Chrome writes the exact pixel size given by `--window-size`:

```bash
chrome --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --screenshot=assets/social-preview.png --window-size=1280,640 "file:///F:/Projets/SteamWand.js/assets/social.html"
```

```bash
chrome --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --screenshot=assets/banner.png --window-size=1200,280 "file:///F:/Projets/SteamWand.js/assets/banner.html"
```

Three things that will trip you up:

- `--headless=new` silently writes nothing on Chrome 151. Use plain `--headless`.
- The URL must be an absolute `file:///` path. A relative path loads a blank page.
- Chrome cannot overwrite the PNG while another program holds it open, and it
  reports that only on stderr. If the file does not change, close whatever is
  previewing it.

The numbers on both images are real and will drift. `801 methods` and
`25 interfaces` come from the workbench's `/api/interfaces` endpoint,
`3 platforms` from the folders in `runtime/`, and `1 dependency` from
`dependencies` in package.json. Recheck them after an SDK bump.
