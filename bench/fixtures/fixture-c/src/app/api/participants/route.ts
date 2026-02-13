import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tier = searchParams.get("tier");

  const participants = await prisma.participant.findMany({
    where: tier ? { tier: tier as any } : undefined,
    include: {
      _count: {
        select: { authoredContent: true, engagements: true },
      },
    },
    orderBy: { enrolledAt: "desc" },
  });

  return NextResponse.json(participants);
}

export async function POST(request: Request) {
  const body = await request.json();

  const participant = await prisma.participant.create({
    data: {
      displayIdentifier: body.displayIdentifier,
      contactEmail: body.contactEmail,
      tier: body.tier ?? "OBSERVER",
      bio: body.bio,
    },
  });

  return NextResponse.json(participant, { status: 201 });
}
