import { NextResponse } from "next/server";
import { getArchivesPayload, setProjectArchived } from "@/lib/archive-store";
import { normalizeArchiveKey } from "@/lib/archive-order";
import { setPin } from "@/lib/pin-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getArchivesPayload(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/archives — body: { key: string, archived?: boolean }
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = body as { key?: unknown; archived?: unknown };
  const key = normalizeArchiveKey(payload.key);
  if (!key) {
    return NextResponse.json({ error: "key must be a non-empty string" }, { status: 400 });
  }

  try {
    let archived = typeof payload.archived === "boolean" ? payload.archived : undefined;
    if (archived === undefined) {
      archived = !getArchivesPayload().projects.includes(key);
    }
    const next = await setProjectArchived({ key, archived });
    if (archived) {
      try { await setPin({ kind: "project", key, pinned: false }); } catch { /* pin store optional */ }
    }
    return NextResponse.json(next, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
