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
re-render rather than touching the image. Type stays crisp that way.

The highlight is Steam's `#66c0f4`, with `#c7d5e0` text and `#1f2d3d` rules.
The background is a near-black `#0b0f14` rather than Steam's own `#1b2838`
navy: that navy only gives the wordmark 7.4:1 contrast and visibly washes the
blue out, while this base reaches 9.5:1. Keep the background dark if you
retint anything.

Type is split by role: **Montserrat** for the wordmark and tagline, because its
geometry is close to Steam's own Motiva Sans, and **Cascadia Code** only for
text that really is code, the install command and the repo URL. A monospaced
wordmark does not work here: the fixed cell forces a visible gap before the
`.js`.

Both fonts must be installed locally to re-render. Chrome falls back silently
if Montserrat is missing, so check the wordmark after any re-render on a
different machine.

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
