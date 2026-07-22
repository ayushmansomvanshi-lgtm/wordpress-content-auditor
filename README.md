# WordPress Content Auditor

A small Node.js tool that:

- detects the public WordPress REST API;
- fetches every published post using pagination;
- fetches all categories, including empty categories;
- compares WordPress category counts with locally calculated counts;
- detects posts with no category;
- detects posts assigned only to `Uncategorized`;
- detects duplicate normalized post URLs;
- exports posts, categories, and issues to CSV.

## Requirements

- Node.js 18 or newer
- A WordPress website with a publicly accessible REST API

## Installation

```bash
cd wordpress-content-auditor
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Development mode

```bash
npm run dev
```

## How it works

1. The app checks `/wp-json/` and the fallback `?rest_route=/` endpoint.
2. It loads all categories with `per_page=100` and follows every API page.
3. It discovers REST-visible post types.
4. It audits post types that use the standard `category` taxonomy.
5. It fetches every public post.
6. It calculates category membership from the fetched posts.
7. It compares the calculated totals with each category's WordPress `count` value.
8. It shows issues and permits CSV export.

## Important limitations

The public audit cannot see drafts, private posts, pending posts, scheduled posts, or custom post types that are not exposed through REST.

Some WordPress security plugins disable or modify REST endpoints. Those websites require a fallback crawler or authenticated mode.

A post can belong to multiple categories, so the sum of category counts can be greater than the number of unique posts.
