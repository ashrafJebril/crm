import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import { isEffectiveOwner } from "../permissions/member-role";
import { memberError } from "./member-errors";

type MemberDb = Pick<PrismaService, "workspaceMember">;

/** Member row of THIS workspace (explicit post-check: never trust a row that
 *  came back for another workspace), or 404 `members.not_found`. */
export async function findWorkspaceMember(db: MemberDb, workspaceId: string, userId: string) {
  const m = await db.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { roleRef: true },
  });
  if (!m || m.workspaceId !== workspaceId) throw memberError("members.not_found");
  return m;
}

/** The workspace must keep at least one member whose effective role is owner. */
export async function assertAnotherOwner(db: MemberDb, workspaceId: string, exceptMemberId: string): Promise<void> {
  const others = await db.workspaceMember.findMany({
    where: { workspaceId, id: { not: exceptMemberId } },
    include: { roleRef: true },
  });
  if (!others.filter((o) => o.workspaceId === workspaceId).some((o) => isEffectiveOwner(o))) {
    throw new BadRequestException("A workspace must keep at least one owner");
  }
}

/** Maps a Postgres serialization failure (Prisma P2034) to a retryable 409. */
export async function serializable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: string })?.code === "P2034") {
      throw new ConflictException("Another change happened at the same time — try again");
    }
    throw e;
  }
}
