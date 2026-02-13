import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { EngagementList } from "@/components/EngagementList";

export default async function ContentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const item = await prisma.contentItem.findUnique({
    where: { id: params.id },
    include: {
      author: {
        select: { displayIdentifier: true, tier: true, contactEmail: true },
      },
      engagements: {
        include: {
          participant: {
            select: { displayIdentifier: true, tier: true },
          },
        },
        orderBy: { occurredAt: "desc" },
      },
    },
  });

  if (!item) return notFound();

  return (
    <main>
      <article>
        <h1>{item.headline}</h1>
        <p>
          By {item.author.displayIdentifier} | {item.contentCategory} |
          Published {item.publishedAt.toLocaleDateString()}
        </p>
        <div>{item.body}</div>
      </article>

      <section>
        <h2>Engagements ({item.engagements.length})</h2>
        <EngagementList
          engagements={item.engagements.map((e) => ({
            id: e.id,
            participantName: e.participant.displayIdentifier,
            participantTier: e.participant.tier,
            interaction: e.interaction,
            occurredAt: e.occurredAt.toISOString(),
          }))}
        />
      </section>
    </main>
  );
}
