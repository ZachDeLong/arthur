import { prisma } from "@/lib/db";
import { ParticipantBadge } from "@/components/ParticipantBadge";

export default async function ParticipantsPage() {
  const participants = await prisma.participant.findMany({
    include: {
      _count: {
        select: {
          authoredContent: true,
          engagements: true,
        },
      },
    },
    orderBy: { enrolledAt: "desc" },
  });

  return (
    <main>
      <h1>Participants</h1>
      <div>
        {participants.map((p) => (
          <ParticipantBadge
            key={p.id}
            displayIdentifier={p.displayIdentifier}
            tier={p.tier}
            contentCount={p._count.authoredContent}
            engagementCount={p._count.engagements}
            enrolledAt={p.enrolledAt.toISOString()}
          />
        ))}
      </div>
    </main>
  );
}
