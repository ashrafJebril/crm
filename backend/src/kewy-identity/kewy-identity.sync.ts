import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { authSource, type AuthSource } from "./auth-source";
import {
  KewyIdentityClient,
  type KewyIdentityInput,
  type KewyResult,
} from "./kewy-identity.client";

/** The crm User fields Kewy cares about. `password` is the stored bcrypt hash. */
export interface KewySyncUser {
  id: string;
  email: string;
  name: string;
  password: string | null;
}

/** Same shape the admin DTO enforces; Kewy accepts only bcrypt hashes. */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
/** Placeholder addresses the SSO bridges synthesize (hjz_…@sso.local, …). */
const PLACEHOLDER_EMAIL_RE = /@sso\.local$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * crm User → Kewy identity row. externalTenantId stays null: a crm user spans
 * many workspaces, so Kewy resolves tenants from the account's workspaces.
 * Placeholder SSO emails are not sent — they would create Kewy accounts keyed
 * on a fake address.
 */
export function toKewyIdentity(
  user: KewySyncUser,
  opts: { includeHash?: boolean } = { includeHash: true },
): KewyIdentityInput {
  const email = user.email?.trim().toLowerCase();
  const usableEmail =
    email && email.length <= 320 && EMAIL_RE.test(email) && !PLACEHOLDER_EMAIL_RE.test(email)
      ? email
      : null;
  const hash =
    opts.includeHash !== false && user.password && BCRYPT_HASH_RE.test(user.password)
      ? user.password
      : null;
  return {
    externalUserId: user.id,
    externalTenantId: null,
    email: usableEmail,
    name: user.name?.slice(0, 200) || null,
    ...(hash ? { passwordHash: hash } : {}),
  };
}

type WriteKind =
  /** Creates or changes a login credential: strict outside `local`. */
  | "password"
  /** Profile mirror / delete: best-effort in every mode. */
  | "profile";

/**
 * One place for the dual-write policy, so every caller is one line:
 *
 *  - `local`: everything is best-effort and fire-and-forget (logged, never
 *    fails or slows the request).
 *  - `kewy_with_fallback` / `kewy`: a password write is awaited and a failure
 *    fails the request — except an unreachable Kewy in `kewy_with_fallback`,
 *    which is logged and tolerated (the local hash is still written).
 *    Profile writes stay best-effort.
 *
 * Password writes are called BEFORE the local column is updated, so a strict
 * failure leaves crm unchanged. Creates pass an `undo` that removes the new
 * local row instead.
 */
@Injectable()
export class KewyIdentitySync {
  private readonly logger = new Logger(KewyIdentitySync.name);

  constructor(private readonly client: KewyIdentityClient) {}

  get mode(): AuthSource {
    return authSource();
  }

  /** A crm user was created, or an existing one just gained a password. */
  userCreated(user: KewySyncUser, undo?: () => Promise<unknown>): Promise<void> {
    return this.write(
      user.password ? "password" : "profile",
      `mirror user ${user.id}`,
      () => this.client.mirrorIdentity(toKewyIdentity(user)),
      undo,
    );
  }

  /**
   * The user changed their OWN password (they proved the current one). It
   * becomes the Kewy Account's password for every product.
   */
  passwordChanged(user: KewySyncUser, newHash: string): Promise<void> {
    return this.write("password", `set password ${user.id}`, () =>
      this.setPassword(user, newHash, "account"),
    );
  }

  /**
   * Someone else (a workspace owner/admin, an operator) set this user's
   * password. Product-scoped: it replaces the person's password in crm only, so
   * the old one stops working here, and a crm workspace owner can never reach
   * the same person's hjz / Kewy AI login.
   */
  passwordReset(user: KewySyncUser, newHash: string): Promise<void> {
    return this.write("password", `reset password ${user.id}`, () =>
      this.setPassword(user, newHash, "product"),
    );
  }

  /** Set the password, mirroring a user Kewy has not seen yet first. */
  private async setPassword(user: KewySyncUser, newHash: string, scope: "account" | "product") {
    const set = () => this.client.setPassword(user.id, { passwordHash: newHash, scope });
    const first = await set();
    if (first.kind !== "rejected" || first.code !== "IDENTITY_NOT_FOUND") return first;
    const mirrored = await this.client.mirrorIdentity(
      toKewyIdentity({ ...user, password: newHash }),
    );
    return mirrored.kind === "ok" ? set() : mirrored;
  }

  /** Email / name changed. Kewy fills gaps only; it never overwrites the Account. */
  profileChanged(user: KewySyncUser): Promise<void> {
    return this.write("profile", `update user ${user.id}`, () =>
      this.client.mirrorIdentity(toKewyIdentity(user, { includeHash: false })),
    );
  }

  /** The crm User row itself was deleted (not merely removed from a workspace). */
  userDeleted(userId: string): Promise<void> {
    return this.write("profile", `delete user ${userId}`, () =>
      this.client.deleteIdentity(userId),
    );
  }

  /** Lazy backfill after a successful local login. Never affects the login. */
  backfill(user: KewySyncUser): void {
    void this.write("profile", `backfill user ${user.id}`, () =>
      this.client.mirrorIdentity(toKewyIdentity(user)),
    );
  }

  private async write(
    kind: WriteKind,
    label: string,
    call: () => Promise<KewyResult<unknown>>,
    undo?: () => Promise<unknown>,
  ): Promise<void> {
    const mode = this.mode;
    const settle = (): Promise<KewyResult<unknown>> =>
      call().catch((err: unknown) => ({
        kind: "unreachable" as const,
        reason: err instanceof Error ? err.message : String(err),
      }));

    if (mode === "local" || kind === "profile") {
      // Nothing to do (and nothing to warn about) until Kewy is configured.
      if (mode === "local" && !this.client.configured) return;
      void settle().then((r) => {
        if (r.kind !== "ok") this.logger.warn(`Kewy IdP ${label} failed: ${describe(r)}`);
      });
      return;
    }

    const r = await settle();
    if (r.kind === "ok") return;
    if (mode === "kewy_with_fallback" && r.kind === "unreachable") {
      this.logger.warn(`Kewy IdP unreachable for ${label}; kept the local write: ${describe(r)}`);
      return;
    }
    this.logger.error(`Kewy IdP ${label} failed; failing the request: ${describe(r)}`);
    if (undo) {
      await undo().catch((err: unknown) =>
        this.logger.error(`Undo after failed ${label} also failed: ${String(err)}`),
      );
    }
    throw r.kind === "unreachable"
      ? new ServiceUnavailableException(
          "The login service is temporarily unavailable. Please try again shortly.",
        )
      : new BadGatewayException("The login service rejected this change. Please try again.");
  }
}

function describe(r: Exclude<KewyResult<unknown>, { kind: "ok" }>): string {
  return r.kind === "unreachable" ? `unreachable (${r.reason})` : `${r.status} ${r.code}`;
}
