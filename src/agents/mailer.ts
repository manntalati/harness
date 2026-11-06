import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Mail account for external email agents: SMTP to send, IMAP to read replies
 * and to check the Sent folder before any re-send. Works with Gmail out of the
 * box (with an app password) and with any provider that allows SMTP/IMAP logins.
 *
 * Two ways to configure it, environment first:
 *   HARNESS_MAIL_USER           address to send from and read replies in
 *   HARNESS_MAIL_APP_PASSWORD   app password for that account
 *   HARNESS_MAIL_FROM_NAME      optional display name
 *   HARNESS_MAIL_SMTP_HOST / _SMTP_PORT / _IMAP_HOST / _IMAP_PORT   non-Gmail providers
 *   HARNESS_MAIL_REQUIRE_AUTH   "0" to skip the sender-authentication check on replies
 * or Settings → Email in the UI, which tests the login and saves it to
 * <HARNESS_HOME>/mail.json (owner-only permissions). Never in world.json or the repo.
 */
export interface OutgoingMail { to: string; subject: string; body: string }
export interface IncomingMail { messageId: string; from: string; subject: string; text: string; date: string; authenticated: boolean }
export interface MailTransport {
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Recent messages from one sender whose subject contains `subjectHint`. */
  fetchReplies(fromAddress: string, subjectHint: string, since: Date): Promise<IncomingMail[]>;
  /** Message-ID of a sent message whose subject contains `subjectTag`, if one is in the Sent folder. */
  findSent?(subjectTag: string, since: Date): Promise<string | null>;
}

export interface MailSettings {
  user: string;
  pass: string;
  fromName?: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface MailStatus {
  configured: boolean;
  source?: "env" | "saved";
  user?: string;
  smtpHost?: string;
  imapHost?: string;
}

/** Thrown when the provider rejects the login: retrying won't help until the settings change. */
export class MailAuthError extends Error {}

let override: MailTransport | null | undefined;
/** Test hook. Pass null to force the manual flow, undefined to restore normal detection. */
export function setMailTransport(t: MailTransport | null | undefined): void {
  override = t;
  version++;
}

let home: string | null = null;
let saved: MailSettings | null = null;
let version = 0;
let cached: { key: string; transport: MailTransport } | null = null;

/** Bumped whenever the account changes, so sends that failed on a bad login get retried. */
export function mailVersion(): number {
  return version;
}

const mailFile = () => (home ? join(home, "mail.json") : null);

/** Loads the account saved from the UI, if any. */
export async function initMail(harnessHome: string): Promise<void> {
  home = harnessHome;
  const file = mailFile()!;
  if (!existsSync(file)) return;
  try {
    saved = normalize(JSON.parse(await readFile(file, "utf8")) as Partial<MailSettings>);
    version++;
  } catch (err) {
    process.stderr.write(`[harness] couldn't read ${file}: ${String(err)}\n`);
  }
}

/** Default servers by address; Gmail unless told otherwise. */
export function defaultServers(user: string): Pick<MailSettings, "smtpHost" | "smtpPort" | "imapHost" | "imapPort"> {
  const domain = user.split("@")[1]?.toLowerCase() ?? "";
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) {
    return { smtpHost: "smtp-mail.outlook.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993 };
  }
  if (/^(icloud|me|mac)\.com$/.test(domain)) return { smtpHost: "smtp.mail.me.com", smtpPort: 587, imapHost: "imap.mail.me.com", imapPort: 993 };
  if (/^(yahoo|ymail)\.[a-z.]+$/.test(domain)) return { smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, imapHost: "imap.mail.yahoo.com", imapPort: 993 };
  if (domain === "fastmail.com") return { smtpHost: "smtp.fastmail.com", smtpPort: 465, imapHost: "imap.fastmail.com", imapPort: 993 };
  return { smtpHost: "smtp.gmail.com", smtpPort: 465, imapHost: "imap.gmail.com", imapPort: 993 };
}

function normalize(input: Partial<MailSettings>): MailSettings {
  const user = String(input.user ?? "").trim();
  const pass = String(input.pass ?? "").replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) throw new Error("Enter the full email address to send from");
  if (!pass) throw new Error("Enter the app password for that account");
  const d = defaultServers(user);
  return {
    user,
    pass,
    fromName: input.fromName?.trim() || undefined,
    smtpHost: input.smtpHost?.trim() || d.smtpHost,
    smtpPort: Number(input.smtpPort) || d.smtpPort,
    imapHost: input.imapHost?.trim() || d.imapHost,
    imapPort: Number(input.imapPort) || d.imapPort,
  };
}

function fromEnv(): MailSettings | null {
  const user = process.env.HARNESS_MAIL_USER?.trim();
  const pass = process.env.HARNESS_MAIL_APP_PASSWORD;
  if (!user || !pass?.trim()) return null;
  return normalize({
    user,
    pass,
    fromName: process.env.HARNESS_MAIL_FROM_NAME,
    smtpHost: process.env.HARNESS_MAIL_SMTP_HOST,
    smtpPort: Number(process.env.HARNESS_MAIL_SMTP_PORT) || undefined,
    imapHost: process.env.HARNESS_MAIL_IMAP_HOST,
    imapPort: Number(process.env.HARNESS_MAIL_IMAP_PORT) || undefined,
  });
}

function currentSettings(): { settings: MailSettings; source: "env" | "saved" } | null {
  try {
    const env = fromEnv();
    if (env) return { settings: env, source: "env" };
  } catch {
    // fall through to the saved account
  }
  return saved ? { settings: saved, source: "saved" } : null;
}

export function mailStatus(): MailStatus {
  if (override) return { configured: true, source: "env", user: "test" };
  const current = currentSettings();
  if (!current) return { configured: false };
  const { settings, source } = current;
  return { configured: true, source, user: settings.user, smtpHost: settings.smtpHost, imapHost: settings.imapHost };
}

