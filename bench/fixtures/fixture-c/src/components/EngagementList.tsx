"use client";

interface Engagement {
  id: string;
  participantName: string;
  participantTier: string;
  interaction: string;
  occurredAt: string;
}

interface EngagementListProps {
  engagements: Engagement[];
}

export function EngagementList({ engagements }: EngagementListProps) {
  if (engagements.length === 0) {
    return <p>No engagements yet.</p>;
  }

  return (
    <ul>
      {engagements.map((e) => (
        <li key={e.id}>
          <strong>{e.participantName}</strong> ({e.participantTier}) &mdash;{" "}
          {e.interaction}
          <time dateTime={e.occurredAt}>
            {new Date(e.occurredAt).toLocaleDateString()}
          </time>
        </li>
      ))}
    </ul>
  );
}
