import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { Observable, Subscription } from "rxjs";
import { workspaceContext } from "./workspace-context";
import type { JwtPayload } from "../auth/auth.guard";

/**
 * Runs every authenticated request inside an AsyncLocalStorage scope that
 * carries the active workspaceId + userId. Services and Prisma middleware
 * can read this context without explicitly passing it through every call.
 * Skipped when the JWT has no workspaceId (e.g. user with multiple workspaces
 * still on the "pick one" step).
 */
@Injectable()
export class WorkspaceInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const wsId = req.user?.workspaceId;
    const userId = req.user?.sub;
    if (wsId && userId) {
      return new Observable((subscriber) => {
        let innerSub: Subscription | undefined;
        workspaceContext.run({ workspaceId: wsId, userId }, () => {
          innerSub = next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e) => subscriber.error(e),
            complete: () => subscriber.complete(),
          });
        });
        // Teardown: when the outer subscriber unsubscribes (client disconnect,
        // SSE/WS cancel), tear down the inner subscription too — otherwise the
        // handler keeps running and we leak resources.
        return () => innerSub?.unsubscribe();
      });
    }
    return next.handle();
  }
}
