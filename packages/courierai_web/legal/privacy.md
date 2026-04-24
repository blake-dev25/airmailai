# Privacy Policy

**Last updated:** April 24, 2026

## The short version

CourierAI is a browser-based client for third-party Large Language Model
(LLM) APIs. You bring your own API keys, and the app lets you chat with
the providers you choose (Anthropic, OpenAI, Google, and others).

**We do not operate a backend. We do not see your chats. We do not see
your API keys.** Your API keys and chat history live in your browser
storage. Your messages go from your browser — by way of the CourierAI
extension, which handles the HTTPS request on the browser's behalf —
directly to the LLM provider you selected, using the API key you
provided. No intermediate server operated by us is involved.

The only personal data we touch is your IP address, which our CDN
(Amazon CloudFront) necessarily processes in transit to route requests,
and data which appears in aggregate analytics (country, browser, OS mix)
that CloudFront provides. We don't retain per-request logs. Details
below.

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
provides us with aggregate analytics in its console — for example, the
mix of browsers, operating systems, and countries across all visitors —
retained for a rolling 60 days. These reports do not contain
per-request data or identify individual users.

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

The following data lives only in your own browser storage and is not
sent to any server operated by us:

| Data | Storage location |
|---|---|
| API keys | `chrome.storage.sync` (synced by your Google account across browsers) |
| Chat history | IndexedDB (local to each browser profile) |
| Theme, model, and UI preferences | `chrome.storage.sync` |

You can delete any of this at any time by uninstalling the extension or
clearing the extension's storage through your browser.

**Note on `chrome.storage.sync`:** data placed in `chrome.storage.sync`
is synchronized by Google across browsers where you are signed into the
same Google account. This sync is provided by Google and governed by
Google's privacy policy. We do not receive or see this data.

## Third-party LLM providers

When you send a message, it is transmitted from your browser to the LLM
provider whose API key you configured. That provider receives your
messages and returns responses. Each provider has its own privacy
practices, which apply to the content you send them. Providers currently
supported include, among others:

- Anthropic - <https://www.anthropic.com/legal/privacy>
- OpenAI - <https://openai.com/policies/privacy-policy>
- Google (Gemini API) - <https://policies.google.com/privacy>

We encourage you to review the policy of each provider whose API you use
through CourierAI. We do not act as an intermediary, processor, or
controller of this content.

## Cookies and tracking

We do not use cookies. We do not use web analytics. We do not use
tracking pixels, fingerprinting, or advertising identifiers.

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

Your API keys are stored using the browser's extension storage APIs,
which isolate them from web pages — only the CourierAI extension can
read them from your browser. They are transmitted only to the LLM
provider you choose, over HTTPS.

You should treat any API key as a sensitive credential. If you suspect
a key has been compromised, revoke it in the provider's dashboard.

## Changes

If this policy changes, the updated version will be published at the
same URL with a new "Last updated" date. Material changes will also be
surfaced in the website itself the next time you open it, so you
don't have to check this page to find out.

## Contact

Questions about this policy: blake@courierai.net
