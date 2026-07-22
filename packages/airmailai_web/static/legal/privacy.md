# Privacy Policy

**Last updated:** July 20, 2026

## The short version

AirmailAI is a browser-based client for third-party artificial
intelligence APIs. You supply your own API keys. AirmailAI stores those
keys and your chats in browser storage and sends requests directly from
the extension to the provider you select. Blake Dev LLC does not
operate an application backend that receives your API keys, prompts,
chat history, files, or model responses.

This does not mean that no one processes data when you use AirmailAI.
The provider you select receives the data needed to provide its
features. Your browser vendor may process synchronized settings. Amazon
CloudFront processes website request data to deliver the site. Blake
Dev LLC also receives information you choose to send through support
email or public project channels. This Policy explains each of those
flows.

## Who we are and the scope of this Policy

AirmailAI is operated by Blake Dev LLC. This Policy applies to the
AirmailAI website, browser extension, and support communications.

Contact: contact@blake-dev.net

Third-party AI providers, browser vendors, extension stores, GitHub,
and other third-party services have their own privacy policies. Their
processing is not governed by this Policy.

## Data stored in your browser

The following data is stored in your browser rather than on an
application server operated by Blake Dev LLC:

| Data | Storage location |
|---|---|
| API keys | `chrome.storage.local` |
| Chat history, attachments, system prompts, token counts, and provider file or container identifiers | IndexedDB |
| Provider, model, appearance, feature, and other settings, including the accepted legal-document version | `chrome.storage.sync` |
| Downloaded provider model-catalog data | Browser storage |
| Theme, message-font, and branding-visibility preference caches | Website `localStorage` under `airmailai-theme`, `airmailai-message-font`, and `airmailai-show-branding` |

API keys are stored in local, non-synchronized extension storage.
Information in `chrome.storage.sync` may be synchronized through your
browser account when browser sync is enabled. That synchronization is
operated by your browser vendor under its own privacy policy. Blake Dev
LLC does not receive synchronized data through AirmailAI.

## Data sent to AI and feature providers

When you use AirmailAI, the extension sends data directly to the
third-party provider you select. Depending on the provider, model,
settings, and features you use, that data may include:

- Your API key
- Prompts, system prompts, and relevant conversation history
- Files, images, file metadata, and provider file or container
  identifiers
- Tool definitions, tool inputs and results, search queries, and URLs
- Model responses and other information needed to continue a
  conversation or feature

The provider processes this data under the agreement and privacy terms
associated with your account and API key. Providers may retain
requests, responses, files, or other data, use subprocessors, or
process data in other countries. Their practices vary by service,
account type, configuration, and feature.

Some provider features can store uploaded files or create code
execution containers on provider systems. Deleting a local chat,
clearing AirmailAI's browser storage, or uninstalling the extension
does not necessarily delete those provider-side copies. When a
provider offers deletion controls, delete provider-side data before
removing the API key AirmailAI would need to request that deletion.

If you use OpenRouter, OpenRouter may route a request to a downstream
model operator and may use other partners for features such as file
parsing, web search, or URL retrieval. The privacy and retention
practices of the services involved in that route apply in addition to
OpenRouter's terms and settings.

Blake Dev LLC has no way to receive the content described in this
section through the Service itself. The only way we can receive it is
if you choose to send it to us yourself, for example by email.

## Website delivery through Amazon CloudFront

The AirmailAI website is delivered through Amazon CloudFront. To serve
and secure a request, CloudFront necessarily processes request metadata
such as an IP address, timestamp, requested path, user agent, and
approximate geographic information derived from the request.

Blake Dev LLC does not enable CloudFront standard access logs or
real-time logs for AirmailAI and therefore does not receive or retain
per-request CloudFront log records through those features. CloudFront
provides aggregate viewer reports, such as country, browser, and
operating-system distributions, for a rolling 60-day period. Blake Dev
LLC uses those aggregate reports only to deliver, maintain, secure, and
understand the general operation of the site, not for advertising or
cross-site tracking.

For people in the EEA or UK, the legal basis for this processing is our
legitimate interest in delivering, securing, and maintaining the
Service. You may object to processing based on legitimate interests by
contacting us. CloudFront operates a global network, so request data
may be processed outside your country. Amazon Web Services offers
contractual transfer safeguards, including the European Commission's
Standard Contractual Clauses and the UK International Data Transfer
Addendum, where applicable.

Amazon Web Services acts as a service provider that processes this data
to provide CloudFront. Its own privacy notice also applies to its
operations.

## Communications and public project channels

