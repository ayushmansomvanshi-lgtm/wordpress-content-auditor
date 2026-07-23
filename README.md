# Radish v5.0.0

Radish is a read-only WordPress content, structure, image, UI and performance auditor.

## New in v5

### Scan modes

- **Quick**: WordPress content plus 3 representative pages. Lighthouse and interaction-click checks are skipped.
- **Standard**: Content, 6 representative pages, UI checks, images and 1 Lighthouse run.
- **Deep**: Full content audit, up to 10 representative pages and 3 sequential Lighthouse runs.

### Performance modes

Choose before the audit:

- Mobile
- Desktop
- Both

When **Both** is selected, Radish runs each device profile separately and provides a side-by-side median comparison.

### Transparent Lighthouse reporting

The Performance tab now shows:

- Lighthouse version
- Mobile or desktop profile
- Simulated throttling method
- Viewport and scale factor
- User agent
- Completed and requested run count
- Selected representative run
- Run timestamps
- Final URL after redirects
- Cold-cache mode
- Every run for LCP, FCP, CLS, TTFB, Speed Index and TBT
- Median values
- Mobile versus desktop comparison

## Local installation

```bash
cd "$HOME/Downloads"
unzip -o radish-v5-full.zip
cd radish-v5
chmod +x INSTALL_UPDATE.command
./INSTALL_UPDATE.command
```

Then run:

```bash
cd "$HOME/Desktop/Total Post"
npm start
```

Open:

```text
http://localhost:3000/?version=5.0.0
```

Health check:

```text
http://localhost:3000/health
```

Expected version:

```json
{
  "ok": true,
  "product": "Radish",
  "version": "5.0.0"
}
```

## Render deployment

Commit and push the updated project:

```bash
cd "$HOME/Desktop/Total Post"
git add .
git commit -m "Upgrade Radish to v5"
git push origin main
```

A Deep scan with **Both** selected performs six Lighthouse runs. This is intentionally detailed but can be heavy on a free hosting instance. Standard Mobile is the recommended default for hosted use.

## Staging authentication

Radish supports HTTP Basic Authentication for password-protected staging sites. Credentials are held only for the current audit and are cleared afterward.

## Important behavior

- Lighthouse runs are sequential to avoid one run distorting another.
- Median metric values are calculated independently from all successful runs.
- One middle-score run is retained as the representative report for resource opportunities and diagnostics.
- Quick scan does not create a performance-unavailable issue because performance is intentionally skipped.
# Radish
