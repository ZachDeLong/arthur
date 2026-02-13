import { prisma } from "@/lib/db";
import { ContentCard } from "@/components/ContentCard";

export default async function HomePage() {
  const recentContent = await prisma.contentItem.findMany({
    where: { visibility: true },
    include: {
      author: { select: { displayIdentifier: true, tier: true } },
      engagements: { select: { interaction: true } },
    },
    orderBy: { publishedAt: "desc" },
    take: 20,
  });

  return (
    <main>
      <h1>Recent Content</h1>
      <div>
        {recentContent.map((item) => (
          <ContentCard
            key={item.id}
            id={item.id}
            headline={item.headline}
            contentCategory={item.contentCategory}
            authorName={item.author.displayIdentifier}
            authorTier={item.author.tier}
            engagementCount={item.engagements.length}
            publishedAt={item.publishedAt.toISOString()}
          />
        ))}
      </div>
    </main>
  );
}
