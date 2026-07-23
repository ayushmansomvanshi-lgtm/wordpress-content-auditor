# Radish 4.3

Radish is a read-only WordPress content, structure, performance and interface auditor.

## New in 4.3

- HTTP Basic Authentication fields for password-protected staging sites.
- Optional duplicate-post skipping while staging access is enabled.
- Image link checks now apply only to representative main pages: homepage, category, About, Contact, Privacy, legal and unique page templates.
- Single-post content images are no longer reported for missing links.
- Every post still shows its featured-image URL when WordPress exposes one.
- Writing bracket checks run only on H2 subheadings.
- Ordered-list prefixes such as `1)`, `2)` and `a)` are ignored by bracket checks.
- Pagination for long Writing and Issues results.
- Radish favicon and updated copyright footer.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000/?version=4.4.1`.

## Staging access

Open **Staging website access** in the audit form. Enable it and enter the username and password used by the browser's HTTP Basic Authentication prompt. Credentials are kept only in memory for the current request and are not included in the audit result.

The staging option is for server-level HTTP Basic Authentication. It is not a WordPress administrator login form.


## v4.4.1 changes
- Removed the three-card H1 source/DOM/visibility inspector from the heading UI while retaining the clear H1 verdict and outline.
- Changed the 75-character writing rule from post title to post slug.
- Added representative-page post-card checks for linked titles, images and read-more buttons.
- Updated footer copyright text.
