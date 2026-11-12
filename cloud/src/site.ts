/**
 * The public pages the App Store requires (privacy policy, terms and support), served by the same Worker as
 * the relay so there is nothing else to host. Plain HTML, no scripts, no cookies, no analytics.
 */

// Published on the support and privacy pages; the App Store needs a reachable contact.
const SUPPORT_EMAIL = "medenov.azamat.t@gmail.com";
const UPDATED = "2 November 2026";
const TERMS_UPDATED = "3 November 2026";

const PAGES: Record<string, { title: string; body: string }> = {
  "/": {
    title: "Relay",
    body: `
<h1>Relay</h1>
<p class="lead">Answer Claude Code from your phone. When a session on your Mac asks a question, wants a plan
approved or needs permission to run something, Relay shows it on your iPhone. Tap an answer and the session
carries on.</p>
<p>Relay is made by an independent developer and isn't affiliated with Anthropic. Claude and Claude Code are
Anthropic's trademarks.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a> · <a href="/support">Support</a></p>`,
  },
  "/terms": {
    title: "Terms of use · Relay",
    body: `
<h1>Terms of use</h1>
<p class="muted">Last updated ${TERMS_UPDATED}</p>
<p class="lead">These terms cover the Relay apps for iPhone and Android, the Relay helper for macOS and Linux, and
the relay server. By using any of them you agree to these terms.</p>

<h2>Who makes Relay</h2>
<p>Relay is made by Azamat Medenov, an independent developer. It isn't made, endorsed or supported by Anthropic.
Claude and Claude Code are Anthropic's trademarks, used here only to say what Relay works with.</p>

<h2>What you need</h2>
<p>Relay works with Claude Code that you install and sign in to yourself, on a computer you own or control. Relay
doesn't sell, include or pay for any Claude usage, and it never asks for or handles your Claude login. Your use
of Claude Code, including what it costs and its limits, stays under your own agreement with Anthropic.</p>

<h2>You stay in charge of your computer</h2>
<p>When you answer a question, approve a plan, allow a command or send a message from your phone, Claude Code acts
on it on your computer exactly as if you had done it there. You're responsible for what you approve. Read a
request before you allow it, and don't pair a phone you don't control. If a phone is lost, revoke it with
<code>relay devices revoke</code>.</p>

<h2>Fair use</h2>
<p>Don't use Relay to break the law or anyone's rights, to get into computers you aren't allowed to use, or to
overload, probe or work around the limits of the relay server. We may block a computer or phone that does.</p>

<h2>Subscriptions</h2>
<p>Relay Pro is sold through the App Store. Apple handles payment, the free trial, renewal, cancellation and
refunds under its own terms. A subscription renews automatically until you cancel it, at least 24 hours before
the end of the current period, in Settings on the iPhone (tap your name, then Subscriptions). For apps from the
App Store, Apple's <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">Licensed
Application End User License Agreement</a> also applies. If it conflicts with these terms, Apple's agreement
wins on matters between you and Apple.</p>

<h2>The relay server</h2>
<p>The relay is offered as it is, without a promise that it will always be available. It may be down for
maintenance or change without notice. If it's down, nothing on your computer is lost; the phone reconnects
when it's back.</p>

<h2>Software licence</h2>
<p>You may install and use the Relay apps and helper on devices you own or control. You may not sell,
sublicense or redistribute them, or reverse engineer them except where the law allows.</p>

<h2>No warranty</h2>
<p>Relay is provided "as is". To the extent the law allows, we make no warranties and aren't liable for indirect
or consequential damage, lost data or lost profits from using it, or for anything Claude Code does on your
computer. Nothing in these terms limits rights you have under law that can't be waived, for example as a
consumer in the EU.</p>

<h2>Changes and contact</h2>
<p>If these terms change, this page and the date at the top will change with it. Questions:
<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/support">Support</a></p>`,
  },
  "/privacy": {
    title: "Privacy policy · Relay",
    body: `
<h1>Privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p class="lead">Relay connects your iPhone to your own Mac. There's no Relay account and no analytics, and the
messages between your phone and your Mac are encrypted so that only those two devices can read them.</p>

<h2>Your Mac</h2>
<p>The Relay helper keeps a local database in <code>~/.relay</code>: session names, recent questions and your
answers, short summaries of Claude's replies, and a log of paired phones. It removes keys, tokens and passwords it
recognises from summaries and notifications. <code>relay uninstall</code> stops the helper; deleting
<code>~/.relay</code> removes the data.</p>

<h2>Your iPhone</h2>
<p>The app stores the key it got when you paired (in the Keychain), your Mac's address, your settings and a copy of
recent sessions so it can show them offline. The copy isn't included in backups. Unpairing deletes all of it and
also cancels the key on your Mac.</p>

<h2>The relay server</h2>
<p>If your phone and Mac aren't on the same private network, they talk through a relay we run on Cloudflare
Workers. The relay passes encrypted data along and can't decrypt it. It does see a random ID for your Mac, IP
addresses, when connections open and close, and how much data goes through. It doesn't store any of the content.
Cloudflare keeps short-lived request logs; see <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's
privacy policy</a>.</p>

<h2>Notifications</h2>
<p>While you're away from your Mac, Relay sends notifications through Apple's push service. A notification holds a
short text, for example the session name and the question, with secrets removed, plus IDs so its buttons work.
See <a href="https://www.apple.com/legal/privacy/">Apple's privacy policy</a>.</p>

<h2>Subscriptions</h2>
<p>Apple handles the subscription. We don't see your name, Apple ID or payment details.</p>

<h2>Claude Code</h2>
<p>Your answers and messages go into Claude Code on your Mac, which sends them to Anthropic like anything else you
type into it. That's covered by your agreement with Anthropic.</p>

<h2>Children</h2>
<p>Relay is a tool for software developers and isn't meant for children under 13.</p>

<h2>Questions and requests</h2>
<p>Since the data lives on your own devices, you can see and delete it yourself as described above. For anything
else, including requests under the GDPR or CCPA, write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>Changes</h2>
<p>If this policy changes, this page and the date at the top will change with it.</p>`,
  },
  "/support": {
    title: "Support · Relay",
    body: `
<h1>Support</h1>
<p class="lead">Something not working, or an idea? Write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.
Include your macOS or Linux version, your Claude Code version and the output of <code>relay doctor</code> if it's
about the computer side.</p>

<h2>Setting up</h2>
<ol>
<li>On your Mac or Linux machine (including WSL), run
<code>curl -fsSL https://raw.githubusercontent.com/netchuu/homebrew-tap/main/install.sh | sh</code>, or with
Homebrew <code>brew install netchuu/tap/relay &amp;&amp; relay pair</code>.</li>
<li>Scan the code it shows with the Relay app.</li>
<li>On a Linux server, also run <code>sudo loginctl enable-linger $USER</code> so the helper keeps running after
you log out, and start Claude Code inside tmux.</li>
<li>Use Claude Code as usual. Questions, plans and permission requests appear on your phone.</li>
</ol>

<h2>Common problems</h2>
<h3>"Can't reach your Mac"</h3>
<p>The computer is asleep or offline, or the helper isn't running. Run <code>relay doctor</code> on it.</p>
<h3>No notifications</h3>
<p>Relay only notifies you when you're away from the Mac: it's been idle for two minutes, the screen is locked,
or you set yourself to Away in the app. Also check Settings → Notifications → Relay on the iPhone.</p>
<h3>My reply shows up as a message "from another session"</h3>
<p>In iTerm2 and tmux, Relay types your reply into the session as if you'd typed it. Other terminals only accept it
through Claude Code's session inbox, which labels it that way. On Linux, run Claude Code inside tmux.</p>
<h3>I lost my phone</h3>
<p>On the Mac, run <code>relay devices</code> to find it, then <code>relay devices revoke &lt;id&gt;</code>.</p>

<h2>Subscription</h2>
<p>Relay Pro is free for the first week, then renews monthly or yearly until you cancel. To cancel, open Settings
on the iPhone, tap your name, then Subscriptions. Apple handles refunds at
<a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a>.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></p>`,
  },
};

const STYLE = `
:root { color-scheme: light dark; --bg: #FAF9F5; --text: #1A1918; --muted: #5E5A53; --accent: #B4532A; --card: #F0EEE6; }
@media (prefers-color-scheme: dark) { :root { --bg: #242322; --text: #F7F5F0; --muted: #ADA99F; --accent: #EF9068; --card: #2F2D2B; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 48px 16px 64px; }
h1 { font-family: ui-serif, Georgia, serif; font-weight: 600; font-size: 2.2rem; line-height: 1.2; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 2em 0 0.5em; }
h3 { font-size: 1rem; margin: 1.4em 0 0.2em; }
.lead { font-size: 1.1rem; }
.muted { color: var(--muted); margin-top: 0; }
a { color: var(--accent); }
code { background: var(--card); padding: 1px 6px; border-radius: 6px; font-size: 0.9em; }
li { margin: 0.4em 0; }
`;

export function sitePage(pathname: string): Response | null {
  const page = PAGES[pathname.replace(/\/+$/, "") || "/"];
  if (!page) return null;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title}</title>
<style>${STYLE}</style></head><body><main>${page.body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "public, max-age=300",
    },
  });
}
