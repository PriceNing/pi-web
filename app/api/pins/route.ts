import { NextResponse } from "next/server";
import { getPinsPayload, setPin } from "@/lib/pin-store";
import { normalizePinKey, normalizePinKind } from "@/lib/pin-order";

export const dynamic = "force-dynamic";

// GET /api/pins — the authoritative pin sets (shared by every device).
export async function GET() {
  try {
    return NextResponse.json(getPinsPayload(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/pins — body: { kind: "session" | "project", key: string, pinned?: boolean }
// Omitting `pinned` toggles the current value. The response always carries the
// full pin sets so the client can drop any optimistic guess it was holding.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = body as { kind?: unknown; key?: unknown; pinned?: unknown };
  const kind = normalizePinKind(payload.kind);
  if (!kind) {
    return NextResponse.json({ error: 'kind must be "session" or "project"' }, { status: 400 });
  }
  const key = normalizePinKey(payload.key);
  if (!key) {
    return NextResponse.json({ error: "key must be a non-empty string" }, { status: 400 });
  }

  try {
    let pinned = typeof payload.pinned === "boolean" ? payload.pinned : undefined;
    if (pinned === undefined) {
      const current = getPinsPayload();
      pinned = !(kind === "session" ? current.sessions : current.projects).includes(key);
    }
    const next = await setPin({ kind, key, pinned });
    return NextResponse.json(next, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
