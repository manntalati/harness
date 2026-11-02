/**
 * Gmail transport for the external email agent. Uses SMTP to send and IMAP to
 * read replies, both with a Gmail app password taken from the environment.
 * Credentials are never stored in world.json or the repo.
 *
 *   HARNESS_MAIL_USER           Gmail address to send from and read replies in
 *   HARNESS_MAIL_APP_PASSWORD   Google app password for that account
 *   HARNESS_MAIL_FROM_NAME      optional display name
 *   HARNESS_MAIL_REQUIRE_AUTH   "0" to skip the sender-authentication check
 */
export interface OutgoingMail { to: string; subject: string; body: string }
export interface IncomingMail { messageId: string; from: string; subject: string; text: string; date: string; authenticated: boolean }
export interface MailTransport {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Recent messages from one sender whose subject contains `subjectHint`. */
  fetchReplies(fromAddress: string, subjectHint: string, since: Date): Promise<IncomingMail[]>;
}

let override: MailTransport | null | undefined;
/** Test hook. Pass null to force the manual flow, undefined to restore env detection. */
export function setMailTransport(t: MailTransport | null | undefined): void { override = t; }

export function getMailTransport(): MailTransport | null {
  if (override !== undefined) return override;
  const user = process.env.HARNESS_MAIL_USER?.trim();
  const pass = process.env.HARNESS_MAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  return gmailTransport(user, pass, process.env.HARNESS_MAIL_FROM_NAME?.trim(), process.env.HARNESS_MAIL_REQUIRE_AUTH !== "0");
}

/** Drops quoted history and signature noise so only the new reply text is recorded. */
export function extractReply(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From:\s.+@/.test(line) && out.length) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function gmailTransport(user: string, pass: string, name: string | undefined, requireAuth: boolean): MailTransport {
  return {
    async send(mail) {
      const { createTransport } = await import("nodemailer");
      const smtp = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
      try {
        const info = await smtp.sendMail({ from: name ? { name, address: user } : user, to: mail.to, subject: mail.subject, text: mail.body });
        return { messageId: String(info.messageId) };
      } finally { smtp.close(); }
    },
    async fetchReplies(fromAddress, subjectHint, since) {
      const { ImapFlow } = await import("imapflow");
      const { simpleParser } = await import("mailparser");
      const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
      const found: IncomingMail[] = [];
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = (await client.search({ since, from: fromAddress, subject: subjectHint }, { uid: true })) || [];
          for (const uid of uids.slice(-20)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const auth = String(parsed.headers.get("authentication-results") ?? "");
            const domain = fromAddress.split("@")[1]?.toLowerCase() ?? "";
            const authenticated = !requireAuth || (/dmarc=pass/i.test(auth) || (/dkim=pass/i.test(auth) && auth.toLowerCase().includes(domain)));
            found.push({
              messageId: String(parsed.messageId ?? `uid-${uid}`),
              from: (parsed.from?.value[0]?.address ?? "").toLowerCase(),
              subject: parsed.subject ?? "", text: parsed.text ?? "",
              date: (parsed.date ?? new Date()).toISOString(), authenticated,
            });
          }
        } finally { lock.release(); }
      } finally { await client.logout().catch(() => {}); }
      return found;
    },
  };
}
