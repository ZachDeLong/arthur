"use client";

interface ContentCardProps {
  id: string;
  headline: string;
  contentCategory: string;
  authorName: string;
  authorTier: string;
  engagementCount: number;
  publishedAt: string;
}

export function ContentCard({
  id,
  headline,
  contentCategory,
  authorName,
  authorTier,
  engagementCount,
  publishedAt,
}: ContentCardProps) {
  return (
    <a href={`/content/${id}`}>
      <div>
        <h3>{headline}</h3>
        <span>{contentCategory}</span>
        <p>
          {authorName} ({authorTier})
        </p>
        <footer>
          <span>{engagementCount} engagements</span>
          <time dateTime={publishedAt}>
            {new Date(publishedAt).toLocaleDateString()}
          </time>
        </footer>
      </div>
    </a>
  );
}
