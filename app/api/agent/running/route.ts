import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
// [pin-fork] Pins ride the existing lightweight poll so every open tab (and
// every device) converges on the server state without a dedicated request.
import { getPinsPayload } from "@/lib/pin-store";
import { getArchivesPayload } from "@/lib/archive-store";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      pins: getPinsPayload(),
      archives: getArchivesPayload(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
