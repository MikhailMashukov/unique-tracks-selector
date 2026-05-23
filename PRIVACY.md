# Privacy Policy

Unique Tracks Selector is designed to do its main work locally in your browser: read visible track information from music search/listing pages, classify tracks, highlight duplicates/variants, and remember which tracks were already seen.

## Data Read From Pages

The extension may read browsing-related page data, including:

- track titles and artist names visible on supported music search/listing pages;
- the current page URL/host;
- search/listing context, such as the search query, page title, heading, or page number when needed to separate one browsing scope from another.

This information can be considered user data because it comes from pages you visit.

## Data Stored Locally

The extension stores this data locally in browser storage:

- seen tracks and their normalized forms;
- detected duplicate/variant information;
- extension settings;
- temporary per-tab state.

This local data is used only to remember which tracks were already seen, detect duplicates/variants, and keep the extension state.

## Analytics

The extension includes basic analytics for popup usage events.

Analytics currently sends these events:

- `popup_opened`;
- `enable_clicked` / `disable_clicked`;
- `source_selector_clicked`;
- `scope_edit_started`.

The analytics code creates a random `install_id` in popup local storage and sends it as PostHog `distinct_id` so repeated events from the same installation can be counted together.

For `enable_clicked` / `disable_clicked`, the current implementation also sends the browser tab id. The tab id is an internal browser number, not the page URL or title.

Track titles, artist names, search queries, page titles, page URLs, and the saved seen-track database are not intentionally sent by these analytics events.

## Data Sharing

- No ads.
- No remote code loading.
- No local page or track data is sold, rented, shared, or used for advertising.
- No collected page, URL, or track database data is intentionally sent to my server or to any third-party server by the extension, except for the basic PostHog popup analytics described above.

If this project is hosted on GitHub, GitHub may show me basic repository traffic statistics, such as views or downloads. That is separate from the extension itself and does not give the extension access to your browsing data.

## Browser Permissions

Current browser permissions:

- `storage`: stores seen tracks, settings, and temporary page state locally in the browser.
- `tabs`: reads the active tab URL and communicates with the active tab so the popup can enable and update highlighting.
- `scripting`: injects the extension scripts into already-open pages when needed.
- `<all_urls>` host permission: lets the extension work on different music search/listing sites instead of being limited to one hard-coded domain.

Apart from the PostHog popup analytics described above, I did not find network request code in the extension package.