If you contact Blake Dev LLC, we receive the information you choose to
provide. This may include your email address, name, message, attachments,
and ordinary message metadata. If you submit or participate in a
GitHub issue, discussion, or other public project channel, we receive
the account information and content displayed through that service,
and the content may be public.

We use communications data to respond to you, provide support, address
security or legal matters, enforce our terms, and improve AirmailAI.
For people in the EEA or UK, the legal basis is performance of or steps
toward a contract when the communication concerns the Service, our
legitimate interests in supporting and securing AirmailAI, or compliance
with a legal obligation, as applicable.

Our email and project-hosting providers process communications on our
behalf or under their own terms. They may process data in countries
other than your own. We retain communications for as long as reasonably
needed to respond, resolve the matter, maintain security or legal
records, enforce our agreements, and preserve any request not to be
contacted. Public project content may remain available according to the
hosting service's controls and policies.

Please do not send sensitive information that is not needed for your
request.

## Browser vendors and extension stores

Your browser vendor may process synchronized settings and information
related to installing, updating, or using extensions. An extension
store may provide Blake Dev LLC with aggregate listing or installation
statistics. Those services are governed by their own terms and privacy
policies.

AirmailAI's use and transfer of information received from Chrome APIs
complies with the Chrome Web Store User Data Policy, including the
Limited Use requirements.

## What Blake Dev LLC does not operate or use

AirmailAI does not provide user accounts, payment processing,
an application backend, client-side analytics, advertising, tracking
pixels, or fingerprinting. Blake Dev LLC does not sell personal
information or share personal information for cross-context behavioral
advertising.

We do not use browser cookies. The three functional website
`localStorage` preference caches listed above are not cookies and are
not used to track you across sites. Unlike cookies, they are never
transmitted with network requests; they exist only in your browser.

## Legal disclosures

We may preserve or disclose information that Blake Dev LLC actually
possesses if we reasonably believe doing so is necessary to comply with
law, legal process, or a valid government request; protect the rights,
property, or safety of users, Blake Dev LLC, or others; investigate
fraud, abuse, or security incidents; or enforce our agreements.

Because Blake Dev LLC does not receive your API keys or chat content
through the Service, it generally cannot disclose content it does not
possess. Third-party providers and browser vendors may separately
receive legal demands for data they hold.

## Children

AirmailAI is intended only for people who are at least 18 years old. We
do not knowingly collect personal information from anyone under 18. If
you believe a person under 18 has provided personal information to
Blake Dev LLC, contact us so we can review and, where appropriate,
delete it.

## Your privacy rights

### Browser and provider data

You directly control most AirmailAI data because it is stored in your
browser. Use AirmailAI's "Delete all local storage" control before
uninstalling to clear extension storage, IndexedDB, synchronized
settings, and the website preference caches described above. You can
also use your browser's extension and site-data controls.

Uninstalling the extension may not remove the website's `localStorage`
or data held by an AI provider, browser-sync service, email provider,
or project-hosting service. Manage provider-side data through the
provider's controls where available.

### EEA and UK

If EEA or UK data-protection law applies, you may have rights to request
access, correction, deletion, restriction, or portability of personal
data Blake Dev LLC holds, and to object to processing based on
legitimate interests. You may also withdraw consent where consent is
the basis for processing and lodge a complaint with your local
supervisory authority.

Blake Dev LLC does not use personal data it receives to make decisions
based solely on automated processing that produce legal or similarly
significant effects, and it does not perform profiling with that data.

### California

To the extent California privacy law applies to Blake Dev LLC or a
particular request, California residents may have rights to know,
access, correct, or delete covered personal information and to receive
information about its collection and disclosure. Blake Dev LLC does
not sell personal information or share it for cross-context behavioral
advertising and has not done so during the preceding 12 months. We will
not discriminate against you for exercising an applicable privacy
right.

To exercise a right that applies to information held by Blake Dev LLC,
email contact@blake-dev.net. We may need information sufficient to
verify the request and may retain a record of the request as required
or permitted by law. For data held only by a third party, direct the
request to that party.

## Security

AirmailAI uses browser-managed storage for local data and HTTPS for
network requests. API keys are placed in non-synchronized extension
storage and are sent to the provider selected for a request, not to an
AirmailAI application backend.

No storage or transmission method is completely secure. Protect access
to your browser profile and device, use provider keys with appropriate
limits where available, and revoke a key through the provider if you
suspect it has been exposed.

## Changes to this Policy

We may update this Policy as AirmailAI, providers, or legal requirements
change. We will post the revised Policy with a new "Last updated" date.
When the legal-document version changes, AirmailAI will require you to
review the updated documents before continuing to use the application.

## Contact

For privacy questions or requests, email contact@blake-dev.net.
