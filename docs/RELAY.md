# How Relay connects

Your phone reaches your computer from anywhere, without a VPN or an open port. Both sides connect out to the
relay, a small Cloudflare Worker (`cloud/`), and everything between them is end-to-end encrypted: the relay
passes messages along but can't read them.

```
iPhone ──► relay (one room per computer) ◄── helper on your computer
   └──────────── end-to-end encrypted ────────────┘
```

## Pairing

`relay pair` shows a QR code. It holds your computer's id and its public key, and a one-time pairing code that
expires after a few minutes. When the phone scans it, the two sides make their keys and the computer remembers
the phone. The computer's private key never leaves it, and the phone's never leaves the phone.

## Encryption

Each time the phone connects, it and the computer agree on fresh keys (X25519 key exchange, with the
computer's long-term key from the QR code and new keys for every connection, then HKDF-SHA256). Every message is
encrypted with AES-256-GCM. Only your computer can complete the exchange, so nobody in between, the relay
included, can read or change a message or pretend to be your computer. Because every connection uses new keys,
recording traffic today doesn't help anyone read it later. The code is in `mac/src/daemon/e2e.ts`, and the
message formats in `protocol/`.

## Notifications

When Claude Code asks something while the phone is closed, the helper encrypts the notification's text for that
phone and asks the relay to deliver it through Apple. Apple shows "New activity on your Mac" and hands the
encrypted part to the app, which opens it on the phone and shows the real text.

## What each service can see

- **The relay (Cloudflare):** which rooms connect and when, IP addresses and message sizes. Never what you or
  Claude wrote: prompts, answers and pairing codes are inside the encryption. It stores no messages.
- **Apple:** the phone's notification token, the kind of notification (so its buttons work), which session it
  belongs to, and the encrypted text it can't open.
- **Nobody else:** the helper has no accounts and no analytics.
