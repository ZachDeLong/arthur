import { prisma } from "@/lib/db";
import { ContentCard } from "@/components/ContentCard";

export default async function ContentListPage() {
  const content = await prisma.contentItem.findMany({
    include: {
      author: { select: { displayIdentifier: true, tier: true } },
      engagements: { select: { interaction: true } },
    },
    orderBy: { publishedAt: "desc" },
  });

  const categories = await prisma.contentItem.groupBy({
    by: ["contentCategory"],
    _count: true,
  });

  return (
    <main>
      <h1>All Content</h1>
      <aside>
        <h2>Categories</h2>
        <ul>
          {categories.map((cat) => (
            <li key={cat.contentCategory}>
              {cat.contentCategory} ({cat._count})
            </li>
          ))}
        </ul>
      </aside>
      <div>
        {content.map((item) => (
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