export function getMailTransport(): MailTransport | null {
  if (override !== undefined) return override;
  const current = currentSettings();
  if (!current) return null;
  const s = current.settings;
  const key = JSON.stringify(s);
  if (cached?.key !== key) cached = { key, transport: mailTransport(s, process.env.HARNESS_MAIL_REQUIRE_AUTH !== "0") };
  return cached.transport;
}

/** Tests the login (SMTP and IMAP) and, if it works, saves it for future runs. */
export async function connectMail(input: Partial<MailSettings>): Promise<MailStatus> {
  if (!home) throw new Error("The harness home folder isn't set up yet");
  const settings = normalize(input);
  await verify(settings);
  const file = mailFile()!;
  await mkdir(home, { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 1), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  saved = settings;
  version++;
  return mailStatus();
}

export async function disconnectMail(): Promise<MailStatus> {
  const file = mailFile();
  if (file) await rm(file, { force: true });
  saved = null;
  version++;
  return mailStatus();
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

function isAuthFailure(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number; authenticationFailed?: boolean; message?: string };
  return e?.code === "EAUTH" || e?.responseCode === 535 || e?.responseCode === 534 || e?.authenticationFailed === true || /invalid credentials|authentication failed|username and password not accepted/i.test(e?.message ?? "");
}

function describe(err: unknown): string {
  const e = err as { message?: string; response?: string; responseText?: string };
  return (e?.responseText || e?.response || e?.message || String(err)).toString().slice(0, 300);
}

async function smtpTransport(s: MailSettings) {
  const { createTransport } = await import("nodemailer");
  // 465 is implicit TLS; 587 upgrades with STARTTLS.
  return createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, requireTLS: s.smtpPort !== 465, auth: { user: s.user, pass: s.pass } });
}

async function withImap<T>(s: MailSettings, fn: (client: import("imapflow").ImapFlow) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: s.imapHost, port: s.imapPort, secure: true, auth: { user: s.user, pass: s.pass }, logger: false });
  try {
    await client.connect();
  } catch (err) {
    if (isAuthFailure(err)) throw new MailAuthError(`The mail server rejected the login for ${s.user} (${describe(err)})`);
    throw err;
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** The folder with every message (Gmail's All Mail) if there is one, so replies a filter archived still count. */
async function searchFolder(client: import("imapflow").ImapFlow, use: "\\All" | "\\Sent"): Promise<string | null> {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === use)?.path ?? null;
}

async function verify(s: MailSettings): Promise<void> {
  const smtp = await smtpTransport(s);
  try {
    await smtp.verify();
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new Error(`${s.smtpHost} rejected the login. For Gmail, use an app password (myaccount.google.com/apppasswords, needs 2-step verification), not your normal password. (${describe(err)})`);
    }
    throw new Error(`Couldn't reach ${s.smtpHost}:${s.smtpPort} to send mail: ${describe(err)}`);
  } finally {
    smtp.close();
  }
  try {
    await withImap(s, async (client) => {
      await client.mailboxOpen("INBOX", { readOnly: true });
    });
  } catch (err) {
    if (err instanceof MailAuthError) throw new Error(`${err.message}. Sending works, but replies can't be read. For Gmail, also turn on IMAP in Gmail settings.`);
    throw new Error(`Couldn't open your mailbox on ${s.imapHost} to read replies: ${describe(err)}`);
  }
}

function mailTransport(s: MailSettings, requireAuth: boolean): MailTransport {
  return {
    async send(mail) {
      const smtp = await smtpTransport(s);
      try {
        const info = await smtp.sendMail({ from: s.fromName ? { name: s.fromName, address: s.user } : s.user, to: mail.to, subject: mail.subject, text: mail.body });
        return { messageId: String(info.messageId) };
      } catch (err) {
        if (isAuthFailure(err)) throw new MailAuthError(`The mail server rejected the login for ${s.user} (${describe(err)})`);
        throw new Error(describe(err));
      } finally {
        smtp.close();
      }
    },

    async fetchReplies(fromAddress, subjectHint, since) {
      const { simpleParser } = await import("mailparser");
      return withImap(s, async (client) => {
        const found: IncomingMail[] = [];
        const folder = (await searchFolder(client, "\\All")) ?? "INBOX";
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const uids = (await client.search({ since, from: fromAddress, subject: subjectHint }, { uid: true })) || [];
          for (const uid of uids.slice(-40)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const auth = String(parsed.headers.get("authentication-results") ?? "");
            const domain = fromAddress.split("@")[1]?.toLowerCase() ?? "";
            const authenticated = !requireAuth || /dmarc=pass/i.test(auth) || (/dkim=pass/i.test(auth) && auth.toLowerCase().includes(domain));
            found.push({
              messageId: String(parsed.messageId ?? `uid-${uid}`),
              from: (parsed.from?.value[0]?.address ?? "").toLowerCase(),
              subject: parsed.subject ?? "",
              text: parsed.text ?? "",
              date: (parsed.date ?? new Date()).toISOString(),
              authenticated,
            });
          }
        } finally {
          lock.release();
        }
        return found;
      });
    },

    async findSent(subjectTag, since) {
      return withImap(s, async (client) => {
        const folder = await searchFolder(client, "\\Sent");
        if (!folder) return null;
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const uids = (await client.search({ since, subject: subjectTag }, { uid: true })) || [];
          const last = uids[uids.length - 1];
          if (last === undefined) return null;
          const msg = await client.fetchOne(String(last), { envelope: true }, { uid: true });
          return (msg && msg.envelope?.messageId) || `sent-uid-${last}`;
        } finally {
          lock.release();
        }
      });
    },
  };
}
