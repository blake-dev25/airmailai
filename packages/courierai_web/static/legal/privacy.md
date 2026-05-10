# Privacy Policy

**Last updated:** May 10, 2026

## The short version

CourierAI is a browser-based client for third-party Large Language Model
(LLM) APIs. You bring your own API keys, and the app lets you chat with
the providers you choose.

**We do not operate a backend. We do not see your chats. We do not see
your API keys.** Your API keys and chat history live in your browser
storage. Your messages go from your browser - by way of the CourierAI
extension, which handles the HTTPS request on the browser's behalf -
directly to the LLM provider you selected, using the API key you
provided. No intermediate server operated by us is involved.

The only personal data we touch is your IP address, which our CDN
(Amazon CloudFront) necessarily processes in transit to route requests,
and data which appears in aggregate analytics (country, browser, OS mix)
that CloudFront provides. We do not enable or retain per-request CDN
logs. Details below.

## Who we are

CourierAI is currently an independent project. If operations are
transferred to a legal entity (LLC) in the future, this policy will be
updated to reflect that, including any applicable governing law.

Contact: blake@courierai.net

## What we collect

### What we don't collect

We do not collect, store, sell, or share any chat content, prompts,
completions, API keys, or usage analytics on any server that we control.
We do not run a backend that sees your traffic to LLM providers.

### CloudFront

The website is served via Amazon CloudFront, a content delivery network.
We do not enable CloudFront access logging or real-time logs, so no
per-request records (IP address, user agent, URL, etc.) are retained by
us.

CloudFront does process your IP address in transit in order to route
requests, as any CDN or web server necessarily does. CloudFront also
provides us with aggregate analytics in its console - for example, the
mix of browsers, operating systems, and countries across all visitors -
retained for a rolling 60 days. These reports are aggregate viewer
reports, not per-request logging. They do not contain per-request data
or identify individual users.

Under GDPR, an IP address is considered personal data, so although our
processing is minimal, we want to be specific about it:

- **Legal basis (GDPR Art. 6(1)(f)):** legitimate interest in delivering
  the site and defending it against abuse.
- **International transfers:** CloudFront operates a global edge
  network, so requests may be processed in regions outside your own.
  AWS relies on Standard Contractual Clauses for transfers out of the
  EEA/UK.
- **Use:** the aggregate analytics are never used to build user
  profiles, for tracking, or for advertising. We do not correlate them
  with any other identifier, because we hold no other identifier.
- **No automated decision-making:** we do not subject you to any
  automated decision-making or profiling under GDPR Art. 22.

### Chrome extension permissions

The CourierAI browser extension requests only the permissions required
to function. These are declared in the extension's manifest and visible
at install time. The extension does not transmit data to any server
operated by us.

## What lives in your browser

The following user data lives only in your own browser storage and is
not sent to any server operated by us:

| Data | Storage location |
|---|---|
| API keys | `chrome.storage.local` for use by the extension; optional backup copy in `chrome.storage.sync` if you enable API-key sync |
| Chat history, attachments, system prompts, and token counts | IndexedDB (local to each browser profile) |
| Theme, model, and UI preferences | `chrome.storage.sync` |
| Theme preference (paint-time cache, so the correct background renders before the extension finishes loading) | Website `localStorage` (key: `courierai-theme`) — kept in sync with, and overwritten by, the canonical value from `chrome.storage.sync` |

You can delete any of this at any time by uninstalling the extension or
clearing the extension's storage through your browser.

**Note on browser sync:** data placed in `chrome.storage.sync` may be
synchronized by your browser account across browsers where you are
signed in and have sync enabled. The sync provider depends on your
browser and account setup. Browser sync is provided by your browser
vendor and governed by its privacy policy. We do not receive or see
this data.

## Third-party LLM providers

Some third-party providers offer model catalogs. After you add an API
key for a provider with a model catalog, CourierAI may use that key to
download the provider's catalog directly from the provider and cache it
in your browser.

When you send a message, it is transmitted from your browser to the LLM
provider whose API key you configured. That provider receives your
messages and returns responses. Each provider has its own privacy
practices, which apply to the content you send them. We encourage you to
review the policy of each provider whose API you use through CourierAI.
We do not act as an intermediary, processor, or controller of this
content.

## Cookies and tracking

We do not use cookies, with one exception: a single `localStorage` key
(`courierai-theme`) that the website stores in your browser to render
the correct theme background before the extension finishes loading.
This is a functional preference cache, not a tracking mechanism. We do
not use client-side web analytics, tracking pixels, fingerprinting, or
advertising identifiers. We do not enable per-request CDN access logs
or real-time logs. The only CDN metrics we receive are the aggregate
CloudFront viewer reports described above.

## Children

CourierAI is not intended for use by anyone under 13, or under the
minimum age for digital consent in your jurisdiction (which, in parts of
the EU and UK, may be as high as 16). We do not knowingly collect
information from children.

## Your rights

### For everyone

Because we do not hold personal information about you beyond the
in-transit processing described above, there is typically nothing for us
to export, correct, or delete on your request. Data held in your
browser can be managed directly by you, by uninstalling the extension
or clearing its storage.

If you believe we hold data about you and wish to make a request,
contact us at the email above.

### EU / UK (GDPR)

If the GDPR or UK GDPR applies to you, you have the right to:

- Access the personal data we hold about you
- Request rectification of inaccurate data
- Request erasure
- Request restriction of processing
- Object to processing carried out under legitimate interest
- Data portability
- Lodge a complaint with your national supervisory authority (for
  example, the ICO in the UK, or your country's data protection
  authority in the EU)

### California (CCPA / CPRA)

If you are a California resident, you have the right to know what
categories of personal information we collect, to request deletion, to
request correction, and to opt out of the sale or sharing of personal
information. The only category of personal information we process is
**identifiers**, specifically the IP address that CloudFront handles in
transit to serve the site, as described above. We do not retain this
information in logs.

**We do not sell or share personal information**, and we have not done
so in the preceding 12 months. There is accordingly no "Do Not Sell or
Share My Personal Information" mechanism to offer, because there is
nothing to opt out of.

You will not be discriminated against for exercising any of these
rights.

## Security

Your API keys stay in browser-managed extension storage, not on servers
operated by us. By default, they remain only in the browser profile
where you saved them. If you enable API-key sync, your browser may keep
a synced copy through your browser account so other signed-in browsers
can restore it. When you make a request, the relevant key is sent over
HTTPS only to the provider you chose.

You should treat any API key as a sensitive credential. If you suspect
a key has been compromised, revoke it in the provider's dashboard.

## Changes

If this policy changes, the updated version will be published at the
same URL with a new "Last updated" date. Material changes will also be
surfaced in the website itself the next time you open it, so you
don't have to check this page to find out.

## Contact

Questions about this policy: blake@courierai.net
