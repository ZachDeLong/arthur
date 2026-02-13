import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const authorId = searchParams.get("authorId");

  const content = await prisma.contentItem.findMany({
    where: {
      ...(category ? { contentCategory: category } : {}),
      ...(authorId ? { authorId } : {}),
      visibility: true,
    },
    include: {
      author: { select: { displayIdentifier: true, tier: true } },
      engagements: {
        select: { interaction: true, occurredAt: true },
      },
    },
    orderBy: { publishedAt: "desc" },
  });

  return NextResponse.json(content);
}

export async function POST(request: Request) {
  const body = await request.json();

  const item = await prisma.contentItem.create({
    data: {
      headline: body.headline,
      body: body.body,
      contentCategory: body.contentCategory,
      authorId: body.authorId,
      visibility: body.visibility ?? true,
    },
    include: {
      author: { select: { displayIdentifier: true } },
    },
  });

  return NextResponse.json(item, { status: 201 });
}
