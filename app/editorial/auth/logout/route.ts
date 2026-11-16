import type { NextRequest } from "next/server";
import { handleEditorialAuthPost } from "@/lib/editorial-auth/handlers";

export function POST(request: NextRequest) { return handleEditorialAuthPost(request, "logout"); }
