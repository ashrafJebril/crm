/**
 * SP-10 advisory-lock keys (Architecture → Writes, Delete with references).
 * Every writer that books against a service or resource, and the catalog
 * deletes, take these inside their transaction, so a booking created
 * concurrently with an archive is either counted (archive) or refused
 * (`bookings.service_archived`).
 *
 * Lock order (to avoid deadlocks): service first, then resource. The catalog
 * deletes take only their own key.
 */
import type { Prisma } from "@prisma/client";

export const serviceLockKey = (serviceId: string) => `booking-service:${serviceId}`;
export const resourceLockKey = (resourceId: string) => `booking-resource:${resourceId}`;

type RawTx = Pick<Prisma.TransactionClient, "$executeRaw">;

/** `pg_advisory_xact_lock` on one key; released at commit/rollback. */
export async function lockKey(tx: RawTx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export const lockService = (tx: RawTx, serviceId: string) => lockKey(tx, serviceLockKey(serviceId));
export const lockResource = (tx: RawTx, resourceId: string) => lockKey(tx, resourceLockKey(resourceId));
