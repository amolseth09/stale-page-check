# Stale Page Check

An admin tool for AEM Edge Delivery Services (EDS) sites authored in da.live. It finds pages that are **live on your site but no longer exist in da.live** (deleted without unpublishing), lets you review them, and unpublishes the ones you select.

It is three static files. There is no build step.

```
tools/
  stale-page-check/
    stale-page-check.html
    stale-page-check.css
    stale-page-check.js
    README.md
```

## How it works

1. Reads the live site's `full-index.json` (every page the site knows about).
2. Walks the da.live folder tree with the DA Admin API (every source document).
3. Lists paths that are in the first list but not the second.
4. You tick the genuinely stale pages and click **Unpublish selected**. The tool sends `DELETE` requests to the AEM Admin API for the preview and live copies of each page.

A manual box at the bottom unpublishes single paths, with an option to delete the da.live source document too.

## Install

1. Copy the `stale-page-check` folder into the `tools/` folder of your EDS repository (create `tools/` if needed).
2. Change the org, repo and website as described below.
3. Commit and push to `main`.
4. Open the tool **through da.live**, not by its direct `.aem.page` URL:

   ```
   https://da.live/app/{your-org}/{your-repo}/tools/stale-page-check
   ```

   Opened this way, the DA App SDK hands the tool a da.live token and fills in the org and repo for you (the green banner says "Authenticated via da.live").

## Change the org, repo and website name

The names `example-org`, `example-site` and `www.example.com` are placeholders. They appear in **one file only**.

### `stale-page-check.html` (the only file you must edit)

Find the inputs near the top of the page and change the `value` attributes:

| Field | Default in the file | Change to |
|---|---|---|
| Org (`id="cfg-org"`) | `example-org` | your GitHub / da.live org |
| Repo (`id="cfg-repo"`) | `example-site` | your repo (site) name |
| Branch (`id="cfg-branch"`) | `main` | your branch, usually leave as is |
| Live index URL (`id="cfg-index"`) | `https://www.example.com/full-index.json` | your live site's index URL |

Example:

```html
<input id="cfg-org" type="text" value="acme" />
<input id="cfg-repo" type="text" value="acme-website" />
<input id="cfg-branch" type="text" value="main" />
<input id="cfg-index" type="text" value="https://www.acme.com/full-index.json" />
```

### Notes

- **Org and repo when opened via da.live.** The SDK overrides the org and repo fields with the ones from the da.live URL and locks them, so the HTML values only matter when you open the tool another way. Set them anyway so the page is correct either way.
- **Live index URL.** Use your production domain (as above) or the `.aem.live` URL, for example `https://main--acme-website--acme.aem.live/full-index.json`. If you **empty** the `cfg-index` field (`value=""`), the script fills it with `https://{branch}--{repo}--{org}.aem.live/full-index.json` automatically from the org, repo and branch fields. It only auto-fills when the field is empty or still holds its own auto-generated value, so a URL you typed is never overwritten.
- **Index name.** If your site's index is not called `full-index.json` (for example `query-index.json`), put the right file name in the Live index URL. The index must list every page, with a `path` column.
- **CORS.** The live index is fetched from the browser. Your site must allow cross-origin reads of the index JSON (EDS normally does).
- **JavaScript and CSS.** `stale-page-check.js` contains no org, repo or domain names; it reads everything from the form fields. You do not need to edit it. Its only fixed hosts are `admin.da.live`, `admin.hlx.page` and `da.live`.
- **Path in the HTML.** The HTML links to `/tools/stale-page-check/stale-page-check.css` and `.js`. If you place the folder somewhere other than `tools/stale-page-check/`, update those two paths in the HTML and use the matching da.live app URL.

## Admin token for unpublishing

Unpublishing calls `https://admin.hlx.page`, which needs to know who you are.

- **Try first:** leave the "admin.hlx.page auth token" field blank. The tool then relies on your logged-in browser session. This depends on your browser's cross-site cookie rules and may not work everywhere.
- **If you get 401 or 403:** sign in at `https://admin.hlx.page/login`, open `https://admin.hlx.page/profile`, then in DevTools go to Application > Cookies > `https://admin.hlx.page`, copy the value of the `auth_token` cookie and paste it into the field. The tool sends it as `X-Auth-Token`.
- Treat the token like a password: it can publish and unpublish as you. Do not share it, commit it or put it in screenshots. It expires, so log in again if requests start failing.
- For scripts and CI, use an Admin API key instead (see the [AEM Admin API keys documentation](https://www.aem.live/docs/admin-apikeys)).

## Safety

- The scan aborts if the live index is empty, the da.live listing is empty or fails, or no paths match. It warns in red if more than 50% of live pages look stale; that usually means a wrong org, repo or index URL.
- You must confirm every unpublish in a browser prompt. The homepage (`/`) cannot be unpublished from the manual box.
- Unpublishing cannot be undone from this tool. To bring a page back, publish it again from da.live.
- Review the list, open a few pages, and unpublish in small batches first.
- Some live pages legitimately have no da.live document (generated pages, redirects). Leave those unticked.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Amber banner, no token | Not opened via `da.live/app/{org}/{repo}/tools/stale-page-check`. Open it that way, or paste a da.live token. |
| "da.live rejected the request" (401/403) | Expired token, or no access to this org/repo. Reload through the da.live app URL. |
| Live index fetch fails | Wrong index URL, or the index is not readable cross-origin. Open the URL in a browser to check it. |
| Almost every page flagged stale | Wrong org, repo or index URL. Compare the sample paths in the log. |
| "preview/live delete failed" | Admin token missing or expired, or no publish rights. Add a fresh `auth_token`. |

## Not verified

- The unpublish and unpreview calls (`DELETE https://admin.hlx.page/preview/...` and `/live/...`) mirror what da.live does but were not checked against the Admin API reference.
- Whether the blank-token (session cookie) method works depends on your browser; use the token field if it does not.

## References

- [AEM Admin API](https://www.aem.live/docs/admin.html)
- [DA App SDK](https://github.com/adobe/da-live/wiki/DA-App-SDK)
